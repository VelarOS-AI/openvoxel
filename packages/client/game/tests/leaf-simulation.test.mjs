import assert from "node:assert/strict";
import test from "node:test";
import {collectLeafEmitters, createLeafSimulation, leafParticleCapacity} from "../src/backends/babylon/native/leaf-simulation.mjs";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Scene} from "@babylonjs/core/scene.js";
import {RawTexture} from "@babylonjs/core/Materials/Textures/rawTexture.js";
import {createLeafParticles} from "../src/backends/babylon/native/leaf-particles.mjs";

const frame = {windX: 2, windZ: 0, daylightIntensity: 1};
const center = {x: 0, y: 2, z: 0};
const source = {x: 0, y: 4, z: 0, width: 1, depth: 1, role: 2};
const climate = () => [18, 0.65, 0.625, 0];

test("leaf emitters use exposed deciduous undersides in world coordinates", () => {
  const positions = [0, 4, 0, 1, 4, 0, 1, 4, 1, 0, 4, 1];
  const normals = [0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0];
  const origin = {x: -16, y: 64, z: 32};
  assert.deepEqual(collectLeafEmitters(positions, normals, [2, 2, 2, 2], origin), [{x: -15.5, y: 67.96, z: 32.5, width: 1, depth: 1, role: 2}]);
  assert.deepEqual(collectLeafEmitters(positions, normals, [5, 5, 5, 5], origin), []);
  assert.deepEqual(collectLeafEmitters(positions, normals.map(value => -value), [8, 8, 8, 8], origin), []);
});

test("leaves follow wind, land above solid ground, fade and release with their source mesh", () => {
  const sim = createLeafSimulation(16, climate, () => ({groundY: 0, surface: "solid"}), () => 0.5);
  sim.register("oak", 0, 0, [source]);
  for (let i = 0; i < 30; i += 1) sim.update(100, center, frame);
  const grounded = sim.particles.filter(p => p.active && p.horizontal);
  assert.ok(grounded.length > 0);
  assert.ok(grounded.every(p => p.y === 0.03 && p.remaining <= 2 && p.color[0] > p.color[1]));
  assert.ok(sim.particles.some(p => p.active && p.x > 0.1));
  sim.register("oak", 0, 0, []);
  assert.equal(sim.stats().active, 0);
  assert.equal(sim.stats().ownedMeshes, 0);
  sim.update(100, center, frame);
  assert.equal(sim.stats().nearbyEmitters, 0);
});

test("water absorbs fallen leaves and spring does not emit autumn particles", () => {
  const sim = createLeafSimulation(16, climate, () => ({groundY: 3.99, surface: "water"}), () => 0.5);
  sim.register("oak", 0, 0, [source]);
  for (let i = 0; i < 30; i += 1) sim.update(100, center, frame);
  assert.equal(sim.stats().active, 0);
  const spring = createLeafSimulation(16, () => [18, 0.6, 0.125, 0], () => null, () => 0.5);
  spring.register("birch", 0, 0, [{...source, role: 8}]);
  for (let i = 0; i < 30; i += 1) spring.update(100, center, frame);
  assert.equal(spring.stats().active, 0);
});

test("dense foliage has a fixed pool and raycast budget, and distant chunks cannot emit", () => {
  const sim = createLeafSimulation(16, climate, () => null, () => 0.5);
  for (let i = 0; i < 100; i += 1) sim.register(i, i, 0, [{...source, x: i * 16}]);
  for (let i = 0; i < 200; i += 1) {
    sim.update(100, center, frame);
    assert.ok(sim.stats().active <= leafParticleCapacity);
    assert.ok(sim.stats().sampledGround <= 8);
  }
  assert.equal(sim.stats().nearbyEmitters, 2);
  sim.update(100, {x: -500, y: 0, z: 0}, frame);
  assert.equal(sim.stats().active, 0);
  sim.clear();
  assert.equal(sim.stats().ownedMeshes, 0);
});

test("leaf rendering uses one tinted batch and releases its GPU resources", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255,255,255,255]), 1, 1, scene);
  const leaves = createLeafParticles(scene, texture, 16, climate, () => ({groundY: 0, surface: "solid"}));
  leaves.register("oak", 0, 0, [source]);
  for (let i = 0; i < 30; i += 1) leaves.update(100, center, frame);
  const mesh = scene.getMeshByName("openvoxel-leaf");
  assert.ok(mesh.isEnabled());
  assert.equal(mesh.material.disableDepthWrite, true);
  assert.ok(mesh.getVerticesData("color")[0] > mesh.getVerticesData("color")[1]);
  assert.equal(scene.meshes.length, 1);
  leaves.dispose();
  assert.equal(scene.meshes.length, 0);
  assert.equal(leaves.stats().active, 0);
  scene.dispose(); engine.dispose();
});
