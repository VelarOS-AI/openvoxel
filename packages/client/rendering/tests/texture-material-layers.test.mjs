import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import sharp from "sharp";
import {buildTextureArray} from "../tools/texture-array.mjs";
import {composeMaterialLayer} from "../tools/texture-material-layers.mjs";

const channels = ["albedo", "normal", "material", "emissive"];
const profile = {
  normalStrength: 1,
  occlusionStrength: 0.25,
  roughness: 0.8,
  roughnessVariation: 0.1,
  metallic: 0,
  metallicVariation: 0,
  emissive: 0,
  emissiveThreshold: 1,
};

function surface({
  albedo = [80, 90, 100, 255],
  normal = [128, 128, 255, 255],
  material = [255, 128, 0, 255],
  emissive = [0, 0, 0, 255],
} = {}) {
  return Object.fromEntries(Object.entries({albedo, normal, material, emissive})
    .map(([channel, value]) => [channel, Buffer.from(value)]));
}

function decodedNormal(bytes) {
  const normal = [...bytes.subarray(0, 3)].map((value) => value / 255 * 2 - 1);
  return {normal, length: Math.hypot(...normal)};
}

test("zero material-layer coverage preserves every input channel without mutation", () => {
  const base = surface();
  const layer = surface({
    albedo: [220, 30, 10, 255],
    normal: [255, 128, 128, 255],
    material: [80, 20, 240, 255],
    emissive: [255, 255, 255, 255],
  });
  const snapshots = Object.fromEntries(channels.flatMap((channel) => [
    [`base-${channel}`, Buffer.from(base[channel])],
    [`layer-${channel}`, Buffer.from(layer[channel])],
  ]));

  for (const options of [
    {mask: Buffer.from([0, 0, 0, 255])},
    {opacity: 0},
  ]) {
    const output = composeMaterialLayer(base, layer, options);
    for (const channel of channels) assert.deepEqual(output[channel], base[channel]);
  }
  const transparent = surface({
    albedo: [220, 30, 10, 0],
    normal: [128, 128, 255, 0],
    material: [255, 128, 0, 0],
    emissive: [0, 0, 0, 0],
  });
  const transparentOutput = composeMaterialLayer(base, transparent);
  for (const channel of channels) assert.deepEqual(transparentOutput[channel], base[channel]);
  for (const channel of channels) {
    assert.deepEqual(base[channel], snapshots[`base-${channel}`]);
    assert.deepEqual(layer[channel], snapshots[`layer-${channel}`]);
  }
});

test("material surfaces reject channel alpha disagreement at the pure composition boundary", () => {
  const invalidBase = surface();
  invalidBase.normal[3] = 0;
  assert.throws(
    () => composeMaterialLayer(invalidBase, surface()),
    /Base material surface channels must share alpha at pixel 0/u,
  );

  const invalidLayer = surface();
  invalidLayer.emissive[3] = 0;
  assert.throws(
    () => composeMaterialLayer(surface(), invalidLayer),
    /Material layer surface channels must share alpha at pixel 0/u,
  );
});

test("one coverage value drives linear-light albedo, normalized normal, ORM, emissive, and shared alpha", () => {
  const base = surface({
    albedo: [0, 0, 0, 255],
    material: [128, 51, 26, 255],
    emissive: [128, 0, 0, 255],
  });
  const layer = surface({
    albedo: [255, 255, 255, 255],
    normal: [255, 128, 128, 255],
    material: [128, 204, 230, 255],
    emissive: [0, 128, 0, 255],
  });
  const output = composeMaterialLayer(base, layer, {opacity: 0.5});

  for (const value of output.albedo.subarray(0, 3)) assert.ok(value >= 187 && value <= 188, `linear albedo ${value}`);
  const normal = decodedNormal(output.normal);
  assert.ok(output.normal[0] >= 217 && output.normal[0] <= 219);
  assert.ok(output.normal[1] >= 127 && output.normal[1] <= 129);
  assert.ok(output.normal[2] >= 217 && output.normal[2] <= 219);
  assert.ok(Math.abs(normal.length - 1) < 0.01, `normal length ${normal.length}`);
  assert.ok(output.material[0] >= 95 && output.material[0] <= 97, `multiplicative AO ${output.material[0]}`);
  assert.equal(output.material[1], 128);
  assert.equal(output.material[2], 128);
  assert.deepEqual([...output.emissive.subarray(0, 3)], [128, 92, 0]);
  for (const channel of channels) assert.equal(output[channel][3], 255, `${channel} alpha`);
});

