import assert from "node:assert/strict";
import test from "node:test";
import {ClimateTintField, climateTintColor, climateTintRoles, climateTintVector} from "../src/backends/babylon/native/climate-tint.mjs";

test("climate tint carries local temperature humidity season and elevation", () => {
  assert.deepEqual(climateTintVector({temperatureCelsius: 24, humidity: 0.8, yearProgress: 0.375}, 96), [24, 0.8, 0.375, 96]);
  assert.deepEqual(climateTintVector({temperatureCelsius: -12, humidity: 2, yearProgress: 1.1}, -32), [-12, 1, 0.10000000000000009, -32]);
});

const distance = (left, right) => left.reduce((total, value, index) => total + Math.abs(value - right[index]), 0);

test("ground grass, grass blades and crowns retain natural brightness and distinct greens", () => {
  for (const season of [0.125, 0.375]) {
    const climate = [24, 0.9, season, 64];
    const ground = climateTintColor(1, climate);
    const blades = climateTintColor(1, climate, undefined, true);
    const leaves = climateTintColor(2, climate);
    assert.ok(ground[1] > 0.76 && ground[1] < 0.86 && ground[1] - ground[0] < 0.4, "ground keeps lively midtones without approaching fluorescent pure green");
    assert.ok(blades[1] > ground[1] + 0.035, "blades remain distinguishable against the ground");
    assert.ok(leaves[1] > 0.70 && leaves[1] < ground[1] && leaves[0] / leaves[1] < ground[0] / ground[1], "crowns keep visible midtones and a deeper green than the meadow ground");
  }
});

test("birch and poplar have independent climate palettes and golden autumn foliage", () => {
  const roles = [climateTintRoles.deciduousFoliage, climateTintRoles.birchFoliage, climateTintRoles.poplarFoliage];
  const summer = roles.map(role => climateTintColor(role, [18, 0.65, 0.375, 72]));
  assert.ok(distance(summer[0], summer[1]) > 0.1);
  assert.ok(distance(summer[1], summer[2]) > 0.03);
  for (const role of roles.slice(1)) {
    const autumn = climateTintColor(role, [18, 0.65, 0.625, 72]);
    assert.ok(autumn[0] > autumn[1] && autumn[1] > autumn[2] * 2);
    for (const boundary of [0.125, 0.375, 0.625, 0.875]) {
      assert.ok(distance(climateTintColor(role, [18, 0.65, boundary - 0.000001, 72]), climateTintColor(role, [18, 0.65, boundary + 0.000001, 72])) < 0.00001);
    }
  }
});

test("deciduous foliage has a stronger four-season cycle than evergreen foliage", () => {
  const summer = [18, 0.65, 0.375, 72];
  const autumn = [18, 0.65, 0.625, 72];
  const winter = [18, 0.65, 0.875, 72];
  const deciduousSummer = climateTintColor(climateTintRoles.deciduousFoliage, summer);
  const deciduousAutumn = climateTintColor(climateTintRoles.deciduousFoliage, autumn);
  const deciduousWinter = climateTintColor(climateTintRoles.deciduousFoliage, winter);
  const evergreenSummer = climateTintColor(climateTintRoles.evergreenFoliage, summer);
  const evergreenAutumn = climateTintColor(climateTintRoles.evergreenFoliage, autumn);
  const evergreenWinter = climateTintColor(climateTintRoles.evergreenFoliage, winter);
  assert.ok(deciduousSummer[1] > deciduousSummer[0] + 0.2, "summer midpoint must remain green");
  assert.ok(deciduousAutumn[0] > deciduousAutumn[1] + 0.2, "deciduous autumn must become visibly warm");
  assert.ok(distance(deciduousSummer, deciduousWinter) > distance(evergreenSummer, evergreenWinter) * 1.5);
  assert.ok(evergreenAutumn[1] > evergreenAutumn[0], "evergreen autumn must remain green");
});

test("grass responds continuously to moisture elevation and all four seasons", () => {
  const wetLowland = climateTintColor(climateTintRoles.grass, [24, 0.9, 0.375, 24]);
  const dryLowland = climateTintColor(climateTintRoles.grass, [24, 0.1, 0.375, 24]);
  const wetHighland = climateTintColor(climateTintRoles.grass, [-6, 0.9, 0.375, 196]);
  assert.ok(wetLowland[1] - wetLowland[0] > dryLowland[1] - dryLowland[0]);
  assert.ok(dryLowland[0] > wetLowland[0]);
  assert.ok(distance(wetLowland, wetHighland) > 0.05);
  assert.deepEqual(wetLowland, climateTintColor(climateTintRoles.grass, [24, 0.9, 0.375, 196]), "elevation is already applied by the shared climate sampler");
  const seasons = [0.125, 0.375, 0.625, 0.875].map((year) => climateTintColor(climateTintRoles.grass, [18, 0.6, year, 64]));
  assert.equal(new Set(seasons.map((color) => color.map((channel) => channel.toFixed(3)).join(":"))).size, 4);
});

