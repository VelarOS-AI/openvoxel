import assert from "node:assert/strict";
import test from "node:test";
import {createTerrainGroundProbe, terrainColumnKey} from "../src/native/babylon/terrain-ground.mjs";
import {createPrecipitationColumnField} from "../src/native/babylon/weather-columns.mjs";

function mesh({enabled = true, visible = true} = {}) {
  return {isEnabled: () => enabled, isVisible: visible};
}

test("terrain ground probing only accepts live meshes owned by the voxel surface", () => {
  const sky = mesh();
  const weather = mesh();
  const hiddenTerrain = mesh({visible: false});
  const terrain = mesh();
  const candidates = [sky, weather, hiddenTerrain, terrain];
  let calls = 0;
  const intersections = (ray, meshes) => {
    calls += 1;
    assert.deepEqual({x: ray.origin.x, y: ray.origin.y, z: ray.origin.z}, {x: 3, y: 20, z: 5});
    assert.deepEqual({x: ray.direction.x, y: ray.direction.y, z: ray.direction.z}, {x: 0, y: -1, z: 0});
    assert.equal(ray.length, 512);
    assert.deepEqual(meshes, [terrain]);
    return [{hit: true, pickedMesh: terrain, pickedPoint: {x: 3, y: 7, z: 5}}];
  };
  const probe = createTerrainGroundProbe(new Set([hiddenTerrain, terrain]), 512, {intersections});
  assert.deepEqual(probe.sample({x: 3, y: 20, z: 5}, 16), {x: 3, y: 7, z: 5});
  assert.equal(calls, 1);
});

test("terrain ground probing caches nearby columns and invalidates for mesh changes", () => {
  const terrain = mesh();
  let calls = 0;
  let hit = true;
  const intersections = (_ray, meshes) => {
    calls += 1;
    assert.deepEqual(meshes, [terrain]);
    return hit
      ? [{hit: true, pickedMesh: terrain, pickedPoint: {x: 0, y: 4, z: 0}}]
      : [];
  };
  const probe = createTerrainGroundProbe(new Set([terrain]), 256, {intersections});
  assert.deepEqual(probe.sample({x: 0, y: 30, z: 0}, 16), {x: 0, y: 4, z: 0});
  assert.deepEqual(probe.sample({x: 0.2, y: 60, z: 0.2}, 100), {x: 0.2, y: 4, z: 0.2});
  assert.equal(calls, 1, "sub-block motion must not raycast every render frame");

  hit = false;
  assert.equal(probe.sample({x: 0.8, y: 60, z: 0}, 100), null);
  assert.equal(calls, 2);
  hit = true;
  probe.invalidate();
  for (let frame = 0; frame < 4; frame += 1) {
    probe.invalidate();
    assert.equal(probe.sample({x: 0.8, y: 60, z: 0}, 16), null);
  }
  assert.equal(calls, 2, "continuous Chunk invalidation must not raycast every render frame");
  probe.invalidate();
  assert.deepEqual(probe.sample({x: 0.8, y: 60, z: 0}, 16), {x: 0.8, y: 4, z: 0});
  assert.equal(calls, 3, "invalidated terrain must refresh after one bounded throttle period");
});

test("precipitation ground probing only visits the matching horizontal Chunk column", () => {
  const matching = {...mesh(), position: {x: 16, y: 0, z: -16}};
  const otherX = {...mesh(), position: {x: 32, y: 0, z: -16}};
  const otherZ = {...mesh(), position: {x: 16, y: 0, z: 0}};
  const candidates = [matching, otherX, otherZ];
  const columns = new Map([
    [terrainColumnKey(1, -1), new Set([matching])],
    [terrainColumnKey(2, -1), new Set([otherX])],
    [terrainColumnKey(1, 0), new Set([otherZ])],
  ]);
  const intersections = (ray, meshes) => {
    assert.deepEqual({x: ray.origin.x, y: ray.origin.y, z: ray.origin.z}, {x: 18.5, y: 271, z: -11.5});
    assert.equal(ray.length, 288);
    assert.deepEqual(meshes, [matching]);
    return [{hit: true, pickedMesh: matching, pickedPoint: {x: 18.5, y: 82, z: -11.5}}];
  };
  const probe = createTerrainGroundProbe(new Set(candidates), 288, {
    chunkEdge: 16,
    terrainColumns: columns,
    intersections,
  });

  assert.deepEqual(probe.sampleColumn(18, -12, 271), {groundY: 82, skyVisible: true, surface: "solid"});
  assert.throws(() => probe.sampleColumn(18.5, -12, 271), /must be integers/u);
});

