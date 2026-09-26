import assert from "node:assert/strict";
import test from "node:test";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Scene} from "@babylonjs/core/scene.js";
import {VoxelMaterialLibrary} from "../src/backends/babylon/native/material-library.mjs";

function texture() {
  return {isReady: () => true};
}

function waterLibrary(scene) {
  const sharedNormal = texture();
  const bank = {
    key: "test:fluid",
    role: "fluid",
    layerCount: 2,
    albedo: texture(),
    normal: sharedNormal,
    material: texture(),
    emissive: texture(),
  };
  const waterOptics = {
    indexOfRefraction: 1.333,
    roughness: 0.055,
    normalStrength: 0.22,
    waves: [
      {normalTexture: "test:water", scale: 0.08, speed: 0.018, directionX: 1, directionZ: 0},
      {normalTexture: "test:water-flow", scale: 0.137, speed: 0.027, directionX: 0, directionZ: 1},
    ],
  };
  const library = new VoxelMaterialLibrary(scene, {
    materials: [{
      key: "test:water-material",
      precipitationSurface: "water",
      materialEffect: "water",
      waterOptics,
      alpha: 0.52,
      alphaCutoff: 0,
      doubleSided: true,
      castsShadows: false,
      environmentIntensity: 1.35,
      specularWeight: 1,
      clearCoat: 0,
      clearCoatRoughness: 0,
      unlit: false,
    }],
    textures: [
      {key: "test:water", bankKey: bank.key, alphaCutoff: null, variants: [{layer: 0}]},
      {key: "test:water-flow", bankKey: bank.key, alphaCutoff: null, variants: [{layer: 1}]},
    ],
    animations: [{key: "test:water-animation", frames: ["test:water", "test:water-flow"], frameDurationMs: 240}],
  }, new Map([[bank.key, bank]]), null);
  return {library, bank};
}

function batch(animationKey = "test:water-animation") {
  return {
    pipelineKey: `translucent|test:fluid|test:water-material|${animationKey ?? "-"}`,
    layer: "translucent",
    bankKey: "test:fluid",
    materialKey: "test:water-material",
    animationKey,
  };
}

test("water uses one shared continuous runtime, neutral albedo, and Babylon scene IBL", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const {library, bank} = waterLibrary(scene);
  try {
    const material = library.materialFor(batch());
    const samePipeline = library.materialFor({...batch()});
    const secondPipeline = library.materialFor(batch(null));
    assert.equal(samePipeline, material);
    assert.notEqual(secondPipeline, material);
    assert.equal(library.waterSurfaceRuntime.plugins.size, 2);
    assert.equal(scene.customRenderTargets.length, 0);

    const texturePlugin = material.pluginManager.getPlugin("OpenVoxelTextureArray");
    const waterPlugin = material.pluginManager.getPlugin("OpenVoxelWaterSurface");
    assert.equal(texturePlugin.neutralSurface, true);
    assert.equal(waterPlugin.runtime, library.waterSurfaceRuntime);
    assert.equal(waterPlugin.normalTexture, bank.normal);
    assert.match(waterPlugin.getCustomCode("vertex").CUSTOM_VERTEX_MAIN_END, /ovWaterCode = color\.a/u);
    assert.doesNotMatch(waterPlugin.getCustomCode("vertex").CUSTOM_VERTEX_MAIN_END, /positionUpdated/u);
    assert.match(waterPlugin.getCustomCode("fragment").CUSTOM_FRAGMENT_BEFORE_LIGHTS, /vPositionW\.xz/u);
    assert.match(waterPlugin.getCustomCode("fragment").CUSTOM_FRAGMENT_UPDATE_ALBEDO, /ovWaterDepth/u);
    assert.match(waterPlugin.getCustomCode("fragment").CUSTOM_FRAGMENT_BEFORE_LIGHTS, /ovWaveSpeed/u);
    assert.doesNotMatch(texturePlugin.getCustomCode("fragment").CUSTOM_FRAGMENT_UPDATE_ALBEDO, /ovAlbedoSampler/u);

    assert.equal(material.indexOfRefraction, 1.333);
    assert.equal(material.metallic, 0);
    assert.equal(material.roughness, 0.055);
    assert.equal(material.alpha, 0.52);
    assert.equal(material.forceIrradianceInFragment, true);
    assert.equal(material.useSpecularOverAlpha, true);
    assert.equal(material.useRadianceOverAlpha, true);
    assert.equal(material.useLinearAlphaFresnel, true);
    assert.equal(material.separateCullingPass, false);
    assert.equal(material.reflectionTexture, null, "PBR must inherit scene.environmentTexture instead of owning an RTT");

    assert.equal(library.animatedMaterials.length, 0, "water must not enter the 240 ms texture-frame scheduler");
    library.update(240);
    assert.equal(library.waterSurfaceRuntime.timeSeconds, 0.24);
    assert.equal(texturePlugin.animationLayerOffset, 0);
  } finally {
    library.dispose();
    assert.equal(library.waterSurfaceRuntime.plugins.size, 0);
    scene.dispose();
    engine.dispose();
  }
});

test("water pipelines reject non-fluid ownership and unresolved normal layers", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const {library} = waterLibrary(scene);
  try {
    library.textureBanks.get("test:fluid").role = "translucent";
    assert.throws(() => library.resolvePipeline(batch()), /translucent fluid texture bank/u);
    library.textureBanks.get("test:fluid").role = "fluid";
    library.textureDefinitions.get("test:water-flow").bankKey = "test:other";
    assert.throws(() => library.resolvePipeline(batch()), /one layer in its fluid texture bank/u);
  } finally {
    library.dispose();
    scene.dispose();
    engine.dispose();
  }
});
