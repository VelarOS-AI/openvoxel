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
