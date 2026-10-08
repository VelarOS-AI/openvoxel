import assert from "node:assert/strict";
import test from "node:test";
import {Observable} from "@babylonjs/core/Misc/observable.js";
import {PassUniformBuffer} from "../src/backends/babylon/native/pass-uniform-buffer.mjs";
import {MeshMaterialBindings} from "../src/backends/babylon/native/mesh-material-bindings.mjs";

test("shared recipe retains independent chunk/pass values, recycles retired buffers, and releases all owners", () => {
  const released = new Set();
  const engine = {supportsUniformBuffers: true, frameId: 1, currentRenderPassId: 0,
    _uniformBuffers: [], _features: {checkUbosContentBeforeUpload: true},
    createUniformBuffer(data) { return {data: data.slice()}; },
    updateUniformBuffer(buffer, data, offset = 0) { buffer.data.set(data, offset / 4); },
    createMaterialContext() { return {textures: {}, reset() { this.textures = {}; }}; },
    _releaseBuffer(buffer) { assert.ok(!released.has(buffer)); released.add(buffer); return true; },
  };
  const template = new PassUniformBuffer(engine, "recipe");
  const material = {_uniformBuffer: template, _materialContext: {},
    getScene: () => ({getEngine: () => engine}),
    buildUniformLayout() { this._uniformBuffer.addUniform("chunk", 4); this._uniformBuffer.create(); this._uniformBufferLayoutBuilt = true; },
  };
  const budget = {count: 0};
  const bindings = new MeshMaterialBindings(material, budget);
  const mesh = () => ({onDisposeObservable: new Observable()});
  const first = mesh(), second = mesh();
  const a = bindings.select(first), b = bindings.select(second);
  assert.notEqual(a.buffer, b.buffer);
  assert.notEqual(a.context, b.context);
  assert.equal(a.buffer._uniformLocations, b.buffer._uniformLocations);
  a.buffer.updateFloat4("chunk", 11, 0, 0, 0); a.buffer.update();
  b.buffer.updateFloat4("chunk", 22, 0, 0, 0); b.buffer.update();
  const main = a.buffer.getBuffer();
  engine.currentRenderPassId = 2;
  a.buffer.updateFloat4("chunk", 33, 0, 0, 0); a.buffer.update();
  assert.equal(main.data[0], 11);
  assert.equal(b.buffer.getBuffer().data[0], 22);
  a.buffer._valueCache.openVoxelBinding = {};
  first.onDisposeObservable.notifyObservers(first);
  assert.equal(budget.count, 1);
  const replacement = mesh(), c = bindings.select(replacement);
  assert.equal(c.buffer, a.buffer);
  assert.equal(c.buffer._valueCache.openVoxelBinding, undefined);
  assert.equal(c.buffer.isSync, false);
  assert.equal(budget.count, 0);
  engine.currentRenderPassId = 0; engine.frameId++;
  c.buffer.updateFloat4("chunk", 44, 0, 0, 0); c.buffer.update();
  assert.equal(c.buffer.getBuffer(), main);
  assert.equal(main.data[0], 44);
  assert.equal(b.buffer.getBuffer().data[0], 22);
  const extras = Array.from({length: 40}, mesh);
  for (const owner of extras) bindings.select(owner);
  for (const owner of extras) bindings.release(owner);
  assert.equal(budget.count, 32);
  bindings.dispose();
  assert.equal(budget.count, 0);
  assert.equal(material._uniformBuffer, template);
  assert.equal(second.onDisposeObservable.hasObservers(), false);
  template.dispose();
  assert.equal(engine._uniformBuffers.length, 0);
});
