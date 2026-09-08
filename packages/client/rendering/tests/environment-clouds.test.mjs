import assert from "node:assert/strict";
import test from "node:test";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Scene} from "@babylonjs/core/scene.js";
import {RawTexture} from "@babylonjs/core/Materials/Textures/rawTexture.js";
import {
  advanceCloudWind,
  cloudLayerDimensions,
  cloudLayerGeometry,
  cloudTextureOffset,
  cloudVertexColors,
  cloudWindDisplacementAt,
  cloudWindIntegrationLimitMilliseconds,
  createCloudLayer,
} from "../src/native/babylon/environment-clouds.mjs";

function approximately(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be approximately ${expected}`);
}

test("cloud dome has four world-scale radial bands with undistorted XZ sampling", () => {
  const geometry = cloudLayerGeometry();
  assert.equal(geometry.positions.length, 49 * 3);
  assert.equal(geometry.normals.length, 49 * 3);
  assert.equal(geometry.uvs.length, 49 * 2);
  assert.equal(geometry.ringIndices.length, 49);
  assert.equal(geometry.indices.length, 216);
  assert.deepEqual(
    [0, 1, 2, 3].map((ring) => geometry.ringIndices.filter((candidate) => candidate === ring).length),
    [1, 8, 16, 24],
  );

  const dimensions = cloudLayerDimensions();
  const radii = [0, 0.8, 0.95, 1];
  for (let offset = 0; offset < geometry.positions.length; offset += 3) {
    const radius = radii[geometry.ringIndices[offset / 3]];
    approximately(Math.hypot(geometry.positions[offset], geometry.positions[offset + 2]), radius * 1900);
    approximately(geometry.positions[offset + 1], 600 - 540 * radius * radius);
    approximately(geometry.uvs[offset / 3 * 2], geometry.positions[offset] / dimensions.textureWorldPeriod);
    approximately(geometry.uvs[offset / 3 * 2 + 1], -geometry.positions[offset + 2] / dimensions.textureWorldPeriod);
  }
  for (let offset = 0; offset < geometry.indices.length; offset += 3) {
    const triangle = geometry.indices.slice(offset, offset + 3);
    for (let corner = 0; corner < triangle.length; corner += 1) {
      const from = triangle[corner] * 3;
      const to = triangle[(corner + 1) % triangle.length] * 3;
      const distance = Math.hypot(
        geometry.positions[from] - geometry.positions[to],
        geometry.positions[from + 2] - geometry.positions[to + 2],
      );
      const uvDistance = Math.hypot(geometry.uvs[from / 3 * 2] - geometry.uvs[to / 3 * 2], geometry.uvs[from / 3 * 2 + 1] - geometry.uvs[to / 3 * 2 + 1]);
      approximately(distance, uvDistance * dimensions.textureWorldPeriod);
    }
  }
  approximately(geometry.positions[0], -dimensions.horizontalRadius / Math.SQRT2);
  approximately(geometry.positions.at(-3), dimensions.horizontalRadius / Math.SQRT2);
});

test("cloud dimensions preserve authored texture scale independently of camera and terrain distance", () => {
  const dimensions = cloudLayerDimensions();
  assert.equal(dimensions.zenithHeight, 600);
  assert.equal(dimensions.horizonHeight, 60);
  assert.equal(dimensions.horizontalRadius, 1900);
  approximately(dimensions.textureWorldPeriod, 1900 / 1.75);
});

test("cloud outer rings converge through fog color to transparency", () => {
  const rings = [0, 1, 2, 3];
  const colors = cloudVertexColors(rings, 0.8, 0.6, {r: 0.2, g: 0.3, b: 0.4}, 0.25);
  assert.equal(colors.length, 16);
  assert.deepEqual(colors.slice(8, 12), [0.12, 0.18, 0.24, 0.6]);
  assert.deepEqual(colors.slice(12), [0, 0, 0, 0]);
  approximately(colors[3], (0.8 * 0.75 * 0.75 + 0.25) * 0.6);
  approximately(colors[7], (0.8 * 0.66 * 0.75 + 0.25) * 0.6);
  assert.ok(colors[0] > colors[4], "inner cloud ring should be brighter than its neighbor");
  for (let offset = 0; offset < colors.length; offset += 4) {
    assert.ok(colors.slice(offset, offset + 3).every((channel) => channel <= colors[offset + 3]), "cloud vertex colors must preserve premultiplication");
  }
});

test("zero-wind cloud UV phase preserves world-position sampling and baseline movement", () => {
  const input = [{x: 120, z: -40}, 12_500];
  const first = cloudTextureOffset(...input);
  assert.deepEqual(cloudTextureOffset(...input), first);
  const period = cloudLayerDimensions().textureWorldPeriod;
  const shifted = cloudTextureOffset({x: 120 + period, z: -40 + period}, 12_500);
  approximately(shifted.u, first.u);
  approximately(shifted.v, first.v);
  const later = cloudTextureOffset(input[0], 13_500);
  approximately(later.u, first.u - 0.002);
  approximately(later.v, first.v + 0.002);
  const moved = cloudTextureOffset({x: 121, z: -39}, 12_500);
  approximately(moved.u - first.u, 1 / period);
  approximately(moved.v - first.v, -1 / period);
  assert.ok(first.u >= 0 && first.u < 1);
  assert.ok(first.v >= 0 && first.v < 1);
});

test("cloud wind uses bounded authoritative trapezoid integration without duplicate-frame drift", () => {
  const period = cloudLayerDimensions().textureWorldPeriod;
  const center = {x: period / 2, z: -period / 2};
  let positive = advanceCloudWind(null, 10_000, 4, -2);
  let negative = advanceCloudWind(null, 10_000, -4, 2);
  positive = advanceCloudWind(positive, 11_000, 6, -4);
  negative = advanceCloudWind(negative, 11_000, -6, 4);
  assert.deepEqual(cloudWindDisplacementAt(positive, 11_000), {x: 5, z: -3});
  assert.deepEqual(cloudWindDisplacementAt(negative, 11_000), {x: -5, z: 3});

  const zero = cloudTextureOffset(center, 11_000);
  const withPositiveWind = cloudTextureOffset(center, 11_000, positive);
  const withNegativeWind = cloudTextureOffset(center, 11_000, negative);
  approximately(withPositiveWind.u - zero.u, -5 / period);
  approximately(withNegativeWind.u - zero.u, 5 / period);
  approximately(withPositiveWind.v - zero.v, -3 / period);
  approximately(withNegativeWind.v - zero.v, 3 / period);

  const duplicate = advanceCloudWind(positive, 11_000, 6, -4);
  assert.equal(duplicate, positive);
  assert.deepEqual(cloudTextureOffset(center, 11_500, duplicate), cloudTextureOffset(center, 11_500, positive));

  const jumped = advanceCloudWind(
    positive,
    11_000 + cloudWindIntegrationLimitMilliseconds + 1,
    12,
    8,
  );
  assert.deepEqual(
    {x: jumped.displacementX, z: jumped.displacementZ},
    {x: positive.displacementX, z: positive.displacementZ},
  );
  assert.deepEqual(
    cloudWindDisplacementAt(jumped, jumped.worldMilliseconds + cloudWindIntegrationLimitMilliseconds + 1),
    {x: jumped.displacementX, z: jumped.displacementZ},
  );
  assert.deepEqual(
    cloudWindDisplacementAt(jumped, jumped.worldMilliseconds - 1),
    {x: jumped.displacementX, z: jumped.displacementZ},
  );
  const rewound = advanceCloudWind(jumped, 9_000, -12, -8);
  assert.deepEqual(
    {x: rewound.displacementX, z: rewound.displacementZ},
    {x: positive.displacementX, z: positive.displacementZ},
  );
});

test("cloud layer applies authoritative wind frames to its rendered UV phase exactly once", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false);
  const layer = createCloudLayer(scene, texture, 1);
  let renderedOffset = null;
  const setVector2 = layer.material.setVector2.bind(layer.material);
  layer.material.setVector2 = (name, value) => {
    if (name === "ovUvOffset") renderedOffset = {u: value.x, v: value.y};
    return setVector2(name, value);
  };
  const center = {
    x: cloudLayerDimensions().textureWorldPeriod / 2,
    y: 70,
    z: -cloudLayerDimensions().textureWorldPeriod / 2,
  };
  const appearance = {cloudBrightness: 1, cloudOpacity: 1, fog: {r: 0, g: 0, b: 0}};
  try {
    layer.applyFrame({...appearance, worldMilliseconds: 10_000, windX: 0, windZ: 0});
    const windy = {...appearance, worldMilliseconds: 11_000, windX: 8, windZ: -4};
    layer.applyFrame(windy);
    layer.applyFrame(windy);
    layer.update(center, 11_000);
    const baseline = cloudTextureOffset(center, 11_000);
    const period = cloudLayerDimensions().textureWorldPeriod;
    approximately(renderedOffset.u - baseline.u, -4 / period);
    approximately(renderedOffset.v - baseline.v, -2 / period);
  } finally {
    layer.mesh.dispose(false, false);
    layer.material.dispose(false, false);
    texture.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test("cloud helpers reject invalid world scales and frame values", () => {
  assert.throws(() => cloudTextureOffset({x: 0, z: 0}, -1), /cannot be negative/u);
  assert.throws(() => cloudVertexColors([4], 1, 1, {r: 0, g: 0, b: 0}), /0 through 3/u);
});
