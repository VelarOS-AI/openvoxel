import assert from "node:assert/strict";
import test from "node:test";
import {environmentFogRange} from "../src/native/babylon/environment-visibility.mjs";

const chunkEdge = 16;
const streamedChunkRadius = 5;
const nominalRenderDistance = chunkEdge * streamedChunkRadius;
const guaranteedSameHeightTerrainDistance = chunkEdge * 4;

test("clear weather keeps a normal landscape view while fading the streamed boundary", () => {
  const clear = environmentFogRange(nominalRenderDistance, 1);

  assert.deepEqual(clear, {start: 52.800000000000004, end: 72});
  assert.ok(clear.start < guaranteedSameHeightTerrainDistance);
  assert.ok(clear.end > guaranteedSameHeightTerrainDistance);
  assert.ok(clear.start < clear.end);
});

test("severe weather shortens terrain visibility without consuming the clear foreground", () => {
  const clear = environmentFogRange(nominalRenderDistance, 1);
  const severe = environmentFogRange(nominalRenderDistance, 4.4);

  assert.deepEqual(severe, {start: 43.2, end: 62.400000000000006});
  assert.ok(severe.start < clear.start);
  assert.ok(severe.end < clear.end);
  assert.ok(severe.start >= chunkEdge * 2.5);
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
  assert.throws(() => environmentFogRange(104, Number.NaN), /density factor/u);
});
