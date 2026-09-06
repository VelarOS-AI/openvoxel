import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import sharp from "sharp";
import {resolveTextureChannels, transformTangentNormal} from "../tools/texture-channels.mjs";

const profile = {
  normalStrength: 1,
  occlusionStrength: 0.25,
  roughness: 0.8,
  roughnessVariation: 0.1,
  metallic: 0.05,
  metallicVariation: 0.2,
  emissive: 1,
  emissiveThreshold: 0,
};

function pixel(source, size, x, y) {
  const offset = (y * size + x) * 4;
  return [...source.subarray(offset, offset + 4)];
}

function solid(size, value) {
  return Buffer.from(Array.from({length: size * size}, () => value).flat());
}

function horizontalGradient(size, alpha = 255) {
  const output = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const value = Math.round(x / (size - 1) * 255);
      output.set([value, value, value, alpha], offset);
    }
  }
  return output;
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "openvoxel-texture-channels-"));
  context.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

async function writePng(root, name, size, pixels) {
  await sharp(pixels, {raw: {width: size, height: size, channels: 4}}).png().toFile(join(root, name));
}

async function writeGrayPng(root, name, size, pixels) {
  await sharp(pixels, {raw: {width: size, height: size, channels: 1}})
    .toColourspace("b-w").png().toFile(join(root, name));
}

test("missing author maps deterministically fall back to albedo-derived PBR channels", async () => {
  const size = 3;
  const albedo = horizontalGradient(size);
  albedo[3] = 0;
  const output = await resolveTextureChannels({
    dataRoot: ".",
    tileSize: size,
    albedoPixels: albedo,
    profile,
    label: "fallback texture",
  });

  assert.deepEqual(output.sources, {normal: "generated", material: "generated", emissive: "generated"});
  assert.equal(output.normal.length, albedo.length);
  assert.equal(output.material.length, albedo.length);
  assert.equal(output.emissive.length, albedo.length);
  assert.deepEqual(pixel(output.normal, size, 0, 0), [128, 128, 255, 0]);
  assert.equal(pixel(output.normal, size, 1, 1)[0] < 128, true, "height rising to the right tilts the normal left");
  assert.deepEqual(
    [pixel(output.normal, size, 2, 2)[3], pixel(output.material, size, 2, 2)[3], pixel(output.emissive, size, 2, 2)[3]],
    [255, 255, 255],
  );
  assert.ok(pixel(output.emissive, size, 2, 1)[0] > pixel(output.emissive, size, 1, 1)[0]);

  const maskedEmission = await resolveTextureChannels({
    dataRoot: ".",
    tileSize: 1,
    albedoPixels: solid(1, [255, 255, 255, 64]),
    profile: {...profile, emissiveThreshold: 0.5},
    label: "alpha-masked fallback texture",
  });
  assert.deepEqual(pixel(maskedEmission.emissive, 1, 0, 0), [0, 0, 0, 64]);
});

test("authored channels follow ordered base and variant transforms", async (context) => {
  const root = await fixture(context);
  const size = 2;
  const normal = solid(size, [128, 128, 255, 255]);
  normal.set([255, 128, 128, 255], 0);
  await Promise.all([
    writePng(root, "normal.png", size, normal),
    writePng(root, "material.png", size, solid(size, [11, 22, 33, 17])),
    writePng(root, "emissive.png", size, solid(size, [44, 55, 66, 19])),
  ]);
  const albedo = solid(size, [90, 100, 110, 255]);
  albedo[(1 * size + 0) * 4 + 3] = 0;

  const output = await resolveTextureChannels({
    dataRoot: root,
    tileSize: size,
    albedoPixels: albedo,
    profile,
    sourceFiles: {normal: "normal.png", material: "material.png", emissive: "emissive.png"},
    transforms: [
      {rotate: 90, brightness: 0.9, contrast: 1.1},
      {flipY: true, hue: 30, saturation: 0.8},
    ],
    label: "authored texture",
  });

  assert.deepEqual(output.sources, {
    normal: "authored-normal",
    material: "authored-material",
    emissive: "authored-emissive",
  });
  const rotatedNormal = pixel(output.normal, size, 1, 1);
  assert.ok(Math.abs(rotatedNormal[0] - 128) <= 1);
  assert.ok(rotatedNormal[1] <= 1, "the second transform flips the rotated normal upward");
  assert.ok(Math.abs(rotatedNormal[2] - 128) <= 1);
  assert.deepEqual(pixel(output.material, size, 1, 1), [11, 22, 33, 255]);
  assert.deepEqual(pixel(output.emissive, size, 1, 1), [44, 55, 66, 255]);
  assert.deepEqual(pixel(output.material, size, 0, 1), [11, 22, 33, 0]);
  assert.deepEqual(pixel(output.emissive, size, 0, 1), [44, 55, 66, 0]);
});

