import assert from "node:assert/strict";
import test from "node:test";
import {buildPbrTextureArrayMipLevels} from "../tools/texture-mipmaps.mjs";

const channels = ["albedo", "normal", "material", "emissive"];

function solidLayer(width, height, rgba) {
  return Buffer.from(Array.from({length: width * height}, () => rgba).flat());
}

function layersFor(width, height, definitions) {
  return {
    albedoLayers: definitions.map(({albedo}) => solidLayer(width, height, albedo)),
    normalLayers: definitions.map(({normal = [128, 128, 255, 0]}) => solidLayer(width, height, normal)),
    materialLayers: definitions.map(({material = [255, 128, 0, 0]}) => solidLayer(width, height, material)),
    emissiveLayers: definitions.map(({emissive = [0, 0, 0, 0]}) => solidLayer(width, height, emissive)),
  };
}

function pixel(layer, x, y, width) {
  const offset = (y * width + x) * 4;
  return [...layer.subarray(offset, offset + 4)];
}

function passingAlphaCount(layer, cutoff = 0.45) {
  const cutoffByte = Math.ceil(cutoff * 255);
  let count = 0;
  for (let offset = 3; offset < layer.byteLength; offset += 4) {
    if (layer[offset] >= cutoffByte) count += 1;
  }
  return count;
}

test("PBR texture mip levels reach 1x1 and never mix array layers", () => {
  const levels = buildPbrTextureArrayMipLevels({
    width: 5,
    height: 3,
    ...layersFor(5, 3, [
      {albedo: [255, 0, 0, 255]},
      {albedo: [0, 0, 255, 255]},
    ]),
    alphaCutoffs: [null, null],
  });

  assert.deepEqual(levels.map(({level, width, height}) => ({level, width, height})), [
    {level: 0, width: 5, height: 3},
    {level: 1, width: 2, height: 1},
    {level: 2, width: 1, height: 1},
  ]);
  for (const level of levels) {
    assert.equal(level.layers.length, 2);
    assert.deepEqual(pixel(level.layers[0].albedo, 0, 0, level.width), [255, 0, 0, 255]);
    assert.deepEqual(pixel(level.layers[1].albedo, 0, 0, level.width), [0, 0, 255, 255]);
  }
});

test("color mips average in linear light while material and alpha stay linear", () => {
  const albedo = Buffer.from([
    0, 0, 0, 0, 255, 255, 255, 64,
    0, 0, 0, 192, 255, 255, 255, 255,
  ]);
  const emissive = Buffer.from([
    255, 0, 0, 1, 0, 255, 0, 2,
    0, 0, 255, 3, 255, 255, 255, 4,
  ]);
  const material = Buffer.from([
    0, 10, 20, 5, 100, 110, 120, 6,
    200, 210, 220, 7, 255, 250, 240, 8,
  ]);
  const normal = solidLayer(2, 2, [128, 128, 255, 9]);
  const levels = buildPbrTextureArrayMipLevels({
    width: 2,
    height: 2,
    albedoLayers: [albedo],
    normalLayers: [normal],
    materialLayers: [material],
    emissiveLayers: [emissive],
    alphaCutoffs: [null],
  });
  const mip = levels[1].layers[0];

  assert.deepEqual([...mip.albedo], [207, 207, 207, 128]);
  assert.deepEqual([...mip.emissive], [187, 207, 240, 128]);
  assert.deepEqual([...mip.material], [215, 217, 217, 128]);
  assert.deepEqual([...mip.normal], [128, 128, 255, 128]);
  for (const channel of channels.slice(1)) {
    assert.equal(levels[0].layers[0][channel][3], albedo[3], `${channel} base alpha`);
    assert.equal(mip[channel][3], mip.albedo[3], `${channel} mip alpha`);
  }
});

