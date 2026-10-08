import assert from "node:assert/strict";
import test from "node:test";
import {atmosphereSun, sampleSkyToRef} from "../src/backends/babylon/native/sky-colors.mjs";

test("aerial scattering follows sun direction and weather, preserves night and stays bounded", () => {
  const frame = {sunDirection: {x: -.8, y: -.6, z: 0}, sunIntensity: 1, cloudiness: 0,
    skyTop: {r: .2, g: .4, b: .8}, horizon: {r: .6, g: .7, b: .9}, ground: {r: .1, g: .15, b: .2}};
  const sun = atmosphereSun(frame);
  const toward = sampleSkyToRef(.8, .6, 0, frame, sun, []);
  const away = sampleSkyToRef(-.8, .6, 0, frame, sun, []);
  assert.ok(toward[0] > away[0] + .2);
  const cloudy = sampleSkyToRef(.8, .6, 0, frame, atmosphereSun({...frame, cloudiness: 1}), []);
  assert.ok(cloudy[0] < toward[0]);
  const nightSun = atmosphereSun({...frame, sunDirection: {x: -.8, y: .6, z: 0}});
  assert.equal(nightSun.intensity, 0);
  assert.deepEqual(sampleSkyToRef(.8, .6, 0, frame, nightSun, []), away);
  for (const value of [...toward, ...away, ...cloudy]) assert.ok(value >= 0 && value <= 1);
});
