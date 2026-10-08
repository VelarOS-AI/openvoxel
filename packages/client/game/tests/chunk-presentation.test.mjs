import assert from "node:assert/strict";
import test from "node:test";
import {ChunkPresentation} from "../src/backends/babylon/native/chunk-presentation.mjs";
const mesh = (castsVoxelShadow = true) => ({castsVoxelShadow, enabled: true, setEnabled(value) { this.enabled = value; }});

test("complete chunks wait for lighting and publish once, invalidating cached shadows", () => {
  let ready = false;
  const presentation = new ChunkPresentation(() => ready), terrain = mesh();
  presentation.show("a", [terrain]);
  assert.equal(terrain.enabled, false);
  assert.equal(presentation.update(), false);
  ready = true;
  assert.equal(presentation.update(), true);
  assert.equal(terrain.enabled, true);
  assert.equal(presentation.update(), false);
  assert.equal(presentation.waiting.size, 0);
});

test("retirement and replacement cannot later enable stale geometry", () => {
  let ready = false;
  const presentation = new ChunkPresentation(() => ready), old = mesh(), next = mesh(false);
  presentation.show("a", [old]);
  presentation.show("a", [next]);
  ready = true;
  assert.equal(presentation.update(), false);
  assert.equal(old.enabled, false);
  assert.equal(next.enabled, true);
  ready = false;
  presentation.show("b", [old]);
  presentation.remove("b");
  ready = true;
  presentation.update();
  assert.equal(old.enabled, false);
});

test("ready lighting publishes immediately and teardown forgets all pending chunks", () => {
  const presentation = new ChunkPresentation(), terrain = mesh();
  presentation.show("a", [terrain]);
  assert.equal(terrain.enabled, true);
  assert.equal(presentation.waiting.size, 0);
  presentation.ready = () => false;
  presentation.show("b", [mesh()]);
  presentation.clear(); presentation.clear();
  assert.equal(presentation.waiting.size, 0);
});
