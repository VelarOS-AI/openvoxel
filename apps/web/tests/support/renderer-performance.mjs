import {readdir, readFile} from "node:fs/promises";
import {join} from "node:path";

// Discover shared module exports from this exact production build. Diagnostics
// attach only in the test browser; the application has no global test hook.
export async function rendererDiagnosticModules(assets) {
  const modules = {};
  for (const file of await readdir(assets)) {
    if (!file.endsWith(".js.map")) continue;
    const map = JSON.parse(await readFile(join(assets, file), "utf8"));
    if (map.sources.some(source => /\/engineStore\.(ts|js)$/u.test(source))) modules.engineStore = "/assets/" + file.slice(0, -4);
    if (map.sources.some(source => source.endsWith("/pass-uniform-buffer.mjs"))) modules.uniform = "/assets/" + file.slice(0, -4);
  }
  if (!modules.engineStore || !modules.uniform) throw new Error("Production diagnostics require source maps for shared Babylon modules");
  return modules;
}

export function enableDiagnosticTimestamps() {
  const request = globalThis.GPUAdapter?.prototype.requestDevice;
  if (!request) return;
  GPUAdapter.prototype.requestDevice = function(descriptor = {}) {
    const requiredFeatures = new Set(descriptor.requiredFeatures ?? []);
    if (this.features.has("timestamp-query")) requiredFeatures.add("timestamp-query");
    return request.call(this, {...descriptor, requiredFeatures: [...requiredFeatures]});
  };
}

export async function instrumentFrameCadence(modules) {
  const exports = await import(modules.engineStore);
  const engine = Object.values(exports).find(value => Array.isArray(value?.Instances))?.LastCreatedEngine;
  if (!engine) throw new Error("No production renderer was found");
  let intervals = [], previous = 0, started = 0, active = false;
  const observer = engine.onEndFrameObservable.add(() => {
    if (!active) return;
    const now = performance.now();
    intervals.push(now - previous); previous = now;
  });
  globalThis.__renderedFrameCadence = {
    reset() { intervals = []; previous = started = performance.now(); active = true; },
    read() {
      active = false;
      const elapsedMs = performance.now() - started;
      intervals.sort((a, b) => a - b);
      return {count: intervals.length, elapsedMs, fps: intervals.length * 1000 / elapsedMs,
        mean: intervals.reduce((a, b) => a + b, 0) / intervals.length,
        p95: intervals[Math.floor(intervals.length * .95)], p99: intervals[Math.floor(intervals.length * .99)],
        max: intervals.at(-1), over50: intervals.filter(ms => ms > 50).length};
    },
    dispose() { engine.onEndFrameObservable.remove(observer); },
  };
}

