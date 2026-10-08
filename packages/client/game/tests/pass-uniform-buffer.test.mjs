import assert from "node:assert/strict";
import test from "node:test";
import {PassUniformBuffer} from "../src/backends/babylon/native/pass-uniform-buffer.mjs";
import {Effect} from "@babylonjs/core/Materials/effect.js";
import {WebGPUDrawContext} from "@babylonjs/core/Engines/WebGPU/webgpuDrawContext.js";

function fixture() {
  const writes = [], released = [];
  let bufferId = 0;
  const engine = {
    supportsUniformBuffers: true, frameId: 1, currentRenderPassId: 0,
    _uniformBuffers: [], _features: {checkUbosContentBeforeUpload: true, uniformBufferHardCheckMatrix: true},
    createUniformBuffer(data) { return {data: data.slice(), uniqueId: ++bufferId}; },
    updateUniformBuffer(buffer, data, offset = 0, count = data.byteLength) {
      writes.push({buffer, offset, count});
      buffer.data.set(data, offset / 4);
    },
    _releaseBuffer(buffer) { assert.ok(!released.includes(buffer), "buffer released twice"); released.push(buffer); return true; },
  };
  const buffer = new PassUniformBuffer(engine, "test");
  buffer.addUniform("color", 4);
  buffer.addUniform("camera", 4);
  buffer.addUniform("matrix", 16);
  buffer.create();
  return {buffer, engine, writes, released};
}

test("passes retain buffer identity when water/minimap alternate and only dirty bytes upload", () => {
  const {buffer, engine, writes} = fixture();
  function draw(pass, camera) {
    engine.currentRenderPassId = pass;
    buffer.updateFloat4("color", 1, 2, 3, 4);
    buffer.updateFloat4("camera", camera, 500, 0, 0);
    buffer.update();
    return buffer.getBuffer();
  }
  const main = draw(0, 0.1), water = draw(1, 0.1), map = draw(2, 2);
  assert.notEqual(main, water);
  assert.notEqual(main, map);
  const initialWrites = writes.length;
  for (let frame = 2; frame <= 8; frame++) {
    engine.frameId = frame;
    if (frame % 2 === 0) assert.equal(draw(1, 0.1), water);
    assert.equal(draw(0, 0.1), main);
    if (frame % 3 === 0) assert.equal(draw(2, 2), map);
  }
  assert.equal(writes.length, initialWrites, "static material must not upload each frame");
  engine.frameId++;
  engine.currentRenderPassId = 0;
  buffer.updateFloat4("color", 1, 9, 3, 4);
  buffer.update();
  assert.deepEqual({offset: writes.at(-1).offset, count: writes.at(-1).count}, {offset: 4, count: 4});
  assert.equal(main.data[1], 9);
  assert.equal(map.data[1], 2, "other pass must retain its data");
  buffer.dispose();
});

test("different draws within one pass preserve encoded values and reuse copy-on-write slots next frame", () => {
  const {buffer, engine} = fixture();
  buffer.updateFloat4("color", 1, 0, 0, 0);
  buffer.update();
  const first = buffer.getBuffer();
  buffer.updateFloat4("color", 2, 0, 0, 0);
  buffer.update();
  const second = buffer.getBuffer();
  assert.notEqual(first, second);
  assert.equal(first.data[0], 1);
  assert.equal(second.data[0], 2);
  engine.frameId++;
  buffer.updateFloat4("color", 1, 0, 0, 0);
  buffer.update();
  assert.equal(buffer.getBuffer(), first);
  buffer.updateFloat4("color", 2, 0, 0, 0);
  buffer.update();
  assert.equal(buffer.getBuffer(), second);
  buffer.dispose();
});

test("retiring a render target and device restore discard all pass bindings without leaking or double release", () => {
  const {buffer, engine, released} = fixture();
  for (let pass = 0; pass < 3; pass++) {
    engine.currentRenderPassId = pass;
    buffer.updateFloat("camera", pass);
    buffer.update();
  }
  buffer.releasePass(1);
  buffer.releasePass(1);
  assert.equal(released.length, 1);
  assert.equal(buffer.uploaded.size, 2);
  buffer.releasePass(2);
  assert.equal(released.length, 2);
  assert.equal(buffer.uploaded.size, 1);
  engine.currentRenderPassId = 0;
  buffer.updateFloat("camera", 10);
  buffer.update();
  buffer._rebuildAfterContextLost();
  assert.equal(buffer.passStates.size, 0);
  buffer.updateFloat("camera", 20);
  buffer.update();
  assert.equal(buffer.getBuffer().data[4], 20);
  buffer.dispose();
  assert.equal(buffer.uploaded.size, 0);
  assert.equal(engine._uniformBuffers.length, 0);
});

test("stable WebGPU draw bindings skip redundant calls but rebinding follows real context and buffer ownership", () => {
  const {buffer, engine} = fixture();
  engine.isWebGPU = true;
  const first = new WebGPUDrawContext({}, null), second = new WebGPUDrawContext({}, null);
  engine._currentDrawContext = first;
  let binds = 0;
  engine.bindUniformBufferBase = (data, _slot, name) => {
    binds++;
    engine._currentDrawContext.setBuffer(name, data);
  };
  const effect = Object.assign(Object.create(Effect.prototype), {_engine: engine, _uniformBuffersNames: {Material: 0}});
  buffer.bindToEffect(effect, "Material");
  buffer.updateFloat4("color", 1, 0, 0, 0);
  buffer.update();
  const original = buffer.getBuffer();
  first.resetIsDirty(1);
  for (let i = 0; i < 20; i++) buffer.bindUniformBuffer();
  assert.equal(binds, 1);
  assert.equal(first.isDirty(1), false, "unchanged bindings keep the cached bundle valid");
  engine.frameId++;
  buffer.updateFloat4("color", 2, 0, 0, 0);
  buffer.update();
  assert.equal(original.data[0], 2, "contents still upload when identity stays bound");
  assert.equal(binds, 1);
  // Another draw's binding table is independent, even with the same Effect.
  engine._currentDrawContext = second;
  buffer.bindUniformBuffer();
  assert.equal(binds, 2);
  second.reset();
  buffer.bindUniformBuffer();
  assert.equal(binds, 3, "cleared context must be repopulated");
  second.resetIsDirty(1);
  buffer.updateFloat4("color", 3, 0, 0, 0);
  buffer.update();
  assert.notEqual(buffer.getBuffer(), original, "same-frame mutation creates a new COW slot");
  assert.equal(binds, 4);
  assert.equal(second.isDirty(1), true, "new buffer identity invalidates the cached bundle");
  assert.equal(second.buffers.Material, buffer.getBuffer());
  engine.currentRenderPassId = 1;
  buffer.updateFloat4("color", 4, 0, 0, 0);
  buffer.update();
  assert.equal(binds, 5);
  assert.equal(original.data[0], 2);
  buffer._rebuildAfterContextLost();
  buffer.updateFloat4("color", 5, 0, 0, 0);
  buffer.update();
  assert.equal(binds, 6, "device restore rebinds the replacement buffer");
  assert.equal(second.buffers.Material.data[0], 5);
  buffer.dispose();
});

test("WebGL binding still goes through the effect's global binding-point cache", () => {
  const {buffer, engine} = fixture();
  let binds = 0;
  engine.isWebGPU = false;
  engine._currentDrawContext = {buffers: {Material: buffer.getBuffer()}};
  buffer.bindToEffect({bindUniformBuffer() { binds++; }}, "Material");
  buffer.bindUniformBuffer();
  buffer.bindUniformBuffer();
  assert.equal(binds, 2);
  buffer.dispose();
});