test("normal mips decode, average, and renormalize tangent-space vectors", () => {
  const normal = Buffer.from([
    255, 128, 128, 0, 255, 128, 128, 0,
    128, 128, 255, 0, 128, 128, 255, 0,
  ]);
  const defaults = layersFor(2, 2, [{albedo: [255, 255, 255, 255]}]);
  const levels = buildPbrTextureArrayMipLevels({...defaults, width: 2, height: 2, normalLayers: [normal], alphaCutoffs: [null]});
  const [x, y, z] = levels[1].layers[0].normal;
  const decoded = [x, y, z].map((component) => component / 127.5 - 1);

  assert.ok(x >= 217 && x <= 219, `renormalized X ${x}`);
  assert.ok(y >= 127 && y <= 129, `renormalized Y ${y}`);
  assert.ok(z >= 217 && z <= 219, `renormalized Z ${z}`);
  assert.ok(Math.abs(Math.hypot(...decoded) - 1) < 0.01);
});

test("constant normal directions preserve every roughness byte throughout odd-sized mip chains", () => {
  const definitions = [[128, 128, 255, 255], [200, 160, 232, 255], [255, 128, 128, 255]]
    .flatMap((normal) => Array.from({length: 256}, (_value, roughness) => ({
      albedo: [60, 90, 120, 255], normal, material: [201, roughness, 23, 255],
    })));
  const levels = buildPbrTextureArrayMipLevels({
    width: 5,
    height: 3,
    ...layersFor(5, 3, definitions),
    alphaCutoffs: definitions.map(() => null),
  });

  for (const level of levels) {
    for (let layer = 0; layer < definitions.length; layer += 1) {
      for (let offset = 0; offset < level.layers[layer].material.byteLength; offset += 4) {
        assert.deepEqual([...level.layers[layer].material.subarray(offset, offset + 4)], definitions[layer].material);
      }
    }
  }
});

test("opposing normals broaden specular roughness while preserving AO, metallic, alpha and normal fallback", () => {
  const defaults = layersFor(2, 2, [{albedo: [60, 90, 120, 255], material: [64, 20, 137, 255]}]);
  const normal = Buffer.from([
    255, 128, 128, 255, 0, 127, 127, 255,
    255, 128, 128, 255, 0, 127, 127, 255,
  ]);
  const levels = buildPbrTextureArrayMipLevels({...defaults, width: 2, height: 2, normalLayers: [normal], alphaCutoffs: [null]});

  assert.deepEqual([...levels[1].layers[0].material], [64, 255, 137, 255]);
  assert.deepEqual([...levels[1].layers[0].normal], [128, 128, 255, 255]);
  assert.deepEqual([...levels[0].layers[0].material], [...defaults.materialLayers[0]]);
});

test("specular compensation is bounded and monotonic in both normal spread and source roughness", () => {
  const sourceRoughness = [0, 20, 100, 200, 255];
  const compensated = [0, 10, 30, 60, 89].map((degrees) => {
    const angle = degrees * Math.PI / 180;
    const normalByte = (value) => Math.round((value * 0.5 + 0.5) * 255);
    const left = [normalByte(Math.sin(angle)), 128, normalByte(Math.cos(angle)), 255];
    const right = [normalByte(-Math.sin(angle)), 128, normalByte(Math.cos(angle)), 255];
    return sourceRoughness.map((roughness) => {
      const defaults = layersFor(2, 2, [{albedo: [60, 90, 120, 255], material: [64, roughness, 137, 255]}]);
      const levels = buildPbrTextureArrayMipLevels({
        ...defaults, width: 2, height: 2,
        normalLayers: [Buffer.from([...left, ...right, ...left, ...right])], alphaCutoffs: [null],
      });
      const result = levels[1].layers[0].material[1];
      assert.ok(result >= roughness && result <= 255, `${degrees} degrees, ${roughness} -> ${result}`);
      return result;
    });
  });

  assert.deepEqual(compensated[0], sourceRoughness);
  for (let spread = 0; spread < compensated.length; spread += 1) {
    for (let roughness = 0; roughness < sourceRoughness.length; roughness += 1) {
      if (spread > 0) assert.ok(compensated[spread][roughness] >= compensated[spread - 1][roughness]);
      if (roughness > 0) assert.ok(compensated[spread][roughness] >= compensated[spread][roughness - 1]);
    }
  }
});

