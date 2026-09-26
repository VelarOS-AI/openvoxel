import assert from "node:assert/strict";
import test from "node:test";
import {ChunkTransitions} from "../src/backends/babylon/native/chunk-transition.mjs";

test("chunk entry waits for its light field and can be cancelled while waiting", () => {
  let ready = false;
  const transitions = new ChunkTransitions({ready: () => ready}), meshes = [{}];
  transitions.show("a", meshes);
  transitions.update(1000);
  assert.equal(meshes[0].chunkCoverage, 0, "new geometry must not appear black before lighting arrives");
  ready = true;
  transitions.update(140);
  assert.equal(meshes[0].chunkCoverage, 0.5);
  transitions.show("b", [{}]);
  let disposed = false;
  ready = false;
  transitions.hide("b", [{}], () => { disposed = true; });
  assert.equal(disposed, true);
});

test("chunk coverage enters and retires monotonically, releasing GPU meshes after fading", () => {
  const transitions = new ChunkTransitions();
  const meshes = [{}, {}];
  let disposed = 0;
  transitions.show("a", meshes);
  assert.equal(meshes[0].chunkCoverage, 0);
  transitions.update(0);
  assert.equal(transitions.entries.size, 1, "a zero-duration startup frame must keep the fade-in pending");
  transitions.update(140);
  assert.equal(meshes[0].chunkCoverage, 0.5);
  transitions.update(140);
  assert.equal(meshes[0].chunkCoverage, 1);
  assert.equal(transitions.entries.size, 0);
  transitions.hide("a", meshes, () => disposed++);
  transitions.update(0);
  assert.equal(disposed, 0, "a zero-duration unload frame must not dispose visible geometry");
  transitions.update(110);
  assert.equal(meshes[0].chunkCoverage, 0.5);
  assert.equal(disposed, 0);
  transitions.update(110);
  assert.equal(disposed, 1);
  assert.equal(transitions.retiringMeshes, 0);
});

test("remeshing and reversing an unload preserve current coverage", () => {
  const transitions = new ChunkTransitions();
  const old = [{}], replacement = [{}], returned = [{}];
  let disposed = 0;
  transitions.show("a", old);
  transitions.update(140);
  transitions.show("a", replacement, 1);
  assert.equal(replacement[0].chunkCoverage, old[0].chunkCoverage);
  transitions.hide("a", replacement, () => disposed++);
  transitions.update(55);
  transitions.show("a", returned);
  assert.equal(returned[0].chunkCoverage, replacement[0].chunkCoverage);
  assert.equal(disposed, 1);
  transitions.update(280);
  assert.equal(returned[0].chunkCoverage, 1);
  assert.equal(transitions.retiringMeshes, 0);
});

test("teleports bound retiring meshes and teardown releases them exactly once", () => {
  const transitions = new ChunkTransitions({maximumRetiringMeshes: 2});
  const disposed = [];
  for (const key of ["a", "b", "c"]) transitions.hide(key, [{}], () => disposed.push(key));
  assert.deepEqual(disposed, ["a"]);
  assert.equal(transitions.retiringMeshes, 2);
  transitions.clear();
  transitions.clear();
  assert.deepEqual(disposed, ["a", "b", "c"]);
  assert.equal(transitions.retiringMeshes, 0);
  assert.equal(transitions.entries.size, 0);
});
