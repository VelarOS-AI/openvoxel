import assert from "node:assert/strict";
import test from "node:test";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Scene} from "@babylonjs/core/scene.js";
import {FreeCamera} from "@babylonjs/core/Cameras/freeCamera.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";
import {MeshBuilder} from "@babylonjs/core/Meshes/meshBuilder.js";
import {Mesh} from "@babylonjs/core/Meshes/mesh.js";
import {WaterCapture} from "../src/backends/babylon/native/water-capture.mjs";

test("water captures share two targets, exclude fluid feedback, and release when leaving water", () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new FreeCamera("eye", new Vector3(0, 8, -12), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  const water = MeshBuilder.CreateGround("water", {width: 16, height: 16}, scene);
  water.precipitationSurface = "water";
  water.renderingGroupId = 2;
  water.computeWorldMatrix(true);
  const bed = MeshBuilder.CreateGround("bed", {width: 16, height: 16}, scene);
  bed.position.y = -3;
  bed.computeWorldMatrix(true);
  const sky = new Mesh("sky", scene), clouds = new Mesh("clouds", scene);
  const runtime = {};
  const capture = new WaterCapture(scene, camera, runtime, new Map([["0:0", new Set([water, bed])]]), {sky: {mesh: sky}, clouds: {mesh: clouds}}, 16);
  try {
    scene.updateTransformMatrix(true);
    capture.register(water);
    capture.update(250);
    assert.equal(capture.active, true);
    assert.equal(capture.level, 0);
    assert.equal(scene.customRenderTargets.length, 2);
    assert.deepEqual([...capture.refraction.renderList], [bed]);
    assert.deepEqual([...capture.reflection.renderList], [sky, clouds]);
    const targets = [...scene.customRenderTargets];
    capture.update(250);
    assert.deepEqual([...scene.customRenderTargets], targets, "Updates reuse both targets");
    assert.equal(capture.usable(scene), false, "No sampling until both captures have rendered");
    capture.reflectionReady = true;
    capture.refractionReady = true;
    assert.equal(capture.usable(scene), true);
    let stationaryPasses = 0;
    for (let frame = 0; frame < 60; frame++) {
      capture.update(1000 / 60);
      capture.scheduleCaptures();
      stationaryPasses += Number(capture.reflection._shouldRender());
      capture.refraction._shouldRender();
    }
    assert.ok(stationaryPasses >= 12 && stationaryPasses <= 16, `Stationary water rendered ${stationaryPasses} captures in one second`);
    for (let frame = 0; frame < 10; frame++) {
      camera.position.x += 0.1;
      capture.update(1000 / 60);
      capture.scheduleCaptures();
      assert.equal(capture.reflection._shouldRender(), true, "Moving cameras need fresh reflection projections every frame");
      assert.equal(capture.refraction._shouldRender(), true);
    }
    capture.register(bed);
    capture.update(1);
    capture.scheduleCaptures();
    assert.equal(capture.reflection._shouldRender(), true, "New shoreline geometry invalidates a stationary capture immediately");
    capture.rendering = true;
    assert.equal(capture.usable(scene), false, "A capture never samples itself");
    capture.rendering = false;
    capture.remove(water);
    capture.update(250);
    assert.equal(capture.active, false);
    assert.equal(scene.customRenderTargets.length, 0);
  } finally {
    capture.dispose();
    assert.equal(runtime.capture, null);
    scene.dispose();
    engine.dispose();
  }
});
