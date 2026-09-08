import assert from "node:assert/strict";
import test from "node:test";
import {
  createPrecipitationColumnField,
  precipitationColumnOffsets,
  precipitationViewHalfHeight,
  visiblePrecipitationColumns,
} from "../src/native/babylon/weather-columns.mjs";

test("precipitation columns form a bounded circular neighborhood", () => {
  const offsets = precipitationColumnOffsets(7);
  assert.ok(offsets.length > 100 && offsets.length < 200);
  assert.equal(new Set(offsets.map(({x, z}) => `${x}:${z}`)).size, offsets.length);
  assert.deepEqual(offsets[0], {x: 0, z: 0, distanceSquared: 0});
  assert.ok(offsets.every(({distanceSquared}) => distanceSquared <= 49));
});

test("visible columns cross eye height and retain the camera-facing field", () => {
  const center = {x: 0.5, y: 70, z: 0.5};
  const columns = [
    {x: 0, z: 0, groundY: 64, skyVisible: true},
    {x: 0, z: 4, groundY: 64, skyVisible: true},
    {x: 0, z: -4, groundY: 64, skyVisible: true},
    {x: 1, z: 2, groundY: 80, skyVisible: true},
    {x: -1, z: 2, groundY: 64, skyVisible: false},
  ];
  const visible = visiblePrecipitationColumns(columns, center, {x: 0, y: -0.9, z: 0.1});
  assert.deepEqual(visible.map(({x, z}) => [x, z]), [[0, 0], [0, 4]]);
  assert.equal(precipitationViewHalfHeight, 5);
});

test("ground queries are incrementally budgeted and preserve sky exposure", () => {
  let calls = 0;
  const groundAt = (x, z, originY) => {
    calls += 1;
    assert.equal(originY, 70);
    return x === 0 && z === 0 ? {groundY: 68, skyVisible: false} : {groundY: 64, skyVisible: true};
  };
  const field = createPrecipitationColumnField({radius: 3, sampleBudget: 4, refreshMilliseconds: 10_000});
  const center = {x: 0.5, y: 70, z: 0.5};
  let result = field.update(16, center, {x: 0, y: 0, z: 1}, null, groundAt);
  assert.equal(calls, 4);
  assert.equal(result.sampledColumns, 4);
  assert.ok(result.pendingColumns > 0);

  for (let index = 0; index < 20 && result.pendingColumns > 0; index += 1) {
    const before = calls;
    result = field.update(16, center, {x: 0, y: 0, z: 1}, null, groundAt);
    assert.ok(calls - before <= 4);
  }
  assert.equal(result.cachedColumns, result.maximumColumns);
  assert.equal(result.pendingColumns, 0);
  assert.ok(result.columns.every((column) => column.skyVisible));
  assert.ok(!result.columns.some((column) => column.x === 0 && column.z === 0));
});

test("teleporting cannot turn stale weather work into an unbounded frame spike", () => {
  let calls = 0;
  const groundAt = () => {
    calls += 1;
    return 60;
  };
  const field = createPrecipitationColumnField({radius: 7, sampleBudget: 6, refreshMilliseconds: 10_000});
  for (let step = 0; step < 12; step += 1) {
    const before = calls;
    const result = field.update(16, {x: step * 100, y: 70, z: 0}, {x: 1, y: 0, z: 0}, null, groundAt);
    assert.ok(calls - before <= 6);
    assert.ok(result.pendingColumns <= result.maximumColumns);
    assert.ok(result.cachedColumns <= result.maximumColumns);
  }
});

test("fresh callback wrappers do not discard an in-progress column cache", () => {
  let calls = 0;
  const field = createPrecipitationColumnField({radius: 3, sampleBudget: 3, refreshMilliseconds: 10_000});
  const center = {x: 0.5, y: 70, z: 0.5};
  const first = field.update(16, center, {x: 0, y: 0, z: 1}, null, () => {
    calls += 1;
    return 64;
  });
  const second = field.update(16, center, {x: 0, y: 0, z: 1}, null, () => {
    calls += 1;
    return 64;
  });
  assert.equal(calls, 6);
  assert.equal(first.cachedColumns, 3);
  assert.equal(second.cachedColumns, 6);
});

