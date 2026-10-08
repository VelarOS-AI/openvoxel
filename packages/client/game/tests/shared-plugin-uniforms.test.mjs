import assert from "node:assert/strict";
import test from "node:test";
import {SharedPluginUniforms} from "../src/backends/babylon/native/shared-plugin-uniforms.mjs";

test("dynamic plugin values upload once per pass and frame across materials while textures bind to every draw", () => {
  const writes = [], released = [], bindings = [], textures = [];
  const engine = {
    isWebGPU: true, supportsUniformBuffers: true, frameId: 1, currentRenderPassId: 0,
    _uniformBuffers: [], _features: {checkUbosContentBeforeUpload: true},
    createUniformBuffer(data) { return {data: data.slice()}; },
    updateUniformBuffer(buffer, data, offset = 0) { writes.push(buffer); buffer.data.set(data, offset / 4); },
    _releaseBuffer(buffer) { assert.ok(!released.includes(buffer)); released.push(buffer); return true; },
  };
  const shared = new SharedPluginUniforms({getEngine: () => engine, getRenderId: () => engine.frameId});
  let prepared = 0, time = 1;
  const texture = {};
  const plugin = () => shared.attach({
    name: "TestWind",
    getUniforms: () => ({ubo: [{name: "wind", size: 4, type: "vec4"}]}),
    getCustomCode: () => ({CUSTOM_VERTEX_DEFINITIONS: "// existing code"}),
    bindForSubMesh(buffer) {
      prepared++;
      buffer.updateFloat4("wind", time, engine.currentRenderPassId, 0, 0);
      buffer.setTexture("windMap", texture);
    },
  }, "wind");
  const first = plugin(), second = plugin();
  const materialBuffer = {
    currentEffect: {bindUniformBuffer(buffer, name) { bindings.push({buffer, name}); }},
    setTexture(name, value) { textures.push([name, value]); },
  };
  first.bindForSubMesh(materialBuffer);
  const main = bindings.at(-1).buffer;
  second.bindForSubMesh(materialBuffer);
  assert.equal(prepared, 1);
  assert.equal(writes.length, 1);
  assert.equal(bindings.at(-1).buffer, main);
  assert.deepEqual(textures, [["windMap", texture], ["windMap", texture]]);
  engine.currentRenderPassId = 1;
  second.bindForSubMesh(materialBuffer);
  const reflection = bindings.at(-1).buffer;
  assert.notEqual(reflection, main);
  assert.equal(reflection.data[1], 1);
  assert.equal(main.data[1], 0);
  engine.currentRenderPassId = 0;
  first.bindForSubMesh(materialBuffer);
  assert.equal(bindings.at(-1).buffer, main);
  engine.frameId++;
  time = 2;
  second.bindForSubMesh(materialBuffer);
  first.bindForSubMesh(materialBuffer);
  assert.equal(main.data[0], 2);
  assert.equal(reflection.data[0], 1);
  assert.equal(shared.blocks.size, 1);
  assert.deepEqual(first.getUniforms(), {});
  assert.match(first.getCustomCode("vertex").CUSTOM_VERTEX_DEFINITIONS, /uniform TestWindFrame[\s\S]*existing code/u);
  const names = [];
  first.getUniformBuffersNames(names);
  assert.deepEqual(names, ["TestWindFrame"]);
  shared.dispose();
  assert.equal(released.length, 2);
  assert.equal(engine._uniformBuffers.length, 0);
});

test("engines without uniform buffers retain their plugin binding contract", () => {
  const shared = new SharedPluginUniforms({getEngine: () => ({isWebGPU: false})});
  const plugin = {};
  assert.equal(shared.attach(plugin, "wind"), plugin);
  assert.equal(shared.blocks.size, 0);
  shared.dispose();
});

test("WebGL shares frame values across material instances without per-mesh buffer uploads", () => {
  let writes = 0, prepared = 0, binds = 0;
  const engine = {isWebGPU: false, supportsUniformBuffers: true, frameId: 1, currentRenderPassId: 0,
    _uniformBuffers: [], _features: {}, createUniformBuffer: () => ({}),
    updateUniformBuffer() { writes++; }, _releaseBuffer() { return true; }};
  const shared = new SharedPluginUniforms({getEngine: () => engine, getRenderId: () => engine.frameId});
  const plugin = () => shared.attach({name: "Wind", getUniforms: () => ({ubo: [{name: "wind", size: 4, type: "vec4"}]}),
    getCustomCode: () => ({}), bindForSubMesh(buffer) { prepared++; buffer.updateFloat4("wind", engine.frameId, 0, 0, 0); }}, "wind");
  const first = plugin(), second = plugin(), target = {currentEffect: {bindUniformBuffer() { binds++; }}};
  first.bindForSubMesh(target); second.bindForSubMesh(target);
  assert.equal(prepared, 1); assert.equal(writes, 1); assert.equal(binds, 2);
  engine.frameId++;
  second.bindForSubMesh(target); first.bindForSubMesh(target);
  assert.equal(prepared, 2); assert.equal(writes, 2); assert.equal(binds, 4);
  shared.dispose();
  assert.equal(engine._uniformBuffers.length, 0);
});