test("normal variance uses visible coverage and ignores transparent normal and material texels", () => {
  const defaults = layersFor(2, 2, [{albedo: [60, 90, 120, 0], material: [70, 48, 90, 0]}]);
  defaults.albedoLayers[0][3] = 255;
  defaults.albedoLayers[0][7] = 64;
  const visibleNormals = [255, 128, 128, 255, 128, 128, 255, 64];
  const normal = Buffer.from([...visibleNormals, 0, 127, 127, 255, 127, 127, 0, 255]);
  const alternativeNormal = Buffer.from([...visibleNormals, 128, 255, 128, 0, 128, 0, 128, 0]);
  const alternativeMaterial = Buffer.from(defaults.materialLayers[0]);
  alternativeMaterial.fill(255, 8);

  for (const cutoff of [null, 0.45]) {
    const original = buildPbrTextureArrayMipLevels({
      ...defaults, width: 2, height: 2, normalLayers: [normal], alphaCutoffs: [cutoff],
    })[1].layers[0];
    const alternative = buildPbrTextureArrayMipLevels({
      ...defaults, width: 2, height: 2, normalLayers: [alternativeNormal],
      materialLayers: [alternativeMaterial], alphaCutoffs: [cutoff],
    })[1].layers[0];
    for (const channel of channels) assert.deepEqual(original[channel], alternative[channel]);

    const surfaceWeight = 64 / 255;
    const x = 1 + surfaceWeight / 255;
    const y = (1 + surfaceWeight) / 255;
    const z = 1 / 255 + surfaceWeight;
    const coherence = Math.hypot(x, y, z) / ((1 + surfaceWeight) * Math.hypot(1, 1 / 255, 1 / 255));
    const expectedRoughness = Math.round(Math.min(1, (48 / 255) ** 4 + 1 - coherence * coherence) ** 0.25 * 255);
    assert.equal(original.material[1], expectedRoughness);
    assert.deepEqual([original.material[0], original.material[2]], [70, 90]);
    assert.equal(original.albedo[3], cutoff === null ? 80 : Math.ceil(cutoff * 255));
    for (const channel of channels.slice(1)) assert.equal(original[channel][3], original.albedo[3]);
  }

  const transparent = buildPbrTextureArrayMipLevels({
    ...defaults, width: 2, height: 2, albedoLayers: [solidLayer(2, 2, [60, 90, 120, 0])],
    normalLayers: [normal], alphaCutoffs: [0.45],
  })[1].layers[0];
  assert.deepEqual([...transparent.material], [0, 0, 0, 0]);
  assert.deepEqual([...transparent.normal], [128, 128, 255, 0]);
});

test("a complete mip chain retains filtered normal variance without repeatedly roughening constant mip normals", () => {
  const defaults = layersFor(8, 8, [{albedo: [60, 90, 120, 255], material: [70, 24, 90, 255]}]);
  const normal = Buffer.from(Array.from({length: 64}, (_value, index) => index % 2 === 0
    ? [191, 128, 238, 255]
    : [64, 128, 238, 255]).flat());
  const levels = buildPbrTextureArrayMipLevels({
    ...defaults, width: 8, height: 8, normalLayers: [normal], alphaCutoffs: [null],
  });
  const filteredRoughness = levels[1].layers[0].material[1];

  assert.deepEqual(levels.map(({width, height}) => [width, height]), [[8, 8], [4, 4], [2, 2], [1, 1]]);
  assert.ok(filteredRoughness > 24 && filteredRoughness < 255);
  for (const level of levels.slice(1)) {
    for (let offset = 0; offset < level.layers[0].material.byteLength; offset += 4) {
      assert.deepEqual([...level.layers[0].material.subarray(offset, offset + 4)], [70, filteredRoughness, 90, 255]);
      assert.deepEqual([...level.layers[0].normal.subarray(offset, offset + 4)], [128, 128, 255, 255]);
    }
  }
});

test("cutout mips preserve the nearest representable alpha coverage per layer", () => {
  const alpha = [
    0, 0, 255, 255,
    0, 0, 0, 0,
    255, 255, 255, 255,
    255, 0, 255, 255,
  ];
  const albedo = Buffer.from(alpha.flatMap((value) => [80, 120, 160, value]));
  const defaults = layersFor(4, 4, [{albedo: [0, 0, 0, 0]}]);
  const levels = buildPbrTextureArrayMipLevels({
    ...defaults,
    width: 4,
    height: 4,
    albedoLayers: [albedo],
    alphaCutoffs: [0.45],
  });

  assert.equal(passingAlphaCount(levels[0].layers[0].albedo), 9);
  assert.equal(passingAlphaCount(levels[1].layers[0].albedo), 2);
  assert.equal(passingAlphaCount(levels[2].layers[0].albedo), 1);
  for (const level of levels) {
    for (const channel of channels.slice(1)) {
      for (let offset = 3; offset < level.layers[0].albedo.byteLength; offset += 4) {
        assert.equal(level.layers[0][channel][offset], level.layers[0].albedo[offset]);
      }
    }
  }
});

