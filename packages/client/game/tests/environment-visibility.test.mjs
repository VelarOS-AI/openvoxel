import assert from "node:assert/strict";
import test from "node:test";
import {environmentFogRange} from "../src/backends/babylon/native/environment-visibility.mjs";

const chunkEdge = 16;
const streamedChunkRadius = 6;
const nominalRenderDistance = chunkEdge * streamedChunkRadius;
const guaranteedSameHeightTerrainDistance = chunkEdge * 5;

test("clear weather keeps a normal landscape view while fading the streamed boundary", () => {
  const clear = environmentFogRange(nominalRenderDistance, 1);

  assert.deepEqual(clear, {start: 63.36, end: 86.4});
  assert.ok(clear.start < guaranteedSameHeightTerrainDistance);
  assert.ok(clear.end > guaranteedSameHeightTerrainDistance);
  assert.ok(clear.start < clear.end);
});

test("severe weather shortens terrain visibility without consuming the clear foreground", () => {
  const clear = environmentFogRange(nominalRenderDistance, 1);
  const severe = environmentFogRange(nominalRenderDistance, 4.4);

  assert.deepEqual(severe, {start: 57.599999999999994, end: 79.67999999999999});
  assert.ok(severe.start < clear.start);
  assert.ok(severe.end < clear.end);
  assert.ok(severe.start >= chunkEdge * 3.5);
  assert.ok(severe.end <= guaranteedSameHeightTerrainDistance);
  assert.ok(clear.start < clear.end);
  assert.ok(severe.start < severe.end);
});

test("weather severity is capped at the configured severe range", () => {
  assert.deepEqual(
    environmentFogRange(nominalRenderDistance, 40),
    environmentFogRange(nominalRenderDistance, 4.4),
  );
});

test("fog range rejects invalid renderer input", () => {
  assert.throws(() => environmentFogRange(0, 1), /render distance/u);
  assert.throws(() => environmentFogRange(nominalRenderDistance, Number.NaN), /density factor/u);
});


test("user fog strength changes clear-weather haze while keeping the streaming edge covered", () => {
  const normal = environmentFogRange(96, 1);
  const light = environmentFogRange(96, 1, .5);
  const dense = environmentFogRange(96, 1, 2);
  assert.ok(light.start > normal.start && normal.start > dense.start);
  assert.ok(light.end > normal.end && normal.end > dense.end);
  assert.ok(light.end < 96);
  assert.ok(dense.start < dense.end);
});