test("column field accepts fallback ground and validates callback results", () => {
  const field = createPrecipitationColumnField({radius: 1, sampleBudget: 16});
  const center = {x: 0.5, y: 70, z: 0.5};
  const fallback = field.update(16, center, {x: 0, y: 0, z: 0}, {x: 0, y: 64, z: 0}, null);
  assert.equal(fallback.cachedColumns, fallback.maximumColumns);
  assert.ok(fallback.columns.every((column) => column.groundY === 64));
  assert.throws(
    () => field.update(16, center, {x: 0, y: 0, z: 1}, null, () => ({groundY: Number.NaN})),
    /groundY must be finite/u,
  );
});

test("column samples preserve water surface identity for impact texture placement", () => {
  const field = createPrecipitationColumnField({radius: 1, sampleBudget: 16, refreshMilliseconds: 0});
  const center = {x: 0.5, y: 70, z: 0.5};
  const water = field.update(16, center, {x: 0, y: 0, z: 0}, null, () => ({groundY: 64, skyVisible: true, surface: "water"}));
  assert.ok(water.columns.every((column) => column.surface === "water"));
  assert.throws(
    () => field.update(16, center, {x: 0, y: 0, z: 0}, null, () => ({groundY: 64, surface: "unknown"})),
    /surface must be water or solid/u,
  );
});

test("changed Chunk columns immediately discard old samples and refill under the per-frame budget", () => {
  const field = createPrecipitationColumnField();
  const center = {x: 0.5, y: 70, z: 0.5};
  let height = 64;
  const calls = [];
  const groundAt = (x, z) => {
    calls.push({x, z});
    return x >= 0 && z >= 0 ? height : 64;
  };
  let result;
  for (let frame = 0; frame < 10; frame += 1) result = field.update(0, center, {x: 0, z: 0}, null, groundAt);
  const before = result.cachedColumns;
  height = 68;
  const invalidated = field.invalidateChunkColumn(0, 0, 16);
  assert.ok(invalidated.cachedColumns < before);
  assert.ok(invalidated.pendingColumns > 16 && invalidated.pendingColumns <= 149);
  field.invalidateChunkColumn(0, 0, 16);
  calls.length = 0;
  result = field.update(0, center, {x: 0, z: 0}, null, groundAt);
  assert.equal(calls.length, 16);
  assert.ok(calls.every(({x, z}) => x >= 0 && z >= 0));
  assert.ok(result.columns.every((column) => column.groundY === (column.x >= 0 && column.z >= 0 ? 68 : 64)));
  while (result.pendingColumns > 0) {
    calls.length = 0;
    result = field.update(0, center, {x: 0, z: 0}, null, groundAt);
    assert.ok(calls.length <= 16);
  }
  assert.equal(result.cachedColumns, 149);
  field.invalidateChunkColumn(20, 20, 16);
  calls.length = 0;
  field.update(0, center, {x: 0, z: 0}, null, groundAt);
  assert.equal(calls.length, 0);
});

test("Chunk invalidation uses floor coordinates on the negative side of each boundary", () => {
  const field = createPrecipitationColumnField({radius: 2});
  const center = {x: -0.5, y: 70, z: -0.5};
  let changed = false;
  const groundAt = (x, z) => changed && x < 0 && z < 0 ? 66 : 64;
  field.update(0, center, {x: 0, z: 0}, null, groundAt);
  changed = true;
  field.invalidateChunkColumn(-1, -1, 16);
  const result = field.update(0, center, {x: 0, z: 0}, null, groundAt);
  assert.ok(result.columns.every((column) => column.groundY === (column.x < 0 && column.z < 0 ? 66 : 64)));
  assert.throws(() => field.invalidateChunkColumn(0.5, 0, 16), /integer Chunk/u);
  assert.throws(() => field.invalidateChunkColumn(0, 0, 0), /positive integer/u);
});
