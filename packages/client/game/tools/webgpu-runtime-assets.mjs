import {readFile} from "node:fs/promises";

export async function webgpuRuntimeAssets() {
  const files = await Promise.all(["glslang.js", "glslang.wasm", "twgsl.js", "twgsl.wasm"].map(async name => ({
    name, bytes: await readFile(new URL("../data/webgpu/" + name, import.meta.url)),
  })));
  files.push({name: "shader-compiler.js", bytes: await readFile(new URL("../src/backends/babylon/native/shader-compiler-worker.mjs", import.meta.url))});
  return files;
}
