import assert from "node:assert/strict";
import test from "node:test";
import {Color3} from "@babylonjs/core/Maths/math.color.js";
import {LightingTransition} from "../src/backends/babylon/native/lighting-transition.mjs";
const frame = value => ({daylightIntensity: value, skyIntensity: value, sunIntensity: value, moonIntensity: 1 - value,
  skyTop: new Color3(value, value, value), horizon: new Color3(value, value, value), ground: new Color3(value, value, value), fog: new Color3(value, value, value), lightningFlash: value});
test("lighting samples ease monotonically at the same rate across different frame cadences", () => {
  const a = new LightingTransition(frame(0)), b = new LightingTransition(frame(0));
  const target = frame(1);
  a.apply(target); b.apply(target);
  assert.equal(a.frame.sunIntensity, 0);
  assert.equal(a.frame.lightningFlash, 1, "lightning retains immediate event timing");
  let previous = 0;
  for (let i = 0; i < 60; i++) {
    a.advance(1000 / 60);
    assert.ok(a.frame.sunIntensity >= previous && a.frame.sunIntensity < 1);
    previous = a.frame.sunIntensity;
  }
  for (let i = 0; i < 30; i++) b.advance(1000 / 30);
  assert.ok(a.frame.sunIntensity > 0.99);
  assert.ok(Math.abs(a.frame.sunIntensity - b.frame.sunIntensity) < 0.000001);
  assert.equal(target.skyTop.r, 1, "interpolation must not mutate authoritative colors");
  a.apply(frame(0)); a.advance(16);
  assert.ok(a.frame.sunIntensity < previous && a.frame.sunIntensity > 0);
});
