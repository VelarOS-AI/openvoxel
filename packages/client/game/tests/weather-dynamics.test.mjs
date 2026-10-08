import assert from "node:assert/strict";
import test from "node:test";
import {weatherProfile, weatherAudioLevels, windGust} from "../src/environment/weather-dynamics.mjs";

test("light, moderate, heavy and storm weather blend continuously within fixed sprite budgets", () => {
  for (const kind of ["rain", "snow"]) {
    const profiles = [0, 0.1, 0.4, 0.7, 1].map(intensity => weatherProfile(kind, intensity, 12));
    assert.deepEqual(profiles.map(profile => profile.level), ["none", "light", "moderate", "heavy", "storm"]);
    for (let i = 1; i < profiles.length; i++) {
      assert.ok(profiles[i].rainWidth > profiles[i - 1].rainWidth);
      assert.ok(profiles[i].snowSize > profiles[i - 1].snowSize);
      assert.ok(profiles[i].opacity <= 0.850001);
    }
    for (const boundary of [0.25, 0.6, 0.85]) {
      const before = weatherProfile(kind, boundary - 0.00001, 12);
      const after = weatherProfile(kind, boundary + 0.00001, 12);
      for (const key of ["rainSpeed", "snowSize", "opacity", "snowFlutter"]) assert.ok(Math.abs(before[key] - after[key]) < 0.0001);
    }
  }
});

test("gusts cross chunk seams smoothly and snowfall stays quiet until wind rises", () => {
  for (const t of [0, 1, 20, 100]) {
    assert.ok(Math.abs(windGust(t, 15.999, -16) - windGust(t, 16.001, -16)) < 0.001);
    assert.ok(windGust(t) > 0 && windGust(t) < 1.2);
  }
  const lightSnow = weatherAudioLevels({precipitation: "snow", precipitationIntensity: 0.15, windX: 0, windZ: 0});
  const blizzard = weatherAudioLevels({precipitation: "snow", precipitationIntensity: 1, windX: 14, windZ: 0});
  assert.equal(lightSnow.rain, 0);
  assert.ok(lightSnow.wind < 0.005);
  assert.ok(blizzard.wind > lightSnow.wind * 10);
  assert.ok(blizzard.water < lightSnow.water);
  assert.ok(blizzard.windCutoff > lightSnow.windCutoff);
});