test("season interpolation is continuous across quarter and year boundaries", () => {
  const color = (year) => climateTintColor(climateTintRoles.deciduousFoliage, [16, 0.6, year, 80]);
  for (const boundary of [0.125, 0.375, 0.625, 0.875]) assert.ok(distance(color(boundary - 0.000001), color(boundary + 0.000001)) < 0.00001);
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
  const previous = first.corners[0][0];
  assert.equal(updated, first, "a time boundary keeps the current uniforms usable without resampling in a draw");
  assert.equal(sampled, 16);
  field.update(1, 1, () => 0);
  assert.equal(sampled, 17, "one frame processes at most its node budget");
  assert.ok(updated.corners[0][0] > previous);
  while (field.pending) field.update(3, 1, () => 0);
  assert.equal(sampled, 32, "shared nodes refresh only once");
  for (const corner of [0, 2, 4, 6]) assert.equal(first.corners[corner + 1], east.corners[corner]);
  for (let corner = 0; corner < 4; corner += 1) assert.equal(first.corners[corner + 4], above.corners[corner]);
});

test("climate refresh obeys elapsed budget and a newer time supersedes pending work", () => {
  let sampled = 0;
  const field = new ClimateTintField(16, time => {
    sampled++;
    return {temperatureCelsius: time / 1000, humidity: 0.6, yearProgress: 0.4};
  });
  field.setTime(0);
  const first = field.forPosition({x: 0, y: 0, z: 0});
  field.setTime(15_000);
  let clock = 0;
  field.update(32, 0.75, () => clock++);
  assert.equal(sampled, 9, "time budget stops work even when node allowance remains");
  field.setTime(30_000);
  while (field.pending) field.update(3, 1, () => 0);
  assert.ok(first.corners.every(value => value[0] === 30));
  field.clear();
  field.update();
  assert.equal(field.pending, null);
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

test("evicting an old climate chunk retains shared corners owned by its neighbor", () => {
  const field = new ClimateTintField(16, time => ({temperatureCelsius: time / 1000, humidity: 0.6, yearProgress: 0.4}));
  field.setTime(0);
  field.forPosition({x: 0, y: 0, z: 0});
  const east = field.forPosition({x: 16, y: 0, z: 0});
  field.setTime(15_000);
  // 12 shared nodes + 511 isolated groups of 8 exceeds the node budget by 4.
  // Only the first chunk should leave; its eastern nodes still have an owner.
  for (let index = 0; index < 511; index++) field.forPosition({x: 1000 + index * 32, y: 64, z: 0});
  assert.equal(field.chunks.has("0:0:0"), false);
  assert.equal(field.forPosition({x: 16, y: 0, z: 0}), east);
  assert.equal(field.nodes.size, 4096);
  while (field.pending) field.update(32, 1, () => 0);
  assert.ok(east.corners.every(value => value[0] === 15), "live references must not freeze after a neighbor is evicted");
});

test("authored grass RGB is multiplied once and soil in side tiles keeps its own color", async () => {
  const {applyClimateTint} = await import("../src/backends/babylon/native/climate-tint.mjs");
  const albedo = [0.48, 0.62, 0.43];
  const climate = [18, 0.65, 0.375, 72];
  const tint = climateTintColor(climateTintRoles.grass, climate);
  assert.ok(distance(applyClimateTint(albedo, climateTintRoles.grass, climate), albedo.map((value, index) => value * tint[index])) < 1e-12);
  assert.deepEqual(applyClimateTint([0.5, 0.3, 0.12], climateTintRoles.grassCap, climate), [0.5, 0.3, 0.12]);
});

test("autumn crowns vary by world position and only deciduous species shed", async () => {
  const {leafDropIntensity} = await import("../src/backends/babylon/native/climate-tint.mjs");
  const climate = [18, 0.65, 0.625, 72];
  assert.ok(distance(climateTintColor(2, climate, {x: 1, z: 1}), climateTintColor(2, climate, {x: 13, z: 4})) > 0.05);
  for (const role of [2, 8, 9]) {
    assert.ok(leafDropIntensity(role, 0.625, {x: 0, z: 0}) > 0.9);
    assert.equal(leafDropIntensity(role, 0.375, {x: 0, z: 0}), 0);
    assert.equal(leafDropIntensity(role, 0.95, {x: 0, z: 0}), 0);
  }
  for (const role of [0, 1, 5, 6, 7, 10]) assert.equal(leafDropIntensity(role, 0.625), 0);
});