test("every blend mode remains continuous across transparent base edges", () => {
  const layer = surface({
    albedo: [240, 180, 20, 191],
    normal: [40, 230, 160, 191],
    material: [128, 220, 16, 191],
    emissive: [20, 160, 80, 191],
  });
  const baseAt = (alpha) => surface({
    albedo: [9, 30, 240, alpha],
    normal: [220, 65, 180, alpha],
    material: [64, 20, 240, alpha],
    emissive: [150, 10, 200, alpha],
  });

  for (const blend of ["normal", "multiply", "overlay"]) {
    const outputs = [0, 1, 128, 255]
      .map((alpha) => composeMaterialLayer(baseAt(alpha), layer, {opacity: 0.6, blend}));
    for (const channel of channels) {
      for (let component = 0; component < 4; component += 1) {
        const delta = Math.abs(outputs[0][channel][component] - outputs[1][channel][component]);
        assert.ok(delta <= 12, `${blend} ${channel}[${component}] changed by ${delta} at base alpha 0 -> 1`);
      }
    }
    for (const output of outputs) {
      const alpha = output.albedo[3];
      for (const channel of channels.slice(1)) assert.equal(output[channel][3], alpha, `${blend} ${channel} alpha`);
      assert.ok(Math.abs(decodedNormal(output.normal).length - 1) < 0.01, `${blend} normal must remain normalized`);
    }
    const alphas = outputs.map((output) => output.albedo[3]);
    assert.deepEqual(alphas, [...alphas].sort((left, right) => left - right), `${blend} output alpha must be monotonic`);
    assert.ok(alphas.at(-1) > alphas[0], `${blend} must retain increasing base coverage`);
  }
});

test("multiply composition preserves the alpha-edge reference table", () => {
  const baseAt = (alpha) => surface({
    albedo: [10, 10, 10, alpha],
    normal: [255, 128, 128, alpha],
    material: [64, 10, 250, alpha],
    emissive: [255, 0, 0, alpha],
  });
  const layer = surface({
    albedo: [240, 240, 240, 255],
    normal: [128, 255, 128, 255],
    material: [128, 240, 10, 255],
    emissive: [0, 0, 255, 255],
  });
  const expected = [
    {alpha: 128, albedo: [240, 240, 240], normal: [128, 255, 128], material: [128, 240, 10], emissive: [0, 0, 255]},
    {alpha: 128, albedo: [239, 239, 239], normal: [129, 255, 128], material: [127, 239, 11], emissive: [22, 0, 255]},
    {alpha: 192, albedo: [147, 147, 147], normal: [216, 219, 128], material: [75, 163, 90], emissive: [213, 0, 213]},
    {alpha: 255, albedo: [9, 9, 9], normal: [245, 177, 128], material: [48, 125, 130], emissive: [255, 0, 188]},
  ];

  for (const [index, alpha] of [0, 1, 128, 255].entries()) {
    const output = composeMaterialLayer(baseAt(alpha), layer, {opacity: 0.5, blend: "multiply"});
    for (const channel of channels) {
      assert.deepEqual([...output[channel].subarray(0, 3)], expected[index][channel], `${channel} at base alpha ${alpha}`);
      assert.equal(output[channel][3], expected[index].alpha, `${channel} alpha at base alpha ${alpha}`);
    }
  }
});

test("material layer order is deterministic and semantically significant", () => {
  const base = surface({albedo: [90, 130, 180, 255]});
  const red = surface({
    albedo: [230, 30, 20, 255],
    normal: [230, 128, 205, 255],
    emissive: [100, 0, 0, 255],
  });
  const blue = surface({
    albedo: [20, 60, 240, 255],
    normal: [128, 230, 205, 255],
    emissive: [0, 0, 100, 255],
  });
  const redBlue = composeMaterialLayer(composeMaterialLayer(base, red, {opacity: 0.6, blend: "overlay"}), blue, {opacity: 0.4});
  const blueRed = composeMaterialLayer(composeMaterialLayer(base, blue, {opacity: 0.4}), red, {opacity: 0.6, blend: "overlay"});
  const repeated = composeMaterialLayer(composeMaterialLayer(base, red, {opacity: 0.6, blend: "overlay"}), blue, {opacity: 0.4});

  assert.notDeepEqual(redBlue.albedo, blueRed.albedo);
  assert.notDeepEqual(redBlue.normal, blueRed.normal);
  for (const channel of channels) assert.deepEqual(redBlue[channel], repeated[channel]);
});

