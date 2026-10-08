// Copied as a classic Worker beside the pinned compiler resources at build time.
// Shader conversion is CPU work; it must never block camera/input animation.
async function loadCompiler(name) {
  importScripts(new URL(name + ".js", self.location.href).href);
  const response = await fetch(new URL(name + ".wasm", self.location.href));
  if (!response.ok) throw new Error(`${name}.wasm: HTTP ${response.status}`);
  const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], {type: "application/wasm"}));
  try { return await self[name](url); }
  finally { URL.revokeObjectURL(url); }
}

const initialized = (async () => {
  // The Emscripten factories share a global Module, so load them sequentially.
  const glslang = await loadCompiler("glslang");
  const twgsl = await loadCompiler("twgsl");
  return {glslang, twgsl};
})();
const cache = new Map();
function compile(compilers, code, stage) {
  const key = stage + "\n" + code;
  let result = cache.get(key);
  if (result === undefined) {
    result = compilers.twgsl.convertSpirV2WGSL(compilers.glslang.compileGLSL(code, stage), code.includes("#define DISABLE_UNIFORMITY_ANALYSIS"));
    cache.set(key, result);
    if (cache.size > 64) cache.delete(cache.keys().next().value);
  }
  return result;
}
self.onmessage = async ({data}) => {
  try {
    const compilers = await initialized;
    if (data.type === "ready") { self.postMessage({id: data.id}); return; }
    const prefix = data.raw ? "" : "#version 450\n" + (data.defines ? data.defines + "\n" : "");
    self.postMessage({id: data.id, vertex: compile(compilers, prefix + data.vertex, "vertex"), fragment: compile(compilers, prefix + data.fragment, "fragment")});
  } catch (error) {
    self.postMessage({id: data.id, error: error instanceof Error ? error.message : String(error)});
  }
};