test("precipitation uses the highest hit's authored surface, not transparency or block identity", () => {
  const terrain = {...mesh(), precipitationSurface: "solid"};
  const water = {...mesh(), precipitationSurface: "water"};
  const ice = {...mesh(), precipitationSurface: "solid"};
  let hits = [
    {hit: true, pickedMesh: terrain, pickedPoint: {y: 50}},
    {hit: true, pickedMesh: water, pickedPoint: {y: 54}},
  ];
  const probe = createTerrainGroundProbe(new Set([terrain, water, ice]), 512, {intersections: () => hits});
  assert.deepEqual(probe.sampleColumn(0, 0, 271), {groundY: 54, skyVisible: true, surface: "water"});
  hits = [...hits, {hit: true, pickedMesh: ice, pickedPoint: {y: 55}}];
  assert.deepEqual(probe.sampleColumn(0, 0, 271), {groundY: 55, skyVisible: true, surface: "solid"});
  hits = [];
  assert.equal(probe.sampleColumn(0, 0, 271), null);
});

test("decorative cross geometry does not intercept precipitation", () => {
  const ground = {...mesh(), precipitationSurface: "solid"};
  const flower = {...mesh(), precipitationSurface: "none"};
  const probe = createTerrainGroundProbe(new Set([ground, flower]), 512, {
    intersections: (_ray, candidates) => {
      assert.deepEqual(candidates, [ground]);
      return [{hit: true, pickedMesh: ground, pickedPoint: {y: 64}}];
    },
  });
  assert.deepEqual(probe.sampleColumn(0, 0, 271), {groundY: 64, skyVisible: true, surface: "solid"});
});

test("indexed ground samples reuse exact XZ hits, no-hit results and the column candidate list", () => {
  const ground = {...mesh(), precipitationSurface: "solid"};
  const candidates = [];
  const probe = createTerrainGroundProbe(new Set([ground]), 512, {
    chunkEdge: 16,
    terrainColumns: new Map([["0:0", new Set([ground])]]),
    intersections: (ray, meshes) => {
      candidates.push(meshes);
      return ray.origin.x > 2 ? [] : [{hit: true, pickedMesh: ground, pickedPoint: {y: 64}}];
    },
  });
  const first = probe.sampleColumn(0, 0, 271);
  assert.equal(probe.sampleColumn(0, 0, 271), first);
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(probe.sampleColumn(1, 0, 271), first);
  assert.equal(candidates[0], candidates[1]);
  assert.equal(probe.sampleColumn(2, 0, 271), null);
  assert.equal(probe.sampleColumn(2, 0, 271), null);
  assert.deepEqual(probe.stats(), {cachedColumns: 1, cachedSamples: 3, columnRaycasts: 3, columnCacheHits: 2, candidateBuilds: 1});
});

test("ground sample cache separates world-top and lower origins without accumulating origin variants", () => {
  const ground = mesh();
  const probe = createTerrainGroundProbe(new Set([ground]), 512, {
    chunkEdge: 16,
    terrainColumns: new Map([["0:0", new Set([ground])]]),
    intersections: (ray) => [{hit: true, pickedMesh: ground, pickedPoint: {y: ray.origin.y > 100 ? 120 : 50}}],
  });
  assert.equal(probe.sampleColumn(0, 0, 271).groundY, 120);
  assert.equal(probe.sampleColumn(0, 0, 80).groundY, 50);
  assert.equal(probe.sampleColumn(0, 0, 271).groundY, 120);
  assert.equal(probe.stats().cachedSamples, 1);
  assert.equal(probe.stats().candidateBuilds, 1);
  assert.equal(probe.stats().columnRaycasts, 3);
});

test("column invalidation replaces water with ice and preserves unrelated cached terrain", () => {
  const water = {...mesh(), precipitationSurface: "water"};
  const other = {...mesh(), precipitationSurface: "solid"};
  const owners = new Set([water, other]);
  const columns = new Map([["-1:-1", new Set([water])], ["0:0", new Set([other])]]);
  const probe = createTerrainGroundProbe(owners, 512, {
    chunkEdge: 16,
    terrainColumns: columns,
    intersections: (_ray, candidates) => candidates.map((pickedMesh) => ({hit: true, pickedMesh, pickedPoint: {y: 64}})),
  });
  assert.equal(probe.sampleColumn(-1, -1, 271).surface, "water");
  const unrelated = probe.sampleColumn(0, 0, 271);
  water.precipitationSurface = "solid";
  probe.invalidateColumn(-1, -1);
  assert.equal(probe.sampleColumn(-1, -1, 271).surface, "solid");
  assert.equal(probe.sampleColumn(0, 0, 271), unrelated);
  assert.equal(probe.stats().columnRaycasts, 3);
  assert.equal(probe.stats().cachedColumns, 2);
  assert.throws(() => probe.invalidateColumn(0.5, 0), /integer Chunk/u);
});

