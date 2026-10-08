import {StreamingWebGLEngine} from "./streaming-webgl-engine.mjs";

// Choose before creating any Scene, textures or materials. The measured
// streaming default is WebGL 2; WebGPU remains an explicit selection until its
// pipeline preparation has comparable frame stability on this workload.
// The world is rendered to a single-sample postprocess target. FXAA handles
// its edges there; multisampling the final full-screen copy only allocates
// and resolves four redundant canvas samples on both backends.
export async function createRenderEngine(canvas, backend = "auto") {
  if (backend === "webgpu" && globalThis.navigator?.gpu) {
    const {StreamingWebGPUEngine} = await import("./streaming-webgpu-engine.mjs");
    if (await StreamingWebGPUEngine.IsSupportedAsync) {
      const engine = new StreamingWebGPUEngine(canvas, {antialias: false, stencil: true, audioEngine: false, setMaximumLimits: true});
      try {
        await engine.initAsync();
        await engine.shaderCompiler.request({type: "ready"});
        // Reuse WebGPU render bundles while uniforms remain dynamically updated.
        engine.compatibilityMode = false;
        return engine;
      } catch (error) {
        engine.dispose();
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  if (backend === "webgpu") throw new Error("当前浏览器或 GPU 无法使用 WebGPU，请在画面设置中选择自动或 WebGL 2。");
  return new StreamingWebGLEngine(canvas, false, {preserveDrawingBuffer: false, stencil: true, antialias: false, audioEngine: false}, false);
}
