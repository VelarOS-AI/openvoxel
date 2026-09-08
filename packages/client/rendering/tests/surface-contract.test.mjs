import assert from "node:assert/strict";
import test from "node:test";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Scene} from "@babylonjs/core/scene.js";
import {createSurfaceAdapter} from "../src/native/babylon/surface.mjs";
import {requireSurfaceOptions, validateChunkMesh} from "../src/native/babylon/surface-contract.mjs";
import {SurfaceLifetime} from "../src/native/babylon/surface-lifetime.mjs";
import {VoxelMaterialLibrary} from "../src/native/babylon/material-library.mjs";

function surfaceOptions() {
  return {
    edge: 16, targetX: 0, targetY: 64, targetZ: 0, horizontalChunkRadius: 5,
    navigationMode: "first-person", movementMode: "creative-flight",
    minimumWorldY: -64, maximumWorldY: 320, survivalEyeHeight: 1.62, survivalPlayerHeight: 1.8,
    materials: [], textures: [], animations: [],
    viewChanged: () => null, collisionAt: () => [], climateAt: () => ({}),
    textureBanks: [{key: "test:opaque", role: "opaque", storage: "texture_2d_array", layerCount: 1,
      levels: [{width: 1, height: 1, albedoData: "AAAAAA==", normalData: "AAAAAA==", materialData: "AAAAAA==", emissiveData: "AAAAAA=="}]}],
  };
}

test("invalid surface options fail before allocating an engine or changing the canvas", async () => {
  const previousCanvas = globalThis.HTMLCanvasElement;
  class FakeCanvas {
    constructor() { this.tabIndex = -1; this.contextRequests = 0; }
    getContext() { this.contextRequests += 1; throw new Error("Unexpected engine allocation"); }
  }
  globalThis.HTMLCanvasElement = FakeCanvas;
  const dependencies = Object.fromEntries(["createEnvironment", "createNavigation", "createFlightState", "createSurvivalState", "stepFlight", "stepSurvival"].map((name) => [name, () => null]));
  try {
    for (const [patch, expected] of [
      [{targetY: Number.NaN}, /Camera target y/],
      [{targetX: Number.POSITIVE_INFINITY}, /Camera target x/],
      [{minimumWorldY: 320}, /bounds are inverted/],
      [{survivalPlayerHeight: 1}, /dimensions are invalid/],
      [{horizontalChunkRadius: 9}, /Horizontal render Chunk radius/],
      [{navigationMode: "invalid"}, /navigation mode/],
      [{movementMode: "invalid"}, /movement mode/],
      [{collisionAt: null}, /collisionAt must be a function/],
      [{textureBanks: []}, /non-empty list/],
    ]) {
      const canvas = new FakeCanvas();
      await assert.rejects(createSurfaceAdapter(canvas, {...surfaceOptions(), ...patch}, dependencies), expected);
      assert.equal(canvas.contextRequests, 0);
      assert.equal(canvas.tabIndex, -1);
    }
  } finally {
    globalThis.HTMLCanvasElement = previousCanvas;
  }
});

test("surface normalization preserves callback identity without mutating its input", () => {
  const input = surfaceOptions();
  const checked = requireSurfaceOptions(input);
  assert.notEqual(checked, input);
  assert.equal(checked.climateAt, input.climateAt);
  assert.deepEqual(checked, input);
});

test("surface construction and release unwind all acquisitions once in reverse order", () => {
  const lifetime = new SurfaceLifetime();
  const disposed = [];
  for (const name of ["engine", "scene", "textures", "environment", "navigation", "render-loop"]) {
    lifetime.defer(() => {
      disposed.push(name);
      if (name === "navigation") throw new Error("navigation cleanup failed");
    });
  }
  assert.throws(() => lifetime.dispose(), (error) => error instanceof AggregateError && error.errors.length === 1);
  assert.deepEqual(disposed, ["render-loop", "navigation", "environment", "textures", "scene", "engine"]);
  lifetime.dispose();
  assert.equal(disposed.length, 6);
  assert.throws(() => lifetime.defer(() => null), /lifetime is disposed/);
});

