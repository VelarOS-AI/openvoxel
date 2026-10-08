import assert from "node:assert/strict";
import test from "node:test";
import {voxelPipelineReady} from "../src/backends/babylon/native/voxel-pipeline-warmup.mjs";

function fixture() {
  const jobs = [], masks = [], requests = [];
  let refreshes = 0;
  const cache = {preWarmPipeline(_fill, _effect, _samples, mask) {
    masks.push(mask); return new Promise((resolve, reject) => jobs.push({resolve, reject}));
  }};
  const engine = {isWebGPU: true, _device: {}, _cacheRenderPipeline: cache,
    scenes: [{textures: [{resetRefreshCounter: () => refreshes++}]}],
    createRenderPipelineAsync(options) { requests.push(...options); return options.map(o => cache.preWarmPipeline(o.fillMode, o.effect, o.sampleCount, 0)); }};
  const material = {backFaceCulling: true, fillMode: 0, needAlphaBlendingForMesh: () => false};
  const mesh = {geometry: {}};
  const effect = {_pipelineContext: {shaderProcessingContext: {textureNames: ["reflectionSampler", "shadowTexture0", "depthTexture0"], availableTextures: {shadowTexture0: {sampleType: "depth"}, depthTexture0: {sampleType: "float"}}}}};
  return {engine, material, mesh, effect, jobs, masks, requests, cache, refreshed: () => refreshes};
}

test("voxel native compilation gates readiness once per shader context and restores the cache method", async () => {
  const f = fixture(), original = f.cache.preWarmPipeline;
  const ready = () => voxelPipelineReady(f.engine, f.material, f.mesh, f.effect);
  assert.equal(ready(), false); assert.equal(ready(), false);
  assert.equal(f.jobs.length, 4);
  assert.deepEqual(f.masks, [2, 2, 2, 2]);
  assert.equal(f.cache.preWarmPipeline, original);
  for (const job of f.jobs) job.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready(), true);
  assert.equal(f.refreshed(), 1);
  assert.equal(f.jobs.length, 4);
});

test("shadow preparation uses the shadow target, winding and depth-sampling layout", () => {
  const f = fixture();
  assert.equal(voxelPipelineReady(f.engine, f.material, f.mesh, f.effect, true), false);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.masks, [0, 0]);
  assert.equal(f.requests[0].colorFormat, "rgba16float");
  assert.equal(f.requests[0].frontFace, 1);
  assert.equal(f.requests[0].depthWrite, true);
  assert.equal(f.requests[0].writeMask, 0);
  assert.equal(f.requests[1].writeMask, 15);
});

test("compilation failures reach readiness and a retired device cannot publish completion", async () => {
  const f = fixture(), error = new Error("native compilation failed");
  voxelPipelineReady(f.engine, f.material, f.mesh, f.effect);
  f.jobs[0].reject(error);
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => voxelPipelineReady(f.engine, f.material, f.mesh, f.effect), value => value === error);
  const old = fixture();
  voxelPipelineReady(old.engine, old.material, old.mesh, old.effect);
  old.engine._device = {};
  for (const job of old.jobs) job.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(old.refreshed(), 0);
});
