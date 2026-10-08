// Diagnostic-only browser instrumentation. Install before creating the device;
// production rendering never imports or executes these wrappers.
export function instrumentWebGPU() {
  if (!globalThis.GPUDevice) return;
  let counts = {}, timings = {}, pipelines = [], buffers = {}, uploads = {}, textures = {}, epoch = performance.now();
  const shaders = new WeakMap();
  const bufferKinds = new WeakMap();
  let shaderId = 0;
  function increment(key, amount = 1) { counts[key] = (counts[key] ?? 0) + amount; }
  function wrap(type, method, details) {
    const original = type?.prototype?.[method];
    if (!original) return;
    type.prototype[method] = function(...args) {
      increment(method);
      const started = details ? performance.now() : 0;
      const result = Reflect.apply(original, this, args);
      if (details) {
        timings[method] = (timings[method] ?? 0) + performance.now() - started;
        details(args, result, started);
      }
      return result;
    };
  }
  wrap(GPUDevice, "createShaderModule", (args, result) => shaders.set(result, ++shaderId));
  for (const method of ["createRenderPipeline", "createRenderPipelineAsync"]) wrap(GPUDevice, method, ([descriptor], result, started) => {
    const entry = {time: started - epoch, method, duration: performance.now() - started, label: descriptor.label,
      vertex: shaders.get(descriptor.vertex.module), fragment: shaders.get(descriptor.fragment?.module),
      primitive: descriptor.primitive, depth: descriptor.depthStencil, samples: descriptor.multisample, targets: descriptor.fragment?.targets};
    pipelines.push(entry);
    if (method.endsWith("Async")) result.then(() => { entry.readyMs = performance.now() - started; }, error => { entry.error = String(error); });
  });
  function bufferKind(label) { return (label ?? "unlabelled").replace(/BabylonWebGPUDevice\d+_DataBufferUniqueId=\d+-/, "").replace(/:mesh:\d+/g, ":mesh").replace(/Geometry_[0-9a-f-]+_/, "Geometry_").replace(/chunk:[^_]+/, "Chunk").replace(/_UniformList:.*/, "").replace(/leftOver-pbr\+pbr.*/, "LeftOver-PBR").replace(/leftOver-.*/, "LeftOver-custom").replace(/_size\d+/, ""); }
  for (const method of ["createBindGroup", "createRenderBundleEncoder"]) wrap(GPUDevice, method);
  wrap(GPUDevice, "createTexture", ([descriptor]) => {
    const size = descriptor.size;
    const key = `${descriptor.dimension ?? "2d"}:${size.width ?? size[0]}x${size.height ?? size[1] ?? 1}x${size.depthOrArrayLayers ?? size[2] ?? 1}:${descriptor.format}`;
    textures[key] = (textures[key] ?? 0) + 1;
  });
  wrap(GPUQueue, "writeTexture", args => increment("writeTextureBytes", args[1].byteLength));
  wrap(GPUDevice, "createBuffer", ([descriptor], result) => { const key = bufferKind(descriptor.label); bufferKinds.set(result, key); buffers[key] = (buffers[key] ?? 0) + 1; });
  wrap(GPUQueue, "writeBuffer", (args) => {
    const bytes = args[4] === undefined ? (args[2].byteLength - (args[3] ?? 0) * (args[2].BYTES_PER_ELEMENT ?? 1)) : args[4] * (args[2].BYTES_PER_ELEMENT ?? 1);
    increment("writeBufferBytes", bytes);
    const key = bufferKinds.get(args[0]) ?? bufferKind(args[0].label);
    const value = uploads[key] ??= {count: 0, bytes: 0}; value.count++; value.bytes += bytes;
  });
  wrap(GPUQueue, "submit");
  wrap(GPURenderPassEncoder, "executeBundles", ([bundles]) => increment("executedBundles", bundles.length));
  globalThis.__webgpuPerformance = {
    reset() { counts = {}; timings = {}; pipelines = []; buffers = {}; uploads = {}; textures = {}; epoch = performance.now(); },
    read() { return {elapsedMs: performance.now() - epoch, counts, timings, pipelines, buffers, uploads, textures}; },
  };
}