test("cutout mips keep sparse visible texels through the final level", () => {
  const albedo = solidLayer(4, 4, [0, 0, 0, 0]);
  albedo.set([220, 40, 20, 255], 0);
  const defaults = layersFor(4, 4, [{albedo: [0, 0, 0, 0]}]);
  const levels = buildPbrTextureArrayMipLevels({
    ...defaults,
    width: 4,
    height: 4,
    albedoLayers: [albedo],
    alphaCutoffs: [0.45],
  });

  for (const level of levels) assert.ok(passingAlphaCount(level.layers[0].albedo) >= 1);
  assert.deepEqual([...levels.at(-1).layers[0].albedo.slice(0, 3)], [220, 40, 20]);
});

test("cutout coverage breaks equal-alpha ties deterministically", () => {
  const albedo = solidLayer(8, 8, [0, 0, 0, 0]);
  for (const [x, y] of [[0, 0], [2, 0], [4, 0], [6, 0], [0, 2], [2, 2], [4, 2], [6, 2]]) {
    albedo.set([80, 120, 160, 255], (y * 8 + x) * 4);
  }
  const defaults = layersFor(8, 8, [{albedo: [0, 0, 0, 0]}]);
  const levels = buildPbrTextureArrayMipLevels({
    ...defaults,
    width: 8,
    height: 8,
    albedoLayers: [albedo],
    alphaCutoffs: [0.45],
  });

  assert.equal(passingAlphaCount(levels[0].layers[0].albedo), 8);
  assert.equal(passingAlphaCount(levels[1].layers[0].albedo), 2);
  assert.equal(passingAlphaCount(levels[2].layers[0].albedo), 1);
  assert.equal(passingAlphaCount(levels[3].layers[0].albedo), 1);
});

test("each array layer uses its own material alpha cutoff", () => {
  const albedo = Buffer.from([
    60, 90, 120, 0, 60, 90, 120, 0,
    60, 90, 120, 255, 60, 90, 120, 255,
  ]);
  const defaults = layersFor(2, 2, [
    {albedo: [0, 0, 0, 0]},
    {albedo: [0, 0, 0, 0]},
  ]);
  const levels = buildPbrTextureArrayMipLevels({
    ...defaults,
    width: 2,
    height: 2,
    albedoLayers: [albedo, albedo],
    alphaCutoffs: [null, 0.8],
  });

  assert.equal(levels[1].layers[0].albedo[3], 128);
  assert.ok(levels[1].layers[1].albedo[3] >= Math.ceil(0.8 * 255));
});

test("texture mip inputs reject missing channels, malformed layers, and invalid per-layer cutoffs", () => {
  const defaults = layersFor(2, 2, [{albedo: [0, 0, 0, 255]}]);
  assert.equal(buildPbrTextureArrayMipLevels({width: 2, height: 2, ...defaults, mipmaps: false, alphaCutoffs: [null]}).length, 1);
  assert.throws(() => buildPbrTextureArrayMipLevels({width: 2, height: 2, ...defaults, normalLayers: [], alphaCutoffs: [null]}), /normal must contain 1 layers/u);
  assert.throws(() => buildPbrTextureArrayMipLevels({width: 2, height: 2, ...defaults, materialLayers: [Buffer.alloc(15)], alphaCutoffs: [null]}), /16 RGBA8 bytes/u);
  assert.throws(() => buildPbrTextureArrayMipLevels({width: 2, height: 2, ...defaults, alphaCutoffs: []}), /must contain 1 entries/u);
  assert.throws(() => buildPbrTextureArrayMipLevels({width: 2, height: 2, ...defaults, alphaCutoffs: [0]}), /greater than zero through one/u);
});
