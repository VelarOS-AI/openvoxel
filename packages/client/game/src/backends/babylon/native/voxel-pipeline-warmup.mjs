const engines = new WeakMap();

// All voxel batches use the same fixed planar vertex layout. Native pipelines
// are shared by Effect/context and pass format, independent of chunk position.
// Keep a new material outside the draw list until its native compilation ends.
export function voxelPipelineReady(engine, material, mesh, effect, shadow = false) {
  if (!engine.isWebGPU || !mesh.geometry) return true;
  let contexts = engines.get(engine);
  if (!contexts) engines.set(engine, contexts = new WeakMap());
  const context = effect._pipelineContext;
  let entry = contexts.get(context);
  if (entry) {
    if (entry.error) throw entry.error;
    return entry.ready;
  }
  entry = {ready: false, error: null};
  contexts.set(context, entry);
  const processing = context.shaderProcessingContext;
  let textureState = 0;
  for (let i = 0; !shadow && i < processing.textureNames.length; i++) {
    const name = processing.textureNames[i];
    // Shadow comparison samplers bind depth32float. PCSS's depthTexture is
    // instead the filterable rgba16float color attachment storing linear depth.
    if (/^shadowTexture\d+$/u.test(name)) textureState |= 1 << i;
  }
  const blend = !shadow && material.needAlphaBlendingForMesh(mesh);
  const options = [];
  for (const depthStencilFormat of shadow ? ["depth32float"] : ["depth24plus-stencil8", "depth32float"]) {
    for (const writeMask of shadow ? [0, 15] : [15]) {
      for (const cullFace of !shadow && material.backFaceCulling ? [1, 2] : [1]) options.push({
        mesh, effect, colorFormat: shadow ? "rgba16float" : "rgba8unorm", depthStencilFormat, sampleCount: 1,
        alphaMode: blend ? material.alphaMode : 0, depthWrite: !blend || material.forceDepthWrite,
        writeMask,
        cullEnabled: material.backFaceCulling, cullFace, frontFace: shadow ? 1 : 2, fillMode: material.fillMode,
      });
    }
  }
  const cache = engine._cacheRenderPipeline, warm = cache.preWarmPipeline;
  let jobs;
  try {
    // Babylon's helper supplies textureState=0. Shadow depth sampling needs its
    // actual layout mask; preserve the helper's state save/restore otherwise.
    cache.preWarmPipeline = function(fillMode, effect, samples) { return warm.call(this, fillMode, effect, samples, textureState); };
    jobs = engine.createRenderPipelineAsync(options);
  } finally { cache.preWarmPipeline = warm; }
  if (!jobs.length) { entry.ready = true; return true; }
  const device = engine._device;
  Promise.all(jobs).then(() => {
    if (engine.isDisposed || engine._device !== device) return;
    entry.ready = true;
    // Refresh cached captures which queried this material while it was pending.
    for (const scene of engine.scenes) for (const texture of scene.textures) texture.resetRefreshCounter?.();
  }, error => { if (!engine.isDisposed && engine._device === device) entry.error = error; });
  return false;
}