test("unloading the highest vertical Chunk reveals the next surface and ignores decorative geometry", () => {
  const water = {...mesh(), precipitationSurface: "water", height: 63.9375};
  const roof = {...mesh(), precipitationSurface: "solid", height: 82.125};
  const flowers = {...mesh(), precipitationSurface: "none", height: 84};
  const owners = new Set([water, roof, flowers]);
  const vertical = new Set(owners);
  const columns = new Map([["-2:-1", vertical]]);
  const probe = createTerrainGroundProbe(owners, 512, {
    chunkEdge: 16,
    terrainColumns: columns,
    intersections: (_ray, candidates) => candidates.map((pickedMesh) => ({hit: true, pickedMesh, pickedPoint: {y: pickedMesh.height}})),
  });
  assert.equal(probe.sampleColumn(-17, -16, 271).groundY, 82.125);
  owners.delete(roof);
  vertical.delete(roof);
  probe.invalidateColumn(-2, -1);
  assert.deepEqual(probe.sampleColumn(-17, -16, 271), {groundY: 63.9375, skyVisible: true, surface: "water"});
  columns.delete("-2:-1");
  probe.invalidateColumn(-2, -1);
  assert.equal(probe.sampleColumn(-17, -16, 271), null);
  assert.equal(probe.stats().cachedColumns, 0);
});

test("missing terrain does not accumulate cache buckets and becomes queryable when loaded", () => {
  const owners = new Set();
  const columns = new Map();
  const probe = createTerrainGroundProbe(owners, 512, {
    chunkEdge: 16,
    terrainColumns: columns,
    intersections: (_ray, candidates) => candidates.map((pickedMesh) => ({hit: true, pickedMesh, pickedPoint: {y: 64}})),
  });
  for (let index = 0; index < 1_000; index += 1) assert.equal(probe.sampleColumn(index * 16, -16, 271), null);
  assert.equal(probe.stats().cachedColumns, 0);
  const loaded = mesh();
  owners.add(loaded);
  columns.set("0:-1", new Set([loaded]));
  probe.invalidateColumn(0, -1);
  assert.equal(probe.sampleColumn(0, -16, 271).groundY, 64);
  assert.equal(probe.stats().columnRaycasts, 1);
});

test("long-distance movement keeps ground cache capacity tied to live horizontal columns", () => {
  const owners = new Set();
  const columns = new Map();
  const probe = createTerrainGroundProbe(owners, 512, {
    chunkEdge: 16,
    terrainColumns: columns,
    intersections: (_ray, candidates) => candidates.map((pickedMesh) => ({hit: true, pickedMesh, pickedPoint: {y: 64}})),
  });
  for (let step = 0; step < 40; step += 1) {
    const terrain = mesh();
    owners.add(terrain);
    columns.set(terrainColumnKey(step, 0), new Set([terrain]));
    probe.invalidateColumn(step, 0);
    if (step >= 3) {
      const stale = terrainColumnKey(step - 3, 0);
      for (const value of columns.get(stale)) owners.delete(value);
      columns.delete(stale);
      probe.invalidateColumn(step - 3, 0);
    }
    for (let z = 0; z < 16; z += 1) {
      for (let x = 0; x < 16; x += 1) probe.sampleColumn(step * 16 + x, z, 271);
    }
    assert.ok(probe.stats().cachedColumns <= 3);
    assert.ok(probe.stats().cachedSamples <= 3 * 16 * 16);
  }
});

test("weather TTL refreshes reuse unchanged terrain and resample only an invalidated column", () => {
  const owners = new Set();
  const columns = new Map();
  for (const x of [-1, 0]) {
    for (const z of [-1, 0]) {
      const terrain = {...mesh(), height: 64};
      owners.add(terrain);
      columns.set(terrainColumnKey(x, z), new Set([terrain]));
    }
  }
  const probe = createTerrainGroundProbe(owners, 512, {
    chunkEdge: 16,
    terrainColumns: columns,
    intersections: (_ray, candidates) => candidates.map((pickedMesh) => ({hit: true, pickedMesh, pickedPoint: {y: pickedMesh.height}})),
  });
  const field = createPrecipitationColumnField({radius: 2});
  const center = {x: 0.5, y: 70, z: 0.5};
  const groundAt = (x, z) => probe.sampleColumn(x, z, 271);
  let result = field.update(0, center, {x: 0, z: 0}, null, groundAt);
  const initialCalls = probe.stats().columnRaycasts;
  for (let index = 0; index < 10; index += 1) result = field.update(1_000, center, {x: 0, z: 0}, null, groundAt);
  assert.equal(probe.stats().columnRaycasts, initialCalls);
  const affected = result.columns.filter((column) => column.x >= 0 && column.z >= 0).length;
  for (const terrain of columns.get("0:0")) terrain.height = 68;
  probe.invalidateColumn(0, 0);
  field.invalidateChunkColumn(0, 0, 16);
  result = field.update(0, center, {x: 0, z: 0}, null, groundAt);
  assert.equal(probe.stats().columnRaycasts, initialCalls + affected);
  assert.ok(result.columns.every((column) => column.groundY === (column.x >= 0 && column.z >= 0 ? 68 : 64)));
});