function materialLibrary(animation = false) {
  const layer = animation ? "cutout" : "opaque";
  const textures = [{key: "test:first", bankKey: "test:bank", alphaCutoff: animation ? 0.5 : null, variants: [{layer: 0}]}];
  if (animation) textures.push({key: "test:next", bankKey: "test:bank", alphaCutoff: 0.5, variants: [{layer: 1}]});
  return new VoxelMaterialLibrary(null, {
    materials: [{key: "test:material", precipitationSurface: "solid", alphaCutoff: 0.5}],
    textures,
    animations: animation ? [{key: "test:animation", frames: ["test:first", "test:next"], frameDurationMs: 100}] : [],
  }, new Map([["test:bank", {role: layer, layerCount: textures.length}]]), null);
}

function batchFor(animation = false) {
  return {
    pipelineKey: (animation ? "cutout" : "opaque") + "|test:bank|test:material|" + (animation ? "test:animation" : "-"),
    layer: animation ? "cutout" : "opaque", bankKey: "test:bank", materialKey: "test:material", animationKey: animation ? "test:animation" : null,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    textureLayers: new Float32Array(4), tintRoles: new Float32Array(4), colors: new Float32Array(16).fill(1),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]), quadCount: 1,
  };
}

test("upload and material construction share one checked animation pipeline", () => {
  const library = materialLibrary(true);
  const batch = batchFor(true);
  const first = library.resolvePipeline(batch);
  assert.deepEqual(first.frames, [{layerOffset: 0}, {layerOffset: 1}]);
  assert.equal(first.animationBaseLayer, 0);
  assert.equal(library.resolvePipeline({...batch}), first);
  assert.equal(library.pipelines.size, 1);
  assert.throws(() => library.resolvePipeline({...batch, bankKey: "test:other"}), /pipeline key/);
  library.dispose();
  assert.equal(library.pipelines.size, 0);
});

test("invalid animation ownership fails before a PBR material can be allocated", () => {
  const library = materialLibrary(true);
  library.textureDefinitions.get("test:next").alphaCutoff = 0.25;
  assert.throws(() => library.materialFor(batchFor(true)), /different material alpha cutoff/);
  assert.equal(library.materials.size, 0);
  assert.equal(library.pipelines.size, 0);
});

test("a failed PBR construction cannot leave a material or animation in the live scene", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const library = materialLibrary(true);
  library.scene = scene;
  Object.defineProperty(library.materialDefinitions.get("test:material"), "environmentIntensity", {
    get() { throw new Error("material recipe failed"); },
  });
  try {
    const previousMaterials = scene.materials.length;
    assert.throws(() => library.materialFor(batchFor(true)), /material recipe failed/);
    assert.equal(scene.materials.length, previousMaterials);
    assert.equal(library.materials.size, 0);
    assert.equal(library.animatedMaterials.length, 0);
  } finally {
    library.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test("mesh validation preserves full-storage buffers and rejects invalid topology and ownership", () => {
  const library = materialLibrary();
  const batch = batchFor();
  const byteSize = [batch.positions, batch.normals, batch.uvs, batch.textureLayers, batch.tintRoles, batch.colors, batch.indices].reduce((sum, values) => sum + values.byteLength, 0);
  const chunk = {position: {x: 0, y: 4, z: -1}, ticket: 1, visibleBlocks: 1, quadCount: 1, byteSize, batches: [batch]};
  const checked = validateChunkMesh(chunk, 16, library);
  assert.equal(checked.key, "0:4:-1");
  assert.equal(checked.batches[0].positions, batch.positions);
  batch.tintRoles[1] = 2;
  assert.throws(() => validateChunkMesh(chunk, 16, library), /interpolates between climate tint roles/);
  batch.tintRoles[1] = 0;
  batch.indices[0] = 3;
  assert.throws(() => validateChunkMesh(chunk, 16, library), /canonical quad topology/);
  batch.indices[0] = 0;
  batch.textureLayers[0] = 1;
  assert.throws(() => validateChunkMesh(chunk, 16, library), /outside texture bank/);
});
