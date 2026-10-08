import assert from "node:assert/strict";
import test from "node:test";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Scene} from "@babylonjs/core/scene.js";
import {PBRMaterial} from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import {VegetationMotionPlugin, VegetationMotionRuntime} from "../src/backends/babylon/native/vegetation-motion.mjs";

test("vegetation motion follows wind and responds briefly to nearby movement", () => {
  const runtime = new VegetationMotionRuntime({windX: 2, windZ: -1});
  runtime.update(16, {x: 0, y: 70, z: 0});
  assert.equal(runtime.movement, 0);
  runtime.update(250, {x: 1, y: 70, z: 0});
  assert.ok(runtime.movement > 0.7);
  const moving = runtime.movement;
  runtime.update(1000, {x: 1, y: 70, z: 0});
  assert.ok(runtime.movement < moving * 0.01);
  runtime.setEnvironmentFrame({windX: -4, windZ: 3});
  assert.deepEqual([runtime.windX, runtime.windZ], [-4, 3]);
});

test("cross plants bend at their free tips while leaf movement stays subtle", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const runtime = new VegetationMotionRuntime({windX: 0, windZ: 0});
  try {
    const cross = new VegetationMotionPlugin(new PBRMaterial("cross", scene), "cross", runtime);
    const leaves = new VegetationMotionPlugin(new PBRMaterial("leaves", scene), "leaves", runtime);
    assert.match(cross.getCustomCode("vertex").CUSTOM_VERTEX_UPDATE_POSITION, /clamp\(uvUpdated\.y/u);
    assert.match(cross.getCustomCode("vertex").CUSTOM_VERTEX_UPDATE_POSITION, /ovVegetationPlayer\.w/u);
    assert.match(leaves.getCustomCode("vertex").CUSTOM_VERTEX_UPDATE_POSITION, /ovLeafWorld/u);
    assert.doesNotMatch(leaves.getCustomCode("vertex").CUSTOM_VERTEX_UPDATE_POSITION, /ovVegetationPlayer\.w/u);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
