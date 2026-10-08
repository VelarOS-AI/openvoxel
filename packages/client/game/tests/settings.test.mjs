import assert from "node:assert/strict";
import test from "node:test";
import {activeGraphicsPreset, createSettingsStore, defaultSettings, normalizeSettings, recommendGraphicsPreset} from "../src/settings/preferences.mjs";

test("settings restore bounded values and recover damaged storage", () => {
  const values = new Map();
  const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  const settings = createSettingsStore(storage);
  settings.set("viewDistance", 100);
  settings.set("masterVolume", .35);
  settings.set("weather", "snow");
  settings.set("season", "autumn");
  settings.set("renderBackend", "webgpu");
  assert.equal(createSettingsStore(storage).get().renderBackend, "webgpu");
  assert.equal(normalizeSettings({renderBackend: "invalid"}).renderBackend, "auto");
  assert.equal(createSettingsStore(storage).get().masterVolume, .35);
  assert.equal(createSettingsStore(storage).get().viewDistance, 8);
  assert.equal(createSettingsStore(storage).get().weather, "snow");
  assert.equal(createSettingsStore(storage).get().season, "autumn");
  assert.equal(normalizeSettings({season: "invalid"}).season, "auto");
  assert.deepEqual(normalizeSettings({fov: NaN, weather: "invalid", shadows: "yes", extra: true}), defaultSettings);
  assert.deepEqual(createSettingsStore({getItem: () => "{"}).get(), defaultSettings);
  assert.deepEqual(createSettingsStore({getItem: () => { throw Error("denied"); }}).get(), defaultSettings);
});

test("live updates, binding swaps and reset notify subscribers with immutable snapshots", () => {
  const settings = createSettingsStore();
  const snapshots = [];
  const subscription = settings.subscribe(value => snapshots.push(value));
  settings.set("forwardKey", "KeyS");
  assert.equal(settings.get().backwardKey, "KeyW");
  assert.equal(settings.get().forwardKey, "KeyS");
  assert.throws(() => settings.set("forwardKey", "Escape"));
  assert.throws(() => settings.set("forwardKey", "KeyE"));
  assert.equal(normalizeSettings({forwardKey: "KeyE"}).forwardKey, "KeyW");
  assert.throws(() => settings.set("unknown", 0));
  assert.ok(Object.isFrozen(snapshots[0]));
  settings.set("sensitivity", 2);
  settings.set("renderBackend", "webgl");
  settings.preset("low");
  assert.equal(settings.get().sensitivity, 2, "graphics presets preserve controls");
  assert.equal(settings.get().forwardKey, "KeyS");
  assert.equal(settings.get().waterReflections, false);
  assert.equal(settings.get().renderBackend, "webgl", "quality presets preserve the selected backend");
  settings.reset();
  assert.deepEqual(settings.get(), defaultSettings);
  assert.equal(snapshots.length, 5);
  subscription.close();
  settings.set("masterVolume", 0);
  assert.equal(snapshots.length, 5);
});

test("saving failure is visible while the live setting still applies", () => {
  const settings = createSettingsStore({setItem: () => { throw Error("quota"); }});
  let received;
  settings.subscribe(value => { received = value; });
  settings.set("fov", 80);
  assert.equal(received.fov, 80);
  assert.notEqual(settings.error(), "");
});


test("device defaults are conservative and saved custom values win", () => {
  assert.equal(recommendGraphicsPreset({cores: 4, memory: 4}), "low");
  assert.equal(recommendGraphicsPreset({cores: 10, memory: 8, pixels: 5_000_000}), "balanced");
  assert.equal(recommendGraphicsPreset({cores: 16, memory: 16, pixels: 4_000_000}), "high");
  assert.equal(recommendGraphicsPreset({cores: 16, memory: 16, pixels: 10_000_000}), "balanced");
  assert.equal(recommendGraphicsPreset({cores: 16, memory: 16, pixels: 2_000_000, mobile: true}), "balanced");
  const storage = {getItem: () => JSON.stringify({renderScale: .75, viewDistance: 7, masterVolume: .4})};
  const settings = createSettingsStore(storage, {cores: 4, memory: 4});
  assert.equal(settings.recommended(), "low");
  assert.equal(settings.get().viewDistance, 7);
  assert.equal(settings.get().renderScale, .75);
  assert.equal(settings.get().masterVolume, .4);
  assert.equal(activeGraphicsPreset(settings.get()), "custom");
  settings.preset("ultra");
  assert.equal(settings.get().viewDistance, 8);
  assert.equal(activeGraphicsPreset(settings.get()), "ultra");
  assert.equal(settings.get().masterVolume, .4);
  settings.reset();
  assert.equal(activeGraphicsPreset(settings.get()), "low");
});
