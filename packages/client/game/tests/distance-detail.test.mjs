import assert from "node:assert/strict";
import test from "node:test";
import {DistanceDetail, detailCoverage, meshDetailDistance, stableShaderCode} from "../src/backends/babylon/native/distance-detail.mjs";

function mesh(x) {
  return {isVisible: true, checkCollisions: true,
    getBoundingInfo: () => ({boundingBox: {minimumWorld: {x, y: 0, z: 0}, maximumWorld: {x: x + 16, y: 16, z: 16}}})};
}

test("distance detail fades small plants, preserves terrain/tree silhouettes and restores the same meshes", () => {
  const detail = new DistanceDetail(), plant = mesh(0), tree = mesh(0), terrain = mesh(0);
  detail.add(plant, "openvoxel:material/cross");
  detail.add(tree, "openvoxel:material/leaves");
  detail.add(terrain, "openvoxel:material/terrain");
  detail.update(100, {x: 56, y: 8, z: 8});
  assert.ok(plant.isVisible);
  assert.equal(detail.meshes.size, 1, "terrain and crowns do not require CPU distance updates");
  detail.update(100, {x: 120, y: 8, z: 8});
  assert.equal(plant.isVisible, false);
  assert.equal(tree.isVisible, true);
  assert.equal(terrain.isVisible, true);
  assert.equal(detailCoverage(meshDetailDistance(terrain, {x: 120, y: 8, z: 8}), 48, 80), 0);
  assert.equal(terrain.checkCollisions, true);
  detail.update(100, {x: 8, y: 8, z: 8});
  assert.equal(plant.isVisible, true);
  assert.equal(detailCoverage(meshDetailDistance(terrain, {x: 8, y: 8, z: 8}), 48, 80), 1);
  detail.remove(plant);
  detail.update(100, {x: 120, y: 8, z: 8});
  assert.equal(plant.isVisible, true, "released meshes must not be updated");
  detail.clear();
  assert.equal(detail.meshes.size, 0);
});

test("distance coverage has a monotonic smooth transition with exact full and zero endpoints", () => {
  let previous = 1;
  for (let d = 0; d <= 100; d++) {
    const value = detailCoverage(d, 32, 56);
    assert.ok(value <= previous && value >= 0);
    previous = value;
  }
  assert.equal(detailCoverage(32, 32, 56), 1);
  assert.equal(detailCoverage(44, 32, 56), 0.5);
  assert.equal(detailCoverage(56, 32, 56), 0);
});

test("immutable plugin injection code is reused without sharing different recipe variants", () => {
  let reads = 0;
  const plugin = variant => stableShaderCode({getCustomCode: stage => { reads++; return {[stage]: variant}; }});
  const grass = plugin("grass"), leaves = plugin("leaves");
  for (let i = 0; i < 100; i++) assert.equal(grass.getCustomCode("fragment"), grass.getCustomCode("fragment"));
  assert.equal(reads, 4);
  assert.notDeepEqual(grass.getCustomCode("vertex"), leaves.getCustomCode("vertex"));
});
