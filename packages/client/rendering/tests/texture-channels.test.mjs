import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import sharp from "sharp";
import {resolveTextureChannels, transformTangentNormal} from "../tools/texture-channels.mjs";

const profile = {
  normalFallback: "albedo-height",
  materialFallback: "albedo-derived",
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

test("albedo-derived fallback deterministically resolves missing normal and material maps", async () => {
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

  assert.deepEqual(output.sources, {
    normal: "fallback-albedo-height",
    material: "fallback-albedo-derived",
    emissive: "generated",
  });
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

test("flat normal and uniform material fallbacks ignore albedo detail while preserving alpha", async () => {
  const size = 2;
  const albedo = Buffer.from([
    0, 20, 255, 255,
    255, 220, 0, 128,
    70, 90, 110, 0,
    180, 30, 140, 255,
  ]);
  const output = await resolveTextureChannels({
    dataRoot: ".",
    tileSize: size,
    albedoPixels: albedo,
    profile: {...profile, normalFallback: "flat", materialFallback: "uniform"},
    label: "uniform fallback texture",
  });

  assert.deepEqual(output.sources, {normal: "fallback-flat", material: "fallback-uniform", emissive: "generated"});
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = pixel(albedo, size, x, y)[3];
      assert.deepEqual(pixel(output.normal, size, x, y), [128, 128, 255, alpha]);
      assert.deepEqual(pixel(output.material, size, x, y), [255, 204, 13, alpha]);
    }
  }
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
  assert.ok(rotatedNormal[1] >= 254, "the vertical flip turns the clockwise-rotated normal toward tangent +Y");
  assert.ok(Math.abs(rotatedNormal[2] - 128) <= 1);
  assert.deepEqual(pixel(output.material, size, 1, 1), [11, 22, 33, 255]);
  assert.deepEqual(pixel(output.emissive, size, 1, 1), [44, 55, 66, 255]);
  assert.deepEqual(pixel(output.material, size, 0, 1), [11, 22, 33, 0]);
  assert.deepEqual(pixel(output.emissive, size, 0, 1), [44, 55, 66, 0]);
});

test("authored normal strength flattens or amplifies XY before renormalizing and keeps transparent edges flat", async (context) => {
  const root = await fixture(context);
  const size = 2;
  await writePng(root, "normal.png", size, solid(size, [180, 160, 240, 255]));
  const albedo = solid(size, [90, 100, 110, 255]);
  albedo[3] = 0;
  const outputs = new Map();
  for (const strength of [0, 0.5, 2]) {
    outputs.set(strength, await resolveTextureChannels({
      dataRoot: root,
      tileSize: size,
      albedoPixels: albedo,
      profile: {...profile, normalStrength: strength},
      sourceFiles: {normal: "normal.png"},
      label: `authored normal strength ${strength}`,
    }));
  }

  assert.deepEqual(pixel(outputs.get(0).normal, size, 1, 0), [128, 128, 255, 255]);
  for (const output of outputs.values()) {
    assert.equal(output.sources.normal, "authored-normal");
    assert.deepEqual(pixel(output.normal, size, 0, 0), [128, 128, 255, 0]);
  }
  const decode = (bytes) => bytes.slice(0, 3).map((value) => value / 255 * 2 - 1);
  const weak = decode(pixel(outputs.get(0.5).normal, size, 1, 0));
  const strong = decode(pixel(outputs.get(2).normal, size, 1, 0));
  assert.ok(Math.hypot(weak[0], weak[1]) < Math.hypot(strong[0], strong[1]));
  assert.ok(weak[2] > strong[2]);
  for (const normal of [weak, strong]) assert.ok(Math.abs(Math.hypot(...normal) - 1) < 0.01);
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

  assert.deepEqual(output.sources, {
    normal: "authored-height",
    material: "fallback-albedo-derived",
    emissive: "generated",
  });
  const center = pixel(output.normal, size, 1, 1);
  assert.equal(center[0] < 128, true);
  assert.ok(center[2] > 128, "height normals must encode positive Z in signed tangent space");

  const rotated = await resolveTextureChannels({
    dataRoot: root,
    tileSize: size,
    albedoPixels: solid(size, [160, 140, 120, 255]),
    profile,
    sourceFiles: {height: "height.png"},
    transforms: [{rotate: 90}],
    label: "rotated height texture",
  });
  const rotatedCenter = pixel(rotated.normal, size, 1, 1);
  assert.ok(Math.abs(rotatedCenter[0] - 128) <= 1, "clockwise height rotation removes the horizontal slope");
  assert.ok(rotatedCenter[1] > 128, "clockwise height rotation tilts the tangent normal upward");
  assert.ok(rotatedCenter[2] > 128, "rotated height normal must keep positive Z");
});

test("transparent height neighbors extend the visible center instead of creating silhouette cliffs", async (context) => {
  const root = await fixture(context);
  const size = 3;
  await writeGrayPng(root, "uniform-height.png", size, Buffer.alloc(size * size, 190));
  const albedo = solid(size, [190, 190, 190, 255]);
  for (let y = 0; y < size; y += 1) albedo[(y * size) * 4 + 3] = 0;

  for (const sourceFiles of [{height: "uniform-height.png"}, {}]) {
    const output = await resolveTextureChannels({
      dataRoot: root,
      tileSize: size,
      albedoPixels: albedo,
      profile,
      sourceFiles,
      label: sourceFiles.height == null ? "albedo-height transparent edge" : "authored-height transparent edge",
    });
    assert.deepEqual(pixel(output.normal, size, 1, 1), [128, 128, 255, 255]);
    assert.deepEqual(pixel(output.normal, size, 0, 1), [128, 128, 255, 0]);
  }
});

test("all tangent-space normal orientations follow image rotation then flips", () => {
  const original = {x: 0.6, y: -0.3, z: Math.sqrt(0.55)};
  for (const rotate of [0, 90, 180, 270]) {
    for (const flipX of [false, true]) {
      for (const flipY of [false, true]) {
        let {x, y} = original;
        for (let angle = 0; angle < rotate; angle += 90) [x, y] = [y, -x];
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
  await assert.rejects(
    resolveTextureChannels({...options, profile: {...profile, normalFallback: "procedural"}}),
    /normalFallback must be flat or albedo-height/u,
  );
  await assert.rejects(
    resolveTextureChannels({...options, profile: {...profile, materialFallback: "procedural"}}),
    /materialFallback must be uniform or albedo-derived/u,
  );
});
