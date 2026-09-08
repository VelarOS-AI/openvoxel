import assert from "node:assert/strict";
import test from "node:test";
import {BabylonVoxelSurface} from "../src/native/babylon/surface.mjs";
import {SurfaceLifetime} from "../src/native/babylon/surface-lifetime.mjs";

function emptyChunk(x, y, z, ticket = 1) {
  return {position: {x, y, z}, ticket, visibleBlocks: 0, quadCount: 0, byteSize: 0, batches: []};
}

test("surface invalidates ground immediately and coalesces weather work across vertical-section load and unload bursts", () => {
  const previousResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  let disconnected = false;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() { disconnected = true; }
  };
  const events = [];
  const updates = [];
  let renderLoop;
  let renderedFrames = 0;
  let surface;
  const engine = {
    runRenderLoop(callback) { renderLoop = callback; },
    stopRenderLoop() {},
    getDeltaTime: () => 16,
    resize() {},
  };
  const environment = {
    invalidateTerrainColumn(x, z) {
      events.push({kind: "weather", x, z, chunks: [...surface.chunks.keys()]});
    },
    update(...args) { updates.push(args); },
  };
  try {
    surface = new BabylonVoxelSurface({}, {
      edge: 16,
      minimumWorldY: 0,
      maximumWorldY: 255,
      climateAt: () => ({}),
      environmentFrame: {worldMilliseconds: 0},
      materials: [],
      textures: [],
      animations: [],
    }, engine, {render() { renderedFrames += 1; }}, {
      globalPosition: {x: -0.5, y: 70, z: 0.5},
    }, {update() {}}, new Map(), environment, new SurfaceLifetime());
    const invalidateColumn = surface.terrainGroundProbe.invalidateColumn;
    surface.terrainGroundProbe.invalidateColumn = (x, z) => {
      events.push({kind: "terrain", x, z, chunks: [...surface.chunks.keys()]});
      invalidateColumn(x, z);
    };
    surface.terrainGroundProbe.sample = () => {
      throw new Error("Weather must not scan every resident mesh under the player each frame");
    };
    const terrainEvent = (chunks) => ({kind: "terrain", x: -1, z: 0, chunks});
    const weatherEvent = (chunks) => ({kind: "weather", x: -1, z: 0, chunks});

    surface.setChunkMesh(emptyChunk(-1, 4, 0));
    assert.deepEqual(events.splice(0), [terrainEvent(["-1:4:0"])]);
    surface.setChunkMesh(emptyChunk(-1, 4, 0, 2));
    assert.deepEqual(events.splice(0), [terrainEvent(["-1:4:0"])]);
    surface.setChunkMesh(emptyChunk(-1, 5, 0));
    assert.deepEqual(events.splice(0), [terrainEvent(["-1:4:0", "-1:5:0"])]);
    surface.removeChunk(-1, 5, 0);
    assert.deepEqual(events.splice(0), [terrainEvent(["-1:4:0"])]);
    surface.removeChunk(-1, 99, 0);
    assert.deepEqual(events.splice(0), []);
    assert.throws(() => surface.setChunkMesh({...emptyChunk(-1, 4, 0), byteSize: 1}), /byte size/u);
    assert.deepEqual(events.splice(0), []);
    assert.equal(surface.chunks.size, 1);

    renderLoop();
    renderLoop();
    assert.deepEqual(events.splice(0), [weatherEvent(["-1:4:0"])]);
    assert.equal(renderedFrames, 2);
    assert.equal(updates.length, 2);
    for (const [delta, center, fallbackGround, groundAt] of updates) {
      assert.equal(delta, 16);
      assert.equal(center, surface.camera.globalPosition);
      assert.equal(fallbackGround, null);
      assert.equal(groundAt, surface.weatherGroundAt);
      assert.equal(groundAt(-1, 0), null);
    }
    surface.removeChunk(-1, 4, 0);
    assert.deepEqual(events.splice(0), [terrainEvent([])]);
    renderLoop();
    renderLoop();
    assert.deepEqual(events.splice(0), [weatherEvent([])]);
    surface.release();
    assert.deepEqual(events.splice(0), []);
    assert.equal(disconnected, true);
    assert.equal(surface.terrainGroundProbe.stats().cachedColumns, 0);
    surface.release();
    assert.deepEqual(events, []);
  } finally {
    surface?.release();
    if (previousResizeObserver === undefined) delete globalThis.ResizeObserver;
    else Object.defineProperty(globalThis, "ResizeObserver", previousResizeObserver);
  }
});
