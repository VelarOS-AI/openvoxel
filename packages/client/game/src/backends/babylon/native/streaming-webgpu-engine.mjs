import {WebGPUEngine} from "@babylonjs/core/Engines/webgpuEngine.js";
import {WebGPUCacheBindGroups} from "@babylonjs/core/Engines/WebGPU/webgpuCacheBindGroups.js";
import {ShaderCompiler} from "./shader-compiler.mjs";
import {createStreamingEffect} from "./shader-preparation.mjs";
import {StreamingPipelineContext} from "./streaming-pipeline-context.mjs";
import {PassUniformBuffer} from "./pass-uniform-buffer.mjs";

// Babylon 9.23 exposes asynchronous pipeline preparation, but its GLSL-to-WGSL
// conversion runs synchronously. Keep the extension inside this pinned backend.
export class StreamingWebGPUEngine extends WebGPUEngine {
  createEffect(...args) { return createStreamingEffect(this, ...args); }
  createPipelineContext(context) { return new StreamingPipelineContext(context, this); }
  releaseRenderPassId(id) {
    for (const buffer of this._uniformBuffers) {
      if (buffer instanceof PassUniformBuffer) buffer.releasePass(id);
    }
    super.releaseRenderPassId(id);
  }
  constructor(canvas, options) {
    super(canvas, options);
    try {
      this.shaderCompiler = new ShaderCompiler(new URL("/generated/webgpu/shader-compiler.js", canvas.ownerDocument.baseURI));
    } catch (error) {
      super.dispose();
      throw error;
    }
    this.discardedPipelines = new WeakSet();
    this.onDisposeObservable.addOnce(() => this.shaderCompiler.dispose());
  }

  async _restoreEngineAfterContextLost(initEngine) {
    // Babylon 9.23's shared restore path invokes the WebGPU async initializer
    // without awaiting it. Rebuild resources only after the new device exists.
    const depth = this._depthCullingState;
    const state = [depth.depthTest, depth.depthFunc, depth.depthMask, this._stencilState.stencilTest];
    await initEngine();
    if (this.isDisposed) return;
    [depth.depthTest, depth.depthFunc, depth.depthMask, this._stencilState.stencilTest] = state;
    super._restoreEngineAfterContextLost(() => {});
    // The base restore resets the global tree after initAsync created the new
    // cache instance; reconnect that instance to the replacement tree too.
    this._cacheRenderPipeline.reset();
  }

  _rebuildBuffers() {
    // The pinned WebGPU implementation rebuilds uniforms/storage, but omits
    // the scene geometry rebuild performed by the WebGL engine.
    for (const scene of [...this.scenes, ...this._virtualScenes]) {
      scene.resetCachedMaterial();
      scene._rebuildGeometries();
    }
    super._rebuildBuffers();
  }

  createRawCubeTexture(...args) {
    const texture = super.createRawCubeTexture(...args);
    // Raw cubes must participate in the same restore/disposal cache as arrays.
    if (!this._internalTexturesCache.includes(texture)) this._internalTexturesCache.push(texture);
    return texture;
  }

  async _preparePipelineContextAsync(context, vertex, fragment, raw, rawVertex, rawFragment, rebuild, defines, varyings, key, onReady) {
    if (context.shaderProcessingContext.shaderLanguage !== 0) {
      return super._preparePipelineContextAsync(context, vertex, fragment, raw, rawVertex, rawFragment, rebuild, defines, varyings, key, onReady);
    }
    context.sources = {vertex, fragment, rawVertex, rawFragment};
    const device = this._device;
    try {
      this.onBeforeShaderCompilationObservable.notifyObservers(this);
      const compiled = await this.shaderCompiler.request({type: "compile", vertex, fragment, raw, defines});
      if (device !== this._device || this.isDisposed || this.discardedPipelines.has(context)) return;
      context.stages = this._createPipelineStageDescriptor(compiled.vertex, compiled.fragment, 1, false, false);
      this.onAfterShaderCompilationObservable.notifyObservers(this);
      onReady();
    } catch (error) {
      if (device !== this._device || this.isDisposed || this.discardedPipelines.has(context)) return;
      // Complete Babylon's normal error/fallback path instead of leaving an
      // asynchronously failed material permanently pending and invisible.
      const effect = Object.values(this._compiledEffects).find(candidate => candidate._pipelineContext === context);
      if (effect) effect._processCompilationErrors(error);
      else throw error;
    }
  }

  _deletePipelineContext(context) {
    if (context) this.discardedPipelines.add(context);
    super._deletePipelineContext(context);
  }

  createRawTexture2DArray(data, width, height, depth, format, generateMipMaps, invertY, samplingMode, compression = null, type = 0, flags = 0, mipLevelCount) {
    // The pinned allocator otherwise ignores authored mip count on device restore.
    // Allocate all levels without data, then upload under the requested policy.
    const texture = super.createRawTexture2DArray(null, width, height, depth, format,
      generateMipMaps || mipLevelCount > 1, invertY, samplingMode, compression, type, flags, mipLevelCount);
    texture.generateMipMaps = generateMipMaps;
    this.updateRawTexture2DArray(texture, data, format, invertY, compression, type);
    return texture;
  }

  updateRawTexture2DArray(texture, data, format, invertY, compression = null, type = 0, mipLevel) {
    const base = texture._bufferView;
    super.updateRawTexture2DArray(texture, data, format, invertY, compression, type, mipLevel);
    // Babylon replays _bufferView as level zero after a device loss.
    if (mipLevel > 0) texture._bufferView = base;
  }

  endFrame() {
    super.endFrame();
    // Babylon's global lookup retains retired chunks' bind groups indefinitely.
    // Live draw contexts keep their own groups/bundles across this lookup reset.
    if (WebGPUCacheBindGroups.NumBindGroupsCreatedTotal >= 4096) WebGPUCacheBindGroups.ResetCache();
  }
}
