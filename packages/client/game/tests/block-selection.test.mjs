import assert from "node:assert/strict";
import test from "node:test";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Scene} from "@babylonjs/core/scene.js";
import {BlockSelectionOutline} from "../src/backends/babylon/native/block-selection.mjs";

const cube = {minimumX: 0, minimumY: 0, minimumZ: 0, maximumX: 1, maximumY: 1, maximumZ: 1};
test("selection outline reuses its mesh, follows shape bounds, hides on miss and releases resources", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const outline = new BlockSelectionOutline(scene);
  try {
    outline.set({x: -3, y: 52, z: 7, boxes: [cube]});
    const mesh = outline.mesh;
    assert.equal(mesh.getTotalVertices(), 24);
    assert.deepEqual(mesh.position.asArray(), [-3, 52, 7]);
    assert.equal(mesh.isPickable, false);
    outline.set({x: 2, y: 4, z: -8, boxes: [{...cube, maximumY: 0.125}]});
    assert.equal(outline.mesh, mesh);
    assert.ok(Math.abs(mesh.getBoundingInfo().boundingBox.maximum.y - 0.128) < 0.000001);
    assert.deepEqual(mesh.position.asArray(), [2, 4, -8]);
    outline.set(null);
    assert.equal(mesh.isEnabled(), false);
    outline.set({x: 0, y: 0, z: 0, boxes: [cube, {...cube, maximumY: 0.5}]});
    assert.equal(mesh.isDisposed(), true);
    assert.equal(outline.mesh.getTotalVertices(), 48);
    assert.equal(scene.meshes.length, 1);
    outline.dispose();
    assert.equal(scene.meshes.length, 0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
