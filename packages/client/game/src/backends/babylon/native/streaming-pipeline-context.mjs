import {WebGPUPipelineContext} from "@babylonjs/core/Engines/WebGPU/webgpuPipelineContext.js";
import {WebGPUShaderProcessor} from "@babylonjs/core/Engines/WebGPU/webgpuShaderProcessor.js";
import {PassUniformBuffer} from "./pass-uniform-buffer.mjs";

// Babylon's non-material parameters (clip plane, camera, exposure) also need
// stable pass ownership; otherwise they invalidate every cached terrain draw.
export class StreamingPipelineContext extends WebGPUPipelineContext {
  buildUniformLayout() {
    if (!this.shaderProcessingContext.leftOverUniforms.length) return;
    this.uniformBuffer?.dispose();
    this.uniformBuffer = new PassUniformBuffer(this.engine, "leftOver-" + this._name);
    for (const uniform of this.shaderProcessingContext.leftOverUniforms) {
      const type = uniform.type.replace(/^(.*?)(<.*>)?$/, "$1");
      this.uniformBuffer.addUniform(uniform.name, WebGPUShaderProcessor.UniformSizes[type], uniform.length);
      this._leftOverUniformsByName[uniform.name] = uniform.type;
    }
    this.uniformBuffer.create();
  }
}