async function writeRgba(root, name, rgba) {
  const pixels = Buffer.from(Array.from({length: 4}, () => rgba).flat());
  await sharp(pixels, {raw: {width: 2, height: 2, channels: 4}}).png().toFile(join(root, name));
}

async function writePixels(root, name, pixels) {
  await sharp(Buffer.from(pixels.flat()), {raw: {width: 2, height: 2, channels: 4}})
    .png().toFile(join(root, name));
}

async function writeSizedRgba(root, name, size, rgba) {
  const pixels = Buffer.from(Array.from({length: size * size}, () => rgba).flat());
  await sharp(pixels, {raw: {width: size, height: size, channels: 4}}).png().toFile(join(root, name));
}

async function writeSizedGray(root, name, size, pixels) {
  await sharp(Buffer.from(pixels), {raw: {width: size, height: size, channels: 1}})
    .toColourspace("b-w").png().toFile(join(root, name));
}

function arrayPixel(level, channel, layer) {
  const bytes = level[`${channel}Bytes`];
  return [...bytes.subarray(layer * 16, layer * 16 + 4)];
}

test("texture arrays accept authored base maps plus a masked channel-aware material layer", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openvoxel-material-layers-"));
  context.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeRgba(root, "base.png", [48, 48, 48, 255]),
    writeRgba(root, "base-normal.png", [128, 128, 255, 255]),
    writeRgba(root, "base-material.png", [255, 51, 0, 255]),
    writeRgba(root, "layer.png", [240, 240, 240, 255]),
    writeRgba(root, "layer-normal.png", [255, 128, 128, 255]),
    writeRgba(root, "layer-material.png", [128, 204, 230, 255]),
    writeRgba(root, "layer-emissive.png", [0, 128, 0, 255]),
    writeRgba(root, "mask.png", [128, 128, 128, 255]),
  ]);
  const built = await buildTextureArray({
    dataRoot: root,
    array: {tileSize: 2, maximumLayers: 8, mipmaps: false},
    surfaceProfiles: new Map([["rock", profile]]),
    textureSources: [{
      key: "openvoxel:texture/block/layered",
      category: "terrain",
      surface: "rock",
      file: "base.png",
      maps: {
        normal: {file: "base-normal.png"},
        material: {file: "base-material.png"},
      },
      variants: [{
        transform: {rotate: 180},
        layers: [{
          albedo: {file: "layer.png"},
          maps: {
            normal: {file: "layer-normal.png"},
            material: {file: "layer-material.png"},
            emissive: {file: "layer-emissive.png"},
          },
          mask: {file: "mask.png"},
          opacity: 0.5,
          blend: "normal",
          transform: {flipX: true},
        }],
      }],
    }],
  });
  const level = built.levels[0];
  const base = Object.fromEntries(channels.map((channel) => [channel, arrayPixel(level, channel, 0)]));
  const layered = Object.fromEntries(channels.map((channel) => [channel, arrayPixel(level, channel, 1)]));

  assert.ok(layered.albedo[0] > base.albedo[0]);
  assert.ok(layered.normal[0] > 128, "the local X flip followed by the global 180 degree rotation points the layer normal toward +X");
  assert.ok(layered.normal[2] < base.normal[2]);
  assert.ok(layered.material[0] < base.material[0]);
  assert.ok(layered.material[1] > base.material[1]);
  assert.ok(layered.material[2] > base.material[2]);
  assert.ok(layered.emissive[1] > 0);
  for (const channel of channels) assert.equal(layered[channel][3], layered.albedo[3]);
  assert.deepEqual(built.audit.channelSources, {
    normal: {"authored-normal": 1, composed: 1},
    material: {"authored-material": 1, composed: 1},
    emissive: {generated: 1, composed: 1},
  });
  assert.equal(built.audit.variants.length, 2);
  assert.deepEqual(built.audit.variants[0].channels, {
    albedo: {mode: "authored-albedo", inputs: ["authored-albedo"]},
    normal: {mode: "authored-normal", inputs: ["authored-normal"]},
    material: {mode: "authored-material", inputs: ["authored-material"]},
    emissive: {mode: "generated", inputs: ["generated"]},
  });
  assert.deepEqual(built.audit.variants[1].channels, {
    albedo: {mode: "composed", inputs: ["authored-albedo"]},
    normal: {mode: "composed", inputs: ["authored-normal"]},
    material: {mode: "composed", inputs: ["authored-material"]},
    emissive: {mode: "composed", inputs: ["authored-emissive", "generated"]},
  });
  assert.equal(built.audit.channels.emissive, 1);
});

