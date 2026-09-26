import assert from "node:assert/strict";
import test from "node:test";
import {createVoxelLightField} from "../src/native/voxel-lighting.mjs";

const states = [
  {runtimeId: 0, opacity: 0, emission: 0, passesSkylight: true},
  {runtimeId: 1, opacity: 15, emission: 0, passesSkylight: false},
  {runtimeId: 2, opacity: 0, emission: 14, passesSkylight: true},
  {runtimeId: 3, opacity: 2, emission: 0, passesSkylight: false},
];
const edge = 16;
const chunk = (x = 0, y = 0, z = 0) => ({position: {x, y, z}, blocks: new Uint32Array(edge ** 3)});
const set = (c, x, y, z, value) => { c.blocks[x + edge * (z + edge * y)] = value; };
const sample = (result, c, x, y, z) => {
  const data = result.chunks.find(item => Object.keys(c.position).every(axis => item.position[axis] === c.position[axis])).data;
  const start = ((x + 1) + 18 * ((y + 1) + 18 * (z + 1))) * 4;
  return [...data.slice(start, start + 3)].map(value => value / 17);
};
const roof = (c, y) => { for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) set(c, x, y, z, 1); };

test("cosmetic crop changes reuse settled light, while the next optical change still propagates", () => {
  const field = createVoxelLightField(edge, [...states, {...states[0], runtimeId: 4}]);
  const c = chunk();
  roof(c, 10);
  const initial = field.solve([c], []);
  set(c, 8, 5, 8, 4);
  const cosmetic = field.solve([c], []);
  assert.deepEqual(cosmetic.chunks, []);
  assert.equal(cosmetic.sources, initial.sources, "no source selection or light upload needed");
  set(c, 8, 5, 8, 2);
  const glowing = field.solve([c], []);
  assert.equal(sample(glowing, c, 8, 5, 8)[2], 14);
  assert.equal(glowing.sources.length, 1);
});

test("opaque ceilings block direct and ambient sky; openings admit decaying skylight", () => {
  const field = createVoxelLightField(edge, states), c = chunk();
  roof(c, 10);
  let result = field.solve([c], []);
  assert.deepEqual(sample(result, c, 8, 11, 8), [15, 15, 0]);
  assert.deepEqual(sample(result, c, 8, 9, 8), [0, 0, 0]);
  set(c, 8, 10, 8, 0);
  result = field.solve([c], []);
  assert.equal(sample(result, c, 8, 5, 8)[1], 15);
  assert.equal(sample(result, c, 9, 5, 8)[0], 0);
  assert.ok(sample(result, c, 9, 5, 8)[1] > sample(result, c, 14, 5, 8)[1]);
});

test("local emission crosses chunk seams, respects walls, and removal clears old light", () => {
  const field = createVoxelLightField(edge, states), a = chunk(), b = chunk(1);
  roof(a, 10); roof(b, 10);
  set(a, 15, 4, 8, 2);
  let result = field.solve([a, b], []);
  assert.equal(sample(result, a, 15, 4, 8)[2], 14);
  assert.equal(sample(result, b, 0, 4, 8)[2], 13);
  assert.deepEqual(sample(result, a, 16, 4, 8), sample(result, b, 0, 4, 8));
  for (let z = 0; z < 16; z++) for (let y = 0; y < 10; y++) set(b, 1, y, z, 1);
  result = field.solve([b], []);
  assert.equal(sample(result, b, 2, 4, 8)[2], 0, "a full wall blocks the source");
  set(a, 15, 4, 8, 0);
  result = field.solve([a], []);
  assert.equal(sample(result, b, 0, 4, 8)[2], 0);
  assert.equal(result.sources.length, 0);
  assert.equal(field.solve([], []).chunks.length, 0, "unchanged fields do not request GPU uploads");
});

test("diffusing blocks attenuate sunlight and unknown boundaries contribute no light", () => {
  const field = createVoxelLightField(edge, states), c = chunk();
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) set(c, x, 10, z, 3);
  const result = field.solve([c], []);
  assert.equal(sample(result, c, 8, 9, 8)[0], 13);
  assert.deepEqual(sample(result, c, -1, 9, 8), [0, 0, 0]);
});

test("descending past an unloaded roof cannot turn a cave into open sky", () => {
  const field = createVoxelLightField(edge, states), lower = chunk(), upper = chunk(0, 1);
  roof(upper, 2);
  const first = field.solve([lower, upper], []);
  assert.equal(sample(first, lower, 8, 15, 8)[1], 0);
  const retired = field.solve([], [upper.position]);
  // Removing a dark halo may leave the lower payload byte-identical.
  const changedLower = retired.chunks.find(item => item.position.y === 0);
  if (changedLower) assert.equal(sample(retired, lower, 8, 15, 8)[1], 0);
  roof(upper, 2); upper.blocks.fill(0);
  const opened = field.solve([upper], []);
  assert.equal(sample(opened, lower, 8, 15, 8)[1], 15);
});

test("bounded recomputation matches a fresh full solve after sources and skylight occluders change", () => {
  const chunks = [];
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    const c = chunk(x, 0, z);
    roof(c, 12);
    if ((x + z) % 2 === 0) set(c, 0, 12, 0, 0);
    chunks.push(c);
  }
  const field = createVoxelLightField(edge, states), retained = new Map();
  const keep = result => { for (const c of result.chunks) retained.set(JSON.stringify(c.position), c.data); };
  keep(field.solve(chunks, []));
  const center = chunks.find(c => c.position.x === 0 && c.position.z === 0);
  for (const [x, y, z, state] of [[15, 6, 15, 2], [0, 12, 0, 1], [15, 6, 15, 0], [15, 12, 15, 0]]) {
    set(center, x, y, z, state);
    keep(field.solve([center], []));
    const reference = createVoxelLightField(edge, states).solve(chunks, []);
    for (const c of reference.chunks) assert.deepEqual(retained.get(JSON.stringify(c.position)), c.data, `stale boundary at ${JSON.stringify(c.position)}`);
  }
});
