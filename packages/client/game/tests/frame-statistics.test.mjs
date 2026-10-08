import assert from "node:assert/strict";
import test from "node:test";
import {FrameStatistics} from "../src/backends/babylon/native/frame-statistics.mjs";

test("FPS counts real render intervals, including slow frames, with bounded publications", () => {
  const samples = [];
  const counter = new FrameStatistics((...value) => samples.push(value));
  for (let frame = 0; frame <= 120; frame++) counter.sample(frame * 1000 / 120);
  assert.ok(samples.length >= 3 && samples.length <= 4);
  assert.deepEqual(samples[0], [120, 8.3]);
  counter.sample(1500);
  assert.ok(samples.at(-1)[0] < 10, "A real half-second stall is included, rather than the capped physics delta");
});

test("hidden tab time is excluded from the next frame sample", () => {
  const samples = [];
  const counter = new FrameStatistics((...value) => samples.push(value));
  counter.sample(0);
  counter.sample(250);
  counter.sample(300, false);
  counter.sample(60_000);
  for (let i = 1; i <= 30; i++) counter.sample(60_000 + i * 1000 / 60);
  assert.deepEqual(samples.at(-1), [60, 16.7]);
});
