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
  const originalClipPlane = scene.clipPlane;
  const capture = new WaterCapture(scene, camera, runtime, new Map([["0:0", new Set([water, bed])]]), {sky: {mesh: sky}, clouds: {mesh: clouds}}, 16);
  try {
    scene.updateTransformMatrix(true);
    const idlePlane = scene.clipPlane;
    assert.ok(idlePlane, "the clip shader variant is established before seeing water");
    assert.ok(idlePlane.dotCoordinate(new Vector3(1e6, -1e6, 1e6)) < 0, "the idle plane never clips world geometry");
    capture.register(water);
    capture.update(250);
    assert.equal(capture.active, true);
    assert.equal(capture.level, 0);
    assert.equal(scene.customRenderTargets.length, 0);
    assert.equal(camera.customRenderTargets.length, 2);
    assert.deepEqual([...capture.refraction.renderList], [bed]);
    assert.deepEqual([...capture.reflection.renderList], [sky, clouds]);
    const targets = [...camera.customRenderTargets];
    capture.reflection.onBeforeRenderObservable.notifyObservers(0);
    assert.notEqual(scene.clipPlane, idlePlane);
    capture.reflection.onAfterRenderObservable.notifyObservers(0);
    assert.equal(scene.clipPlane, idlePlane, "reflection restores the non-clipping plane without removing the define");
    capture.refraction.onBeforeRenderObservable.notifyObservers(0);
    assert.notEqual(scene.clipPlane, idlePlane);
    capture.refraction.onAfterRenderObservable.notifyObservers(0);
    assert.equal(scene.clipPlane, idlePlane, "refraction restores the same shader variant");
    capture.reflectionReady = capture.refractionReady = false;
    capture.update(250);
    assert.deepEqual([...camera.customRenderTargets], targets, "Updates reuse both targets");
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
    let movingReflections = 0, movingRefractions = 0;
    for (let frame = 0; frame < 10; frame++) {
      camera.position.x += 0.1;
      capture.register(bed); // Chunk arrival while moving keeps the same pass budget.
      capture.update(1000 / 60);
      capture.scheduleCaptures();
      const reflection = Number(capture.reflection._shouldRender());
      const refraction = Number(capture.refraction._shouldRender());
      assert.equal(reflection + refraction, 1, "Moving water adds one terrain pass per frame");
      movingReflections += reflection;
      movingRefractions += refraction;
    }
    assert.equal(movingReflections, 5);
    assert.equal(movingRefractions, 5);
    capture.register(bed);
    capture.update(1);
    capture.scheduleCaptures();
    assert.equal(capture.reflection._shouldRender(), true, "New shoreline geometry invalidates a stationary capture immediately");
    capture.refraction._shouldRender();
    const blend = capture.blend;
    camera.setTarget(new Vector3(camera.position.x, 8, -30));
    scene.updateTransformMatrix(true);
    assert.equal(water.isInFrustum(scene.frustumPlanes), false);
    capture.update(250);
    capture.scheduleCaptures();
    assert.equal(capture.active, true, "Looking away must retain the nearby water capture");
    assert.equal(capture.blend, blend, "Frustum exits must not restart water opacity/reflection blending");
    assert.equal(capture.reflection._shouldRender(), false, "Offscreen cached water must not spend a reflection pass");
    assert.equal(capture.refraction._shouldRender(), false);
    camera.position.x += 0.1;
    camera.setTarget(Vector3.Zero());
    // Keep scene.frustumPlanes stale: capture scheduling must use the current
    // camera, including on the first render after turning back toward water.
    assert.equal(water.isInFrustum(scene.frustumPlanes), false);
    capture.update(1);
    capture.scheduleCaptures();
    assert.equal(capture.reflection._shouldRender(), true);
    assert.equal(capture.refraction._shouldRender(), true);
    assert.equal(capture.usable(scene), true);
    assert.equal(capture.blend, blend);
    capture.rendering = true;
    assert.equal(capture.usable(scene), false, "A capture never samples itself");
    capture.rendering = false;
    capture.remove(water);
    capture.update(250);
    assert.equal(capture.active, false);
    assert.equal(scene.customRenderTargets.length, 0);
    assert.equal(camera.customRenderTargets.length, 0);
  } finally {
    capture.dispose();
    assert.equal(scene.clipPlane, originalClipPlane);
    assert.equal(runtime.capture, null);
    scene.dispose();
    engine.dispose();
  }
});