test("layer and variant transforms keep masks and every PBR channel registered", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openvoxel-material-layer-registration-"));
  context.after(() => rm(root, {recursive: true, force: true}));
  const transparent = [0, 0, 0, 0];
  await Promise.all([
    writeRgba(root, "base.png", [32, 32, 32, 255]),
    writeRgba(root, "base-normal.png", [128, 128, 255, 255]),
    writeRgba(root, "base-material.png", [255, 64, 0, 255]),
    writePixels(root, "layer.png", [[240, 20, 20, 255], transparent, transparent, transparent]),
    writePixels(root, "layer-normal.png", [[255, 128, 128, 255], transparent, transparent, transparent]),
    writePixels(root, "layer-material.png", [[128, 220, 240, 255], transparent, transparent, transparent]),
    writePixels(root, "layer-emissive.png", [[0, 200, 0, 255], transparent, transparent, transparent]),
    writePixels(root, "mask.png", [[255, 255, 255, 128], transparent, transparent, transparent]),
  ]);
  const built = await buildTextureArray({
    dataRoot: root,
    array: {tileSize: 2, maximumLayers: 8, mipmaps: false},
    surfaceProfiles: new Map([["rock", profile]]),
    textureSources: [{
      key: "openvoxel:texture/block/registered-layer",
      category: "terrain",
      surface: "rock",
      file: "base.png",
      maps: {
        normal: {file: "base-normal.png"},
        material: {file: "base-material.png"},
      },
      variants: [{
        transform: {flipX: true, shiftY: 1},
        layers: [{
          albedo: {file: "layer.png"},
          maps: {
            normal: {file: "layer-normal.png"},
            material: {file: "layer-material.png"},
            emissive: {file: "layer-emissive.png"},
          },
          mask: {file: "mask.png"},
          transform: {rotate: 90},
        }],
      }],
    }],
  });
  const level = built.levels[0];
  const layerBytes = 2 * 2 * 4;
  const base = Object.fromEntries(channels.map((channel) => [channel, level[`${channel}Bytes`].subarray(0, layerBytes)]));
  const composed = Object.fromEntries(channels.map((channel) => [channel, level[`${channel}Bytes`].subarray(layerBytes, layerBytes * 2)]));
  const changedPixels = [];
  for (let pixel = 0; pixel < 4; pixel += 1) {
    const offset = pixel * 4;
    if (composed.albedo[offset] !== base.albedo[offset]) changedPixels.push(pixel);
  }

  assert.equal(changedPixels.length, 1);
  const changedOffset = changedPixels[0] * 4;
  assert.ok(composed.albedo[changedOffset] > base.albedo[changedOffset]);
  assert.ok(composed.albedo[changedOffset] < 220, "mask alpha must reduce material-layer coverage");
  assert.notDeepEqual(composed.normal.subarray(changedOffset, changedOffset + 3), base.normal.subarray(changedOffset, changedOffset + 3));
  assert.notDeepEqual(composed.material.subarray(changedOffset, changedOffset + 3), base.material.subarray(changedOffset, changedOffset + 3));
  assert.ok(composed.emissive[changedOffset + 1] > 0);
  for (let pixel = 0; pixel < 4; pixel += 1) {
    if (pixel === changedPixels[0]) continue;
    const offset = pixel * 4;
    for (const channel of channels) {
      const actual = composed[channel].subarray(offset, offset + 4);
      const expected = base[channel].subarray(offset, offset + 4);
      if (channel === "normal") {
        for (let index = 0; index < 4; index += 1) assert.ok(Math.abs(actual[index] - expected[index]) <= 1);
      } else {
        assert.deepEqual(actual, expected);
      }
    }
  }
});

