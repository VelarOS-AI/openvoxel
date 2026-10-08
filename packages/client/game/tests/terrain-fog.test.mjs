import assert from "node:assert/strict";
import test from "node:test";
import {fogFragment} from "@babylonjs/core/Shaders/ShadersInclude/fogFragment.js";
import {TerrainFogPlugin, terrainFogOpacity} from "../src/backends/babylon/native/terrain-fog.mjs";
import {skyColorShader} from "../src/backends/babylon/native/sky-colors.mjs";
import {pbrPixelShader} from "@babylonjs/core/Shaders/pbr.fragment.js";

test("terrain haze keeps nearby ground visible from above and still closes the horizontal horizon", () => {
  assert.equal(terrainFogOpacity(35, 70, 58, 80), 0);
  assert.equal(terrainFogOpacity(69, 0, 58, 80), 0.5);
  assert.equal(terrainFogOpacity(80, 0, 58, 80), 1);
  let previous = 0;
  for (let distance = 0; distance <= 100; distance += 1) {
    const opacity = terrainFogOpacity(distance, 0, 58, 80);
    assert.ok(opacity >= previous && opacity <= 1);
    previous = opacity;
  }
});

test("terrain fog integration matches exactly one installed Babylon PBR fog coefficient", () => {
  const code = TerrainFogPlugin.prototype.getCustomCode("fragment");
  const substitutions = Object.entries(code).filter(([key]) => key.startsWith("!"));
  const pbrFog = fogFragment.shader.replaceAll("color.rgb", "finalColor.rgb");
  assert.equal(substitutions.length, 3);
  for (const [key] of substitutions) {
    assert.equal([...pbrFog.matchAll(new RegExp(key.slice(1), "g"))].length, 1);
  }
  let adapted = pbrFog;
  for (const [key, value] of substitutions) adapted = adapted.replace(new RegExp(key.slice(1), "g"), value);
  assert.match(adapted, /float fog=ovTerrainFogTransmittance\(\)/u);
  assert.doesNotMatch(adapted, /fog=toLinearSpace\(fog\)/u);
  assert.doesNotMatch(adapted, /finalColor.rgb=mix/u);
  assert.match(code.CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR, /ovDirectionalSky/u);
  assert.ok(code.CUSTOM_FRAGMENT_DEFINITIONS.includes(skyColorShader));
  assert.ok(pbrPixelShader.shader.indexOf("#include<pbrBlockImageProcessing>") < pbrPixelShader.shader.indexOf("#define CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR"));
  assert.equal(TerrainFogPlugin.prototype.getCustomCode("vertex"), null);
});

test("terrain fog binds live sky colors and the transient lightning flash from its environment owner", () => {
  const atmosphere = {skyTop: {r: 0.1, g: 0.2, b: 0.3}, horizon: {r: 0.4, g: 0.5, b: 0.6}, ground: {r: 0.2, g: 0.3, b: 0.4}, flash: 0};
  const values = new Map();
  const buffer = {updateFloat4: (key, ...value) => values.set(key, value), updateFloat3: (key, ...value) => values.set(key, value), updateFloat: (key, value) => values.set(key, value)};
  TerrainFogPlugin.prototype.bindForSubMesh.call({atmosphere}, buffer);
  assert.deepEqual(values.get("ovTerrainHorizon"), [0.4, 0.5, 0.6]);
  atmosphere.horizon = {r: 0.8, g: 0.7, b: 0.6};
  atmosphere.flash = 0.75;
  TerrainFogPlugin.prototype.bindForSubMesh.call({atmosphere}, buffer);
  assert.deepEqual(values.get("ovTerrainHorizon"), [0.8, 0.7, 0.6]);
  assert.equal(values.get("ovTerrainFlash"), 0.75);
});
