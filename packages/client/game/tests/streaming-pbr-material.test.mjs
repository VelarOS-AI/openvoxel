import assert from "node:assert/strict";
import test from "node:test";
import {StreamingPBRMaterial} from "../src/backends/babylon/native/streaming-pbr-material.mjs";
import {PassUniformBuffer} from "../src/backends/babylon/native/pass-uniform-buffer.mjs";

test("retained voxel bindings refresh globals per render and initialize each material/pass/context", () => {
  const engine = {currentRenderPassId: 1};
  let renderId = 1, dynamicBinds = 0;
  const scene = {getRenderId: () => renderId, getEngine: () => engine, isCachedMaterialInvalid: () => true};
  const effect = {_pipelineContext: {}};
  const subMesh = {_drawWrapper: {_forceRebindOnNextCall: false}};
  function material() {
    const buffer = Object.assign(Object.create(PassUniformBuffer.prototype), {_needSync: false, _valueCache: {}});
    return {_uniformBuffer: buffer, checkReadyOnlyOnce: true, _eventInfo: {},
      _callbackPluginEventBindForSubMesh() { dynamicBinds++; }};
  }
  const first = material(), second = material();
  const bind = target => StreamingPBRMaterial.prototype._mustRebind.call(target, scene, effect, subMesh);
  assert.equal(bind(first), true);
  assert.equal(bind(second), true, "another material needs its own texture initialization");
  assert.equal(bind(first), false);
  assert.equal(bind(second), false);
  assert.equal(dynamicBinds, 2, "wind, captures, climate and animation still bind");
  renderId++;
  assert.equal(bind(second), true);
  assert.equal(bind(first), false, "globals are shared by the shader within a render");
  engine.currentRenderPassId++;
  first._uniformBuffer._valueCache = {};
  assert.equal(bind(first), true, "new pass buffer needs initialization");
  first._uniformBuffer._needSync = true;
  assert.equal(bind(first), true, "scene intensity/visibility and mesh inputs refresh the recipe");
  first._uniformBuffer._needSync = false;
  subMesh._drawWrapper._forceRebindOnNextCall = true;
  assert.equal(bind(first), true, "dirty material defines force the base binding");
  subMesh._drawWrapper._forceRebindOnNextCall = false;
  effect._pipelineContext = {};
  assert.equal(bind(first), true, "device restore and replacement effects initialize bindings");
  first.checkReadyOnlyOnce = false;
  assert.equal(bind(first), true, "shared mutable materials retain Babylon's binding path");
});