test("an authored height map replaces only normal generation", async (context) => {
  const root = await fixture(context);
  const size = 3;
  const height = Buffer.from(Array.from({length: size * size}, (_value, index) => Math.round((index % size) / (size - 1) * 255)));
  await writeGrayPng(root, "height.png", size, height);
  const output = await resolveTextureChannels({
    dataRoot: root,
    tileSize: size,
    albedoPixels: solid(size, [160, 140, 120, 255]),
    profile,
    sourceFiles: {height: "height.png"},
    transforms: [null],
    label: "height texture",
  });

  assert.deepEqual(output.sources, {normal: "authored-height", material: "generated", emissive: "generated"});
  assert.equal(pixel(output.normal, size, 1, 1)[0] < 128, true);
});

test("all tangent-space normal orientations follow image rotation then flips", () => {
  const original = {x: 0.6, y: -0.3, z: Math.sqrt(0.55)};
  for (const rotate of [0, 90, 180, 270]) {
    for (const flipX of [false, true]) {
      for (const flipY of [false, true]) {
        let {x, y} = original;
        for (let angle = 0; angle < rotate; angle += 90) [x, y] = [-y, x];
        if (flipX) x = -x;
        if (flipY) y = -y;
        assert.deepEqual(
          transformTangentNormal(original, {rotate, flipX, flipY}),
          {x, y, z: original.z},
          `${rotate} degrees, flipX=${flipX}, flipY=${flipY}`,
        );
        const flat = transformTangentNormal({x: 0, y: 0, z: 1}, {rotate, flipX, flipY});
        assert.equal(Math.abs(flat.x), 0);
        assert.equal(Math.abs(flat.y), 0);
        assert.equal(flat.z, 1);
      }
    }
  }
  assert.throws(
    () => transformTangentNormal({x: 1, y: 0, z: 0}, {rotate: 45}),
    /rotate must be 0, 90, 180, or 270/u,
  );
});

test("channel declarations and authored images fail closed", async (context) => {
  const root = await fixture(context);
  const size = 2;
  const albedo = solid(size, [120, 120, 120, 255]);
  await Promise.all([
    writePng(root, "small.png", 1, solid(1, [128, 128, 255, 255])),
    writePng(root, "zero-normal.png", size, solid(size, [128, 128, 128, 255])),
    sharp({create: {width: size, height: size, channels: 3, background: {r: 128, g: 128, b: 255}}})
      .toColourspace("rgb16").png().toFile(join(root, "16-bit-normal.png")),
    sharp({create: {width: size, height: size, channels: 3, background: {r: 128, g: 128, b: 255}}})
      .withIccProfile("srgb").png().toFile(join(root, "profiled-normal.png")),
    writeGrayPng(root, "grayscale-normal.png", size, Buffer.alloc(size * size, 128)),
  ]);
  const options = {dataRoot: root, tileSize: size, albedoPixels: albedo, profile, label: "invalid texture"};

  await assert.rejects(
    resolveTextureChannels({...options, sourceFiles: {normal: "normal.png", height: "height.png"}}),
    /cannot declare both normal and height/u,
  );
  await assert.rejects(
    resolveTextureChannels({...options, sourceFiles: {normal: "small.png"}}),
    /must be a 2x2 PNG/u,
  );
  await assert.rejects(
    resolveTextureChannels({...options, sourceFiles: {normal: "zero-normal.png"}}),
    /zero-length normal/u,
  );
  await assert.rejects(
    resolveTextureChannels({...options, sourceFiles: {normal: "16-bit-normal.png"}}),
    /must use non-paletted 8-bit samples/u,
  );
  await assert.rejects(
    resolveTextureChannels({...options, sourceFiles: {normal: "profiled-normal.png"}}),
    /must not contain an ICC profile/u,
  );
  await assert.rejects(
    resolveTextureChannels({...options, sourceFiles: {normal: "grayscale-normal.png"}}),
    /must use RGB or RGBA channels/u,
  );
  await assert.rejects(
    resolveTextureChannels({...options, sourceFiles: {normal: "../outside.png"}}),
    /escapes the resource data directory/u,
  );
  await assert.rejects(
    resolveTextureChannels({...options, sourceFiles: {roughness: "roughness.png"}}),
    /unknown channel roughness/u,
  );
  await assert.rejects(
    resolveTextureChannels({...options, sourceFiles: {orm: "orm.png"}}),
    /unknown channel orm/u,
  );
});
