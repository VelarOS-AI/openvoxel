import assert from "node:assert/strict";
import test from "node:test";
import {Constants} from "@babylonjs/core/Engines/constants.js";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Scene} from "@babylonjs/core/scene.js";
import {Texture} from "@babylonjs/core/Materials/Textures/texture.js";
import {RawTexture} from "@babylonjs/core/Materials/Textures/rawTexture.js";
import {configurePointClampTexture, createWeatherParticles, precipitationParticleProfiles} from "../src/native/babylon/weather-particles.mjs";
import {
  createWeatherParticleBatch,
  createWeatherSpriteBuffers,
  snowflakeSpriteUvs,
  weatherBillboardAxes,
  writeWeatherSprite,
} from "../src/native/babylon/weather-particle-batch.mjs";
import {
  advanceWeatherSplash,
  createWeatherSimulation,
  initializeWeatherSplash,
  precipitationWindVelocity,
  precipitationSkyLight,
  precipitationTopFade,
} from "../src/native/babylon/weather-simulation.mjs";

const center = {x: 0.5, y: 70, z: 0.5};
const axes = weatherBillboardAxes({x: 0, y: 0, z: 1});

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} should equal ${expected}`);
}

test("weather particle budgets retain four fixed slots per camera-local column", () => {
  const profiles = precipitationParticleProfiles();
  assert.ok(Object.isFrozen(profiles));
  for (const kind of ["rain", "snow", "splash", "snowSplash"]) assert.ok(Object.isFrozen(profiles[kind]));
  assert.equal(profiles.rain.capacity, 149 * 4);
  assert.equal(profiles.snow.capacity, 149 * 4);
  assert.equal(profiles.splash.capacity, 150);
  assert.equal(profiles.snowSplash.capacity, 100);
  assert.deepEqual([profiles.rain.minSpeed, profiles.rain.maxSpeed], [8, 12]);
  assert.deepEqual([profiles.snow.minSpeed, profiles.snow.maxSpeed], [0.5, 3]);
});

test("precipitation textures use point sampling with clamp addressing", () => {
  const samplingModes = [];
  const texture = {updateSamplingMode: (mode) => samplingModes.push(mode)};
  assert.equal(configurePointClampTexture(texture), texture);
  assert.equal(texture.hasAlpha, true);
  assert.equal(texture.wrapU, Texture.CLAMP_ADDRESSMODE);
  assert.equal(texture.wrapV, Texture.CLAMP_ADDRESSMODE);
  assert.deepEqual(samplingModes, [Texture.NEAREST_SAMPLINGMODE]);
  assert.throws(() => configurePointClampTexture({}), /Babylon texture/u);
});

test("rain uses a world-vertical triangle with the authored 0.04 by 0.30 footprint", () => {
  const buffers = createWeatherSpriteBuffers(1, true);
  writeWeatherSprite(buffers, 0, "rain", {x: 10, y: 70, z: 20}, axes, 0.8, 0.5);
  assert.equal(buffers.positions.length, 9);
  assert.deepEqual([...buffers.indices], [0, 1, 2]);
  close(buffers.positions[0] - buffers.positions[3], 0.04);
  close(buffers.positions[7] - buffers.positions[1], 0.30);
  close(buffers.positions[6], 10);
  assert.deepEqual([...buffers.uvs], [0, 0, 1, 0, 0.5, 1]);
  close(buffers.colors[0], 0.4);
  close(buffers.colors[3], 0.5);
  const tiltedAxes = weatherBillboardAxes({x: 0, y: 0.8, z: 0.6});
  const tilted = createWeatherSpriteBuffers(1, true);
  writeWeatherSprite(tilted, 0, "rain", {x: 10, y: 70, z: 20}, tiltedAxes, 1, 1);
  assert.deepEqual([...tilted.positions], [...buffers.positions]);
});

test("the 4 by 4 snow atlas preserves all sixteen source cells and upload orientation", () => {
  assert.deepEqual(snowflakeSpriteUvs(0), [0, 0.75, 0.25, 0.75, 0.25, 1, 0, 1]);
  assert.deepEqual(snowflakeSpriteUvs(15), [0.75, 0, 1, 0, 1, 0.25, 0.75, 0.25]);
  assert.equal(new Set(Array.from({length: 16}, (_, slot) => snowflakeSpriteUvs(slot).join(","))).size, 16);
  assert.throws(() => snowflakeSpriteUvs(16), /slot/u);
});

test("whole-image rain splash flips never relocate falling or landed snow atlas cells", () => {
  for (const kind of ["snow", "snowSplash"]) {
    for (const slot of [0, 5, 15]) {
      const buffers = createWeatherSpriteBuffers(1);
      writeWeatherSprite(buffers, 0, kind, {x: 0, y: 0, z: 0, halfSize: 0.07, slot, flipX: true, flipY: true}, axes, 1, 1);
      assert.deepEqual([...buffers.uvs], snowflakeSpriteUvs(slot));
    }
  }
  const rainSplash = createWeatherSpriteBuffers(1);
  writeWeatherSprite(rainSplash, 0, "rainSplash", {x: 0, y: 0, z: 0, halfSize: 0.03, flipX: true, flipY: true}, axes, 1, 1);
  assert.deepEqual([...rainSplash.uvs], [1, 1, 0, 1, 0, 0, 1, 0]);
});

test("snow falls at a constant speed with a stable slot and constant 0.14 square size", () => {
  const simulation = createWeatherSimulation({random: () => 0.5});
  const columns = [{x: 0, z: 0, groundY: 60, surface: "solid"}];
  simulation.update(0, center, columns, "snow", 1);
  const particle = simulation.shafts.get("0:0").particles[0];
  const before = {...particle};
  for (let index = 0; index < 10; index += 1) simulation.update(100, center, columns, "snow", 1);
  close(particle.y, before.y - 1.75);
  assert.equal(particle.x, before.x);
  assert.equal(particle.z, before.z);
  assert.equal(particle.slot, before.slot);
  assert.equal(particle.halfSize, 0.07);
  const buffers = createWeatherSpriteBuffers(1);
  writeWeatherSprite(buffers, 0, "snow", particle, axes, 1, 1);
  close(Math.abs(buffers.positions[0] - buffers.positions[3]), 0.14);
  close(Math.abs(buffers.positions[7] - buffers.positions[1]), 0.14);
});

test("terrain invalidation immediately drops affected shafts and impacts without inventing contacts", () => {
  for (const kind of ["rain", "snow"]) {
    const simulation = createWeatherSimulation({random: () => 0.25});
    const columns = [{x: -1, z: -1, groundY: 65, surface: "solid"}, {x: 0, z: -1, groundY: 65, surface: "water"}];
    simulation.update(0, center, columns, kind, 1);
    for (const shaft of simulation.shafts.values()) {
      for (const particle of shaft.particles) particle.y = 65.01;
    }
    simulation.update(100, center, columns, kind, 1);
    const pool = kind === "rain" ? simulation.rainSplashes : simulation.snowSplashes;
    assert.equal(pool.filter((particle) => particle.active).length, 8);
    const contacts = simulation.stats();
    const unaffected = simulation.shafts.get("0:-1");
    simulation.invalidateChunkColumn(-1, -1, 16);
    assert.equal(simulation.shafts.size, 1);
    assert.equal(simulation.shafts.get("0:-1"), unaffected);
    assert.equal(pool.filter((particle) => particle.active).length, 4);
    assert.ok(pool.filter((particle) => particle.active).every((particle) => particle.x >= 0));
    assert.deepEqual(simulation.stats(), contacts);
    simulation.invalidateChunkColumn(99, 99, 16);
    assert.equal(simulation.shafts.size, 1);
    assert.equal(pool.filter((particle) => particle.active).length, 4);
  }
});

test("opposite winds reverse bounded rain and snow drift while zero wind preserves vertical fall", () => {
  const columns = [{x: 0, z: 0, groundY: 60, surface: "solid"}];
  for (const kind of ["rain", "snow"]) {
    const results = [];
    for (const wind of [{x: 8, z: -4}, {x: 0, z: 0}, {x: -8, z: 4}]) {
      const simulation = createWeatherSimulation({random: () => 0.5});
      simulation.update(0, center, columns, kind, 1, wind.x, wind.z);
      const shaft = simulation.shafts.get("0:0");
      const particle = shaft.particles[0];
      const before = {...particle};
      simulation.update(100, center, columns, kind, 1, wind.x, wind.z);
      results.push({x: particle.x - before.x, y: particle.y - before.y, z: particle.z - before.z});
      assert.equal(shaft.particles.length, 4);
      assert.equal(particle.slot, before.slot);
      assert.equal(particle.halfSize, before.halfSize);
      assert.equal(simulation.rainSplashes.length, precipitationParticleProfiles().splash.capacity);
      assert.equal(simulation.snowSplashes.length, precipitationParticleProfiles().snowSplash.capacity);
    }
    const expected = precipitationWindVelocity(kind, 8, -4);
    close(results[0].x, expected.x * 0.1);
    close(results[0].z, expected.z * 0.1);
    close(results[0].x, -results[2].x);
    close(results[0].z, -results[2].z);
    close(results[1].x, 0);
    close(results[1].z, 0);
    close(results[0].y, results[1].y);
    close(results[1].y, results[2].y);
  }
  close(Math.hypot(...Object.values(precipitationWindVelocity("rain", 64, 0))), 2);
  close(Math.hypot(...Object.values(precipitationWindVelocity("snow", 64, 0))), 0.75);
});

test("the same weather update sequence produces the same wind-driven particles", () => {
  const columns = [{x: 0, z: 0, groundY: 60, surface: "solid"}];
  const left = createWeatherSimulation({random: () => 0.5});
  const right = createWeatherSimulation({random: () => 0.5});
  for (const deltaMs of [0, 16, 100, 33]) {
    left.update(deltaMs, center, columns, "snow", 1, 7, -3);
    right.update(deltaMs, center, columns, "snow", 1, 7, -3);
  }
  assert.deepEqual([...left.shafts.entries()], [...right.shafts.entries()]);
  assert.deepEqual(left.stats(), right.stats());
});

test("long-lived snow wraps through its source column under maximum wind without changing its fixed pool", () => {
  const simulation = createWeatherSimulation({random: () => 0.5});
  const columns = [{x: 0, z: 0, groundY: -100, surface: "solid"}];
  const maximumComponent = 64 / Math.SQRT2;
  simulation.update(0, center, columns, "snow", 1, maximumComponent, -maximumComponent);
  const shaft = simulation.shafts.get("0:0");
  const initialX = [0.1, 0.3, 0.6, 0.9];
  const initialZ = [0.9, 0.6, 0.3, 0.1];
  for (let index = 0; index < shaft.particles.length; index += 1) {
    shaft.particles[index].x = initialX[index];
    shaft.particles[index].y = 74;
    shaft.particles[index].z = initialZ[index];
    shaft.particles[index].speed = 0.5;
  }
  const slots = shaft.particles.map((particle) => particle.slot);
  let wrappedX = false;
  let wrappedZ = false;
  let previousX = shaft.particles[3].x;
  let previousZ = shaft.particles[3].z;
  for (let step = 1; step < 200; step += 1) {
    simulation.update(100, {...center, y: 70 - step * 0.05}, columns, "snow", 1, maximumComponent, -maximumComponent);
    assert.equal(simulation.shafts.get("0:0"), shaft);
    assert.ok(shaft.particles.every((particle) => (
      particle.active
      && particle.x >= 0 && particle.x < 1
      && particle.z >= 0 && particle.z < 1
    )));
    if (shaft.particles[3].x < previousX) wrappedX = true;
    if (shaft.particles[3].z > previousZ) wrappedZ = true;
    previousX = shaft.particles[3].x;
    previousZ = shaft.particles[3].z;
  }
  assert.equal(wrappedX, true);
  assert.equal(wrappedZ, true);
  assert.deepEqual(shaft.particles.map((particle) => particle.slot), slots);
  assert.ok(shaft.particles.every((particle) => particle.halfSize === 0.07));
  assert.equal(shaft.particles.length, precipitationParticleProfiles().snow.slotsPerColumn);
  assert.equal(simulation.snowSplashes.length, precipitationParticleProfiles().snowSplash.capacity);
});

test("weather intensity changes density while neutral sky light and top fade control premultiplied color", () => {
  const full = createWeatherSimulation({random: () => 0.5});
  const half = createWeatherSimulation({random: () => 0.5});
  const columns = [{x: 0, z: 0, groundY: 60, surface: "solid"}];
  full.update(0, center, columns, "snow", 1);
  half.update(0, center, columns, "snow", 0.5);
  assert.equal(full.shafts.get("0:0").particles.filter((particle) => particle.active).length, 4);
  assert.equal(half.shafts.get("0:0").particles.filter((particle) => particle.active).length, 2);
  close(precipitationSkyLight(0), 0.15);
  close(precipitationSkyLight(1), 1);
  close(precipitationTopFade(75, 70), 0);
  close(precipitationTopFade(74, 70), 0.6);
  close(precipitationTopFade(70, 70), 1);
});

test("rain impact expands horizontally on water and rebounds vertically on solid surfaces", () => {
  const contact = {x: 1, y: 2, z: 3, slot: 4};
  const water = initializeWeatherSplash({}, "rain", {...contact, surface: "water"}, () => 0.5);
  const solid = initializeWeatherSplash({}, "rain", {...contact, surface: "solid"}, () => 0.5);
  assert.equal(water.horizontal, true);
  assert.equal(solid.horizontal, false);
  close(water.y, 2.05);
  close(water.duration, 0.4);
  close(solid.duration, 0.275);
  close(water.halfSize, 0.02);
  close(solid.halfSize, 0.03);
  advanceWeatherSplash(water, 0.1);
  advanceWeatherSplash(solid, 0.1);
  close(water.y, 2.05);
  assert.ok(solid.y > 2);
  close(water.halfSize, 0.0375);
  assert.ok(solid.velocityY < 0);
});

test("landed snow keeps the falling slot horizontally and melts faster on water", () => {
  const contact = {x: 1, y: 2, z: 3, slot: 11};
  const water = initializeWeatherSplash({}, "snow", {...contact, surface: "water"}, () => 0.5);
  const solid = initializeWeatherSplash({}, "snow", {...contact, surface: "solid"}, () => 0.5);
  close(water.duration, 0.25);
  close(solid.duration, 1);
  for (let index = 0; index < 3; index += 1) {
    advanceWeatherSplash(water, 0.1);
    advanceWeatherSplash(solid, 0.1);
  }
  assert.equal(water.active, false);
  assert.equal(solid.active, true);
  assert.equal(solid.slot, 11);
  assert.equal(solid.halfSize, 0.07);
  assert.equal(solid.y, 2);
  const buffers = createWeatherSpriteBuffers(1);
  writeWeatherSprite(buffers, 0, "snowSplash", solid, axes, 1, 1);
  assert.deepEqual([buffers.positions[1], buffers.positions[4], buffers.positions[7], buffers.positions[10]], [2, 2, 2, 2]);
  assert.deepEqual([...buffers.uvs], snowflakeSpriteUvs(11));
});

test("impact sprites require an actual falling particle to hit a known surface", () => {
  const simulation = createWeatherSimulation({random: () => 0.25});
  const columns = [{x: 0, z: 0, groundY: 67, surface: "water"}];
  simulation.update(0, center, columns, "rain", 1);
  assert.equal(simulation.rainSplashes.filter((particle) => particle.active).length, 0);
  simulation.update(100, center, columns, "rain", 1);
  assert.equal(simulation.rainSplashes.filter((particle) => particle.active).length, 4);
  assert.deepEqual(simulation.stats(), {rainSplashContacts: 4, snowSplashContacts: 0});
  assert.ok(simulation.rainSplashes.filter((particle) => particle.active).every((particle) => particle.horizontal && particle.y === 67.05));
  const empty = createWeatherSimulation({random: () => 0.25});
  for (let index = 0; index < 50; index += 1) empty.update(100, center, [], "rain", 1);
  assert.ok(empty.rainSplashes.every((particle) => !particle.active));
});

test("moving upward refills the newly exposed vertical band without changing existing slots", () => {
  const simulation = createWeatherSimulation({random: () => 0.5});
  const columns = [{x: 0, z: 0, groundY: 60, surface: "solid"}];
  simulation.update(0, center, columns, "snow", 0.5);
  const shaft = simulation.shafts.get("0:0");
  const slots = shaft.particles.map((particle) => particle.slot);
  simulation.update(0, {...center, y: 75}, columns, "snow", 0.5);
  assert.equal(shaft.particles.filter((particle) => particle.active).length, 3);
  assert.ok(shaft.particles.some((particle) => particle.active && particle.y > 75));
  assert.deepEqual(shaft.particles.map((particle) => particle.slot), slots);
});

test("vertical teleport immediately repopulates eye-height rain and snow without replacing slots or producing impacts", () => {
  for (const kind of ["rain", "snow"]) {
    const simulation = createWeatherSimulation({random: () => 0.5});
    const columns = [{x: 0, z: 0, groundY: 60, surface: "solid"}];
    simulation.update(0, center, columns, kind, 1);
    const shaft = simulation.shafts.get("0:0");
    const particles = [...shaft.particles];
    const slots = particles.map((particle) => particle.slot);
    const speeds = particles.map((particle) => particle.speed);
    for (const viewY of [170, 70, 80]) {
      simulation.update(16, {...center, y: viewY}, columns, kind, 1);
      assert.equal(simulation.shafts.get("0:0"), shaft);
      assert.equal(shaft.particles.filter((particle) => particle.active).length, 4);
      assert.ok(shaft.particles.every((particle, index) => particle === particles[index] && Math.abs(particle.y - viewY) < 5));
      assert.deepEqual(shaft.particles.map((particle) => particle.slot), slots);
      assert.deepEqual(shaft.particles.map((particle) => particle.speed), speeds);
      assert.deepEqual(simulation.stats(), {rainSplashContacts: 0, snowSplashContacts: 0});
    }
    simulation.update(16, {...center, y: 0}, columns, kind, 1);
    assert.ok(shaft.particles.every((particle) => !particle.active));
    assert.deepEqual(simulation.stats(), {rainSplashContacts: 0, snowSplashContacts: 0});
  }
});

test("bounded shafts release on teleport and stop after the current precipitation drains", () => {
  const simulation = createWeatherSimulation({random: () => 0.5});
  const columns = [{x: 0, z: 0, groundY: 60, surface: "solid"}];
  simulation.update(0, center, columns, "rain", 1);
  simulation.update(0, {...center, x: 100}, [], "rain", 1);
  assert.equal(simulation.shafts.size, 0);
  simulation.update(0, center, columns, "rain", 1);
  for (let index = 0; index < 20; index += 1) simulation.update(100, center, columns, "none", 0);
  assert.equal(simulation.shafts.size, 0);
});

test("particle billboard axes remain finite for horizontal and straight-up views", () => {
  for (const direction of [{x: 0, y: 0, z: 1}, {x: 0, y: 1, z: 0}, {x: 0, y: -1, z: 0}]) {
    const result = weatherBillboardAxes(direction);
    assert.ok([...Object.values(result.right), ...Object.values(result.up)].every(Number.isFinite));
    close(Math.hypot(...Object.values(result.right)), 1);
    close(Math.hypot(...Object.values(result.up)), 1);
  }
});

test("weather batches use premultiplied blending, fixed buffers and shared texture ownership", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false);
  const weather = createWeatherParticles(scene, {rain: texture, snow: texture, rainSplash: texture});
  try {
    const frame = {precipitation: "snow", precipitationIntensity: 1, daylightIntensity: 1, skyIntensity: 0.2, windX: 0, windZ: 0};
    weather.applyFrame(frame);
    weather.applyFrame(frame);
    weather.update(0, center, {x: 0, y: 60, z: 0}, null);
    assert.ok(weather.snow.getActiveCount() > 0);
    assert.equal(weather.rain.getActiveCount(), 0);
    const colors = weather.snow.buffers.colors;
    close(colors[0], colors[3]);
    const buffer = weather.snow.buffers.positions;
    const initialX = buffer[0];
    const initialZ = buffer[2];
    weather.applyFrame({...frame, windX: 8, windZ: -4});
    weather.update(100, center, {x: 0, y: 60, z: 0}, null);
    assert.equal(weather.snow.buffers.positions, buffer);
    close((buffer[0] - initialX + 1) % 1, 0.02);
    close((initialZ - buffer[2] + 1) % 1, 0.01);
    for (const batch of [weather.rain, weather.snow, weather.splash, weather.snowSplash]) {
      assert.equal(batch.mesh.material.alphaMode, Constants.ALPHA_PREMULTIPLIED_PORTERDUFF);
      assert.equal(batch.mesh.isPickable, false);
      assert.equal(batch.mesh.material.fogEnabled, false);
    }
    assert.equal(weather.rain.mesh.material.disableDepthWrite, true);
    assert.equal(weather.snow.mesh.material.disableDepthWrite, true);
    assert.equal(weather.splash.mesh.material.forceDepthWrite, true);
    assert.equal(weather.snowSplash.mesh.material.forceDepthWrite, true);
    weather.dispose();
    weather.dispose();
    assert.equal(weather.snow.getActiveCount(), 0);
    assert.ok(scene.textures.includes(texture));
    assert.equal(scene.meshes.length, 0);
  } finally {
    weather.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test("partial and full particle draw ranges share valid reused transparent-sort bounds", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false);
  const batch = createWeatherParticleBatch(scene, texture, "snow", 4);
  try {
    const submesh = batch.mesh.subMeshes[0];
    const bounds = submesh.getBoundingInfo();
    assert.ok(bounds?.boundingSphere);
    for (const count of [0, 1, 4, 2, 0, 1]) {
      batch.reset();
      for (let index = 0; index < count; index += 1) {
        batch.append({x: 10 + index, y: 70, z: 20, halfSize: 0.07, slot: index}, axes, 1, 1);
      }
      batch.upload();
      assert.equal(submesh.indexCount, count * 6);
      assert.equal(submesh.IsGlobal, count === 4);
      assert.equal(submesh.getBoundingInfo(), bounds);
      assert.ok(Number.isFinite(bounds.boundingSphere.centerWorld.x));
      assert.ok(Number.isFinite(bounds.boundingSphere.centerWorld.y));
      assert.ok(Number.isFinite(bounds.boundingSphere.centerWorld.z));
      assert.equal(batch.mesh.isEnabled(), count > 0);
      if (count > 0) {
        assert.ok(bounds.minimum.x < 10);
        assert.ok(bounds.maximum.x > 10 + count - 1);
        close(bounds.boundingSphere.centerWorld.y, 70);
      }
    }
  } finally {
    batch.dispose();
    scene.dispose();
    engine.dispose();
  }
});