export async function instrumentRenderer(modules) {
  const exports = await import(modules.engineStore);
  const store = Object.values(exports).find(value => Array.isArray(value?.Instances));
  const engine = store?.LastCreatedEngine;
  if (!engine) throw new Error("No production renderer was found");
  let cpu = [], gpu = new Map(), uniforms = {}, started = 0, epoch = 0, firstFrame = 0;
  let active = false, drawStart = 0;
  const hasGpuTimer = !modules.cpuOnly && !!engine.getCaps().timerQuery;
  let passSums = [], startGpu = () => {}, finishGpu = () => {}, restoreGpu = () => {};
  if (engine.isWebGPU && hasGpuTimer) {
    const device = engine._device, create = device.createCommandEncoder;
    const slots = Array.from({length: 3}, () => ({busy: false,
      query: device.createQuerySet({type: "timestamp", count: 256}),
      resolve: device.createBuffer({size: 2048, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC}),
      read: device.createBuffer({size: 2048, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}),
    }));
    let recording = null;
    // Resolve after the renderer submits this frame. Resolving at endPass would
    // read the preceding submission's query values while this encoder is open.
    device.createCommandEncoder = function(...args) {
      const encoder = create.apply(this, args), begin = encoder.beginRenderPass;
      encoder.beginRenderPass = function(descriptor) {
        if (!recording || recording.count >= 128) return begin.call(this, descriptor);
        const index = recording.count++ * 2;
        return begin.call(this, {...descriptor, timestampWrites: {querySet: recording.query,
          beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1}});
      };
      return encoder;
    };
    startGpu = () => {
      recording = active && engine.frameId % 4 === 0 ? slots.find(slot => !slot.busy) ?? null : null;
      if (recording) { recording.busy = true; recording.count = 0; recording.frame = engine.frameId; }
    };
    finishGpu = () => {
      const slot = recording; recording = null;
      if (!slot) return;
      if (!slot.count) { slot.busy = false; return; }
      const encoder = create.call(device);
      encoder.resolveQuerySet(slot.query, 0, slot.count * 2, slot.resolve, 0);
      encoder.copyBufferToBuffer(slot.resolve, 0, slot.read, 0, slot.count * 16);
      device.queue.submit([encoder.finish()]);
      slot.read.mapAsync(GPUMapMode.READ).then(() => {
        const times = new BigUint64Array(slot.read.getMappedRange());
        let sum = 0, first = times[0], last = times[1];
        for (let i = 0; i < slot.count * 2; i += 2) {
          sum += Number(times[i + 1] - times[i]) / 1e6;
          if (times[i] < first) first = times[i];
          if (times[i + 1] > last) last = times[i + 1];
        }
        if (active && slot.frame >= firstFrame) { gpu.set(slot.frame, Number(last - first) / 1e6); passSums.push(sum); }
        slot.read.unmap(); slot.busy = false;
      }).catch(error => { if (!engine.isDisposed) throw error; });
    };
    restoreGpu = () => {
      device.createCommandEncoder = create;
      for (const slot of slots) { slot.query.destroy(); slot.resolve.destroy(); slot.read.destroy(); }
    };
  } else if (hasGpuTimer) {
    const gl = engine._gl, extension = engine.getCaps().timerQuery, pending = [];
    let current = null;
    startGpu = () => {
      const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT);
      for (let i = pending.length - 1; i >= 0; i--) {
        const sample = pending[i];
        if (!gl.getQueryParameter(sample.query, gl.QUERY_RESULT_AVAILABLE)) continue;
        const duration = gl.getQueryParameter(sample.query, gl.QUERY_RESULT) / 1e6;
        if (active && sample.frame >= firstFrame && !disjoint) gpu.set(sample.frame, duration);
        gl.deleteQuery(sample.query); pending.splice(i, 1);
      }
      if (active && engine.frameId % 4 === 0 && pending.length < 3) {
        current = {query: gl.createQuery(), frame: engine.frameId};
        gl.beginQuery(extension.TIME_ELAPSED_EXT, current.query);
      }
    };
    finishGpu = () => { if (current) { gl.endQuery(extension.TIME_ELAPSED_EXT); pending.push(current); current = null; } };
    restoreGpu = () => { for (const sample of pending) gl.deleteQuery(sample.query); };
  }
  const begin = engine.onBeginFrameObservable.add(() => { startGpu(); started = performance.now(); });
  const end = engine.onEndFrameObservable.add(() => { if (active) cpu.push(performance.now() - started); finishGpu(); });
  let restoreUniforms = () => {};
  if (engine.isWebGPU && modules.uniformChanges) {
    const exports = await import(modules.uniform);
    const type = Object.values(exports).find(value => value?.prototype?.savePass && value.prototype.releasePass);
    if (!type) throw new Error("No pass uniform export was found");
    const update = type.prototype.update;
    type.prototype.update = function() {
      if (active && this._needSync && this._name?.startsWith("material:")) {
        const previous = this.uploaded.get(this._buffer), words = this.words;
        if (previous) for (const [name, offset] of Object.entries(this._uniformLocations)) {
          const size = this._uniformSizes[name];
          for (let i = offset; i < offset + size; i++) if (words[i] !== previous[i]) {
            uniforms[name] = (uniforms[name] ?? 0) + 1;
            break;
          }
        }
      }
      return update.call(this);
    };
    restoreUniforms = () => { type.prototype.update = update; };
  }
  const summarize = values => {
    values.sort((a, b) => a - b);
    return {count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
      p50: values[Math.floor(values.length * .5)], p95: values[Math.floor(values.length * .95)], p99: values[Math.floor(values.length * .99)], max: values.at(-1)};
  };
  globalThis.__rendererPerformance = {
    reset() { cpu = []; gpu.clear(); passSums = []; uniforms = {}; epoch = performance.now(); firstFrame = engine.frameId; drawStart = engine._drawCalls.current; active = true; },
    read() {
      active = false;
      return {elapsedMs: performance.now() - epoch, hasGpuTimer, cpu: summarize(cpu), gpu: summarize([...gpu.values()]), gpuPassSum: summarize(passSums), uniforms,
        width: engine.getRenderWidth(), height: engine.getRenderHeight(), meshes: store.LastCreatedScene.meshes.length,
        activeMeshes: store.LastCreatedScene.getActiveMeshes().length, drawCallsPerFrame: (engine._drawCalls.current - drawStart) / cpu.length,
        materials: store.LastCreatedScene.materials.length,
        voxelRecipes: store.LastCreatedScene.materials.filter(material => material.name.startsWith("material:")).length,
        voxelBindingOwners: store.LastCreatedScene.materials.reduce((sum, material) => sum + (material.meshBindings?.owners.size ?? 0), 0),
        mainSamples: engine.isWebGPU ? engine._mainPassSampleCount : engine._gl.getParameter(engine._gl.SAMPLES),
        targets: engine._renderTargetWrapperCache.map(target => ({width: target.width, height: target.height, samples: target.samples,
          textures: (target.textures ?? []).map(texture => ({type: texture.type, format: texture.format, gpuFormat: texture._hardwareTexture?.format}))}))};
    },
    dispose() { active = false; engine.onBeginFrameObservable.remove(begin); engine.onEndFrameObservable.remove(end); restoreGpu(); restoreUniforms(); },
  };
}