test("local height transforms precede normal generation and preserve tangent orientation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openvoxel-height-transform-"));
  context.after(() => rm(root, {recursive: true, force: true}));
  const size = 3;
  await Promise.all([
    writeSizedRgba(root, "base.png", size, [120, 110, 100, 255]),
    writeSizedGray(root, "height.png", size, [0, 128, 255, 0, 128, 255, 0, 128, 255]),
  ]);
  const built = await buildTextureArray({
    dataRoot: root,
    array: {tileSize: size, maximumLayers: 1, mipmaps: false},
    surfaceProfiles: new Map([["rock", profile]]),
    textureSources: [{
      key: "openvoxel:texture/block/rotated-height",
      category: "terrain",
      surface: "rock",
      file: "base.png",
      maps: {height: {file: "height.png"}},
      transform: {rotate: 90},
    }],
  });
  const centerOffset = (1 * size + 1) * 4;
  const normal = [...built.levels[0].normalBytes.subarray(centerOffset, centerOffset + 4)];
  assert.ok(Math.abs(normal[0] - 128) <= 1, `rotated normal X ${normal[0]}`);
  assert.ok(normal[1] > 128, `rotated normal Y ${normal[1]}`);
  assert.ok(normal[2] > 128, `rotated normal Z ${normal[2]}`);
  assert.equal(normal[3], 255);
});

test("PBR-only material variants may preserve albedo while changing the complete surface", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openvoxel-pbr-only-variant-"));
  context.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeRgba(root, "base.png", [80, 110, 140, 255]),
    writeRgba(root, "base-normal.png", [128, 128, 255, 255]),
    writeRgba(root, "base-material.png", [255, 180, 0, 255]),
    writeRgba(root, "detail.png", [255, 255, 255, 255]),
    writeRgba(root, "detail-normal.png", [210, 128, 230, 255]),
    writeRgba(root, "detail-material.png", [128, 30, 220, 255]),
  ]);
  const built = await buildTextureArray({
    dataRoot: root,
    array: {tileSize: 2, maximumLayers: 2, mipmaps: false},
    surfaceProfiles: new Map([["rock", profile]]),
    textureSources: [{
      key: "openvoxel:texture/block/pbr-only",
      category: "terrain",
      surface: "rock",
      file: "base.png",
      maps: {normal: {file: "base-normal.png"}, material: {file: "base-material.png"}},
      variants: [{layers: [{
        albedo: {file: "detail.png"},
        maps: {normal: {file: "detail-normal.png"}, material: {file: "detail-material.png"}},
        blend: "multiply",
      }]}],
    }],
  });
  const level = built.levels[0];
  const layerBytes = 2 * 2 * 4;
  const base = Object.fromEntries(channels.map((channel) => [channel, level[`${channel}Bytes`].subarray(0, layerBytes)]));
  const variant = Object.fromEntries(channels.map((channel) => [channel, level[`${channel}Bytes`].subarray(layerBytes, layerBytes * 2)]));
  assert.deepEqual(variant.albedo, base.albedo);
  assert.notDeepEqual(variant.normal, base.normal);
  assert.notDeepEqual(variant.material, base.material);
});

test("color-only variants preserve authored PBR bytes without normal requantization", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openvoxel-color-only-variant-"));
  context.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeRgba(root, "base.png", [70, 90, 120, 255]),
    writeRgba(root, "normal.png", [0, 0, 168, 255]),
    writeRgba(root, "material.png", [210, 130, 40, 255]),
    writeRgba(root, "emissive.png", [12, 20, 28, 255]),
  ]);
  const built = await buildTextureArray({
    dataRoot: root,
    array: {tileSize: 2, maximumLayers: 2, mipmaps: false},
    surfaceProfiles: new Map([["rock", profile]]),
    textureSources: [{
      key: "openvoxel:texture/block/color-only",
      category: "terrain",
      surface: "rock",
      file: "base.png",
      maps: {
        normal: {file: "normal.png"},
        material: {file: "material.png"},
        emissive: {file: "emissive.png"},
      },
      variants: [{transform: {brightness: 1.2}}],
    }],
  });
  const level = built.levels[0];
  const layerBytes = 2 * 2 * 4;
  const base = Object.fromEntries(channels.map((channel) => [channel, level[`${channel}Bytes`].subarray(0, layerBytes)]));
  const variant = Object.fromEntries(channels.map((channel) => [channel, level[`${channel}Bytes`].subarray(layerBytes, layerBytes * 2)]));
  assert.notDeepEqual(variant.albedo, base.albedo);
  for (const channel of ["normal", "material", "emissive"]) assert.deepEqual(variant[channel], base[channel], channel);
});
