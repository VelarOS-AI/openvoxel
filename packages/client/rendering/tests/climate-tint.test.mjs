import assert from "node:assert/strict";
import test from "node:test";
import {ClimateTintField, climateTintVector} from "../src/native/babylon/climate-tint.mjs";

test("climate tint carries local temperature and humidity with seasonal foliage and winter dormancy", () => {
  const summer = climateTintVector({temperatureCelsius: 24, humidity: 0.8, yearProgress: 0.375});
  const autumn = climateTintVector({temperatureCelsius: 12, humidity: 0.8, yearProgress: 0.65});
  const winter = climateTintVector({temperatureCelsius: -12, humidity: 0.8, yearProgress: 0.9});
  assert.deepEqual(summer, [24, 0.8, 0, 0]);
  assert.ok(autumn[2] > 0.95);
  assert.equal(winter[3], 1);
  assert.equal(winter[2], 0);
});

test("adjacent horizontal and vertical chunks share exact climate corners without per-frame resampling", () => {
  let sampled = 0;
  const field = new ClimateTintField(16, (time, x, y, z) => {
    sampled += 1;
    return {temperatureCelsius: 20 - y / 10 + x / 100 + time / 100_000, humidity: (z + 128) / 256, yearProgress: 0.4};
  });
  field.setTime(1000);
  const first = field.forPosition({x: 0, y: 0, z: 0});
  assert.equal(sampled, 8);
  assert.equal(field.forPosition({x: 0, y: 0, z: 0}), first);
  field.setTime(14_999);
  assert.equal(field.forPosition({x: 0, y: 0, z: 0}), first);
  assert.equal(sampled, 8);
  const east = field.forPosition({x: 16, y: 0, z: 0});
  const above = field.forPosition({x: 0, y: 16, z: 0});
  assert.equal(sampled, 16);
  for (const corner of [0, 2, 4, 6]) assert.equal(first.corners[corner + 1], east.corners[corner]);
  for (let corner = 0; corner < 4; corner += 1) assert.equal(first.corners[corner + 4], above.corners[corner]);
  field.setTime(15_000);
  const updated = field.forPosition({x: 0, y: 0, z: 0});
  assert.notEqual(updated, first);
  assert.ok(updated.corners[0][0] > first.corners[0][0]);
});

test("long-distance climate sampling has a fixed cache bound and supports negative coordinates", () => {
  const field = new ClimateTintField(16, () => ({temperatureCelsius: 20, humidity: 0.6, yearProgress: 0.4}));
  field.setTime(0);
  assert.deepEqual(field.forPosition({x: -16, y: -32, z: -48}).bounds, [-16, -32, -48, 16]);
  for (let index = 0; index < 2000; index += 1) field.forPosition({x: index * 32, y: 0, z: 0});
  assert.ok(field.nodes.size <= 4096);
  assert.ok(field.chunks.size <= 1024);
  field.clear();
  assert.equal(field.nodes.size, 0);
  assert.equal(field.chunks.size, 0);
});
