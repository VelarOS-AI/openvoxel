import assert from "node:assert/strict";
import test from "node:test";
import {createEnvironmentIbl, environmentIblNeedsRefresh} from "../src/native/babylon/environment-ibl.mjs";

function frame(overrides = {}) {
  return {
    sunDirection: {x: 0, y: -1, z: 0},
    sunIntensity: 0.8,
    weatherDimming: 0.9,
    skyTop: {r: 0.2, g: 0.4, b: 0.8},
    horizon: {r: 0.6, g: 0.7, b: 0.9},
    ground: {r: 0.15, g: 0.2, b: 0.18},
    ...overrides,
  };
}

test("IBL refresh ignores sub-visible timeline changes", () => {
  const previous = frame();
  const radians = Math.PI / 360;
  const next = frame({
    sunDirection: {x: Math.sin(radians), y: -Math.cos(radians), z: 0},
    sunIntensity: previous.sunIntensity + 0.01,
    weatherDimming: previous.weatherDimming - 0.01,
    skyTop: {...previous.skyTop, b: previous.skyTop.b - 0.01},
  });
  assert.equal(environmentIblNeedsRefresh(previous, next), false);
});

test("IBL refresh follows visible celestial, weather, and color changes", () => {
  const previous = frame();
  const radians = Math.PI / 45;
  assert.equal(environmentIblNeedsRefresh(null, previous), true);
  assert.equal(environmentIblNeedsRefresh(previous, frame({
    sunDirection: {x: Math.sin(radians), y: -Math.cos(radians), z: 0},
  })), true);
  assert.equal(environmentIblNeedsRefresh(previous, frame({weatherDimming: 0.8})), true);
  assert.equal(environmentIblNeedsRefresh(previous, frame({horizon: {...previous.horizon, r: 0.7}})), true);
});

test("IBL puts sky above the world and ground below it in WebGL cube order", () => {
  const {faces, polynomial} = createEnvironmentIbl(frame({
    sunIntensity: 0,
    weatherDimming: 1,
    skyTop: {r: 0, g: 0, b: 1},
    horizon: {r: 0, g: 1, b: 0},
    ground: {r: 1, g: 0, b: 0},
  }), 8);
  const middle = (4 * 8 + 4) * 4;
  assert.ok(faces[2][middle + 2] > 240, "+Y cube face must sample blue sky");
  assert.ok(faces[3][middle] > 240, "-Y cube face must sample red ground");
  for (const face of [0, 1, 4, 5]) {
    assert.ok(faces[face][middle + 1] > 220, "horizontal cube faces must sample the green horizon");
  }
  assert.ok(polynomial.y.z > 0, "upward diffuse irradiance must contain more sky blue");
  assert.ok(polynomial.y.x < 0, "downward diffuse irradiance must contain more ground red");
});

test("IBL diffuse irradiance follows refreshed linear light without GPU readback", () => {
  const gray = (value) => ({r: value, g: value, b: value});
  const day = createEnvironmentIbl(frame({sunIntensity: 0, weatherDimming: 1, skyTop: gray(0.5), horizon: gray(0.5), ground: gray(0.5)}), 8);
  const night = createEnvironmentIbl(frame({sunIntensity: 0, weatherDimming: 1, skyTop: gray(0.1), horizon: gray(0.1), ground: gray(0.1)}), 8);
  assert.ok(day.polynomial.xx.x > 0.2 && day.polynomial.xx.x < 0.24, "display-encoded sky bytes must be converted to linear diffuse radiance");
  assert.ok(night.polynomial.xx.x < day.polynomial.xx.x * 0.05, "a refreshed night cube must not keep daytime irradiance");
});
