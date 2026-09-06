import assert from "node:assert/strict";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";
import sharp from "sharp";
import {stringify} from "yaml";
import {loadResourceManifest} from "../tools/resource-manifest.mjs";

const surfaceProfile = {
  key: "rock",
  normalStrength: 1,
  occlusionStrength: 0.2,
  roughness: 0.8,
  roughnessVariation: 0.1,
  metallic: 0,
  metallicVariation: 0,
  emissive: 0,
  emissiveThreshold: 1,
};

async function imageBytes(format = "png") {
  const image = sharp({create: {width: 2, height: 2, channels: 4, background: {r: 128, g: 128, b: 255, alpha: 1}}});
  return format === "webp" ? image.webp().toBuffer() : image.png().toBuffer();
}

async function fixture(context, {formatVersion = 5, maps = {}, variants = []} = {}) {
  const root = await mkdtemp(join(tmpdir(), "openvoxel-resource-manifest-"));
  context.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    mkdir(join(root, "environment"), {recursive: true}),
    mkdir(join(root, "textures", "terrain", "maps"), {recursive: true}),
  ]);
  const texture = {
    key: "openvoxel:texture/block/stone",
    surface: "rock",
    file: "textures/terrain/stone.png",
    maps,
    variants,
  };
  const manifest = {
    formatVersion,
    owner: "openvoxel",
    textureCatalogs: ["textures/terrain.yml"],
    texturePipeline: {tileSize: 2, atlasPadding: 2, maximumAtlasColumns: 1, mipmaps: true},
    environment: {clouds: "environment/clouds.webp"},
    surfaceProfiles: [surfaceProfile],
  };
  const referencedFiles = [texture.file, ...Object.values(maps).map(({file}) => file)];
  await Promise.all([
    writeFile(join(root, "resource-pack.yml"), stringify(manifest)),
    writeFile(join(root, "textures", "terrain.yml"), stringify({category: "terrain", textures: [texture]})),
    writeFile(join(root, "environment", "clouds.webp"), await imageBytes("webp")),
    ...referencedFiles.map(async (file) => {
      const path = join(root, file);
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, await imageBytes());
    }),
  ]);
  return {root, manifestPath: join(root, "resource-pack.yml")};
}

test("author format v5 normalizes optional PBR map declarations", async (context) => {
  const maps = {
    height: {file: "textures/terrain/maps/stone.height.png"},
    material: {file: "textures/terrain/maps/stone.material.png"},
    emissive: {file: "textures/terrain/maps/stone.emissive.png"},
  };
  const {root, manifestPath} = await fixture(context, {maps});
  const source = await loadResourceManifest(root, manifestPath);
  assert.deepEqual(source.textures[0].maps, maps);
  assert.equal(source.imageFiles.length, 5);
  assert.deepEqual(source.unusedFiles, []);
});

test("author map schema rejects ambiguous, unknown, misplaced, and stale declarations", async (context) => {
  const conflict = await fixture(context, {maps: {
    normal: {file: "textures/terrain/maps/stone.normal.png"},
    height: {file: "textures/terrain/maps/stone.height.png"},
  }});
  await assert.rejects(loadResourceManifest(conflict.root, conflict.manifestPath), /cannot declare both normal and height maps/u);

  const unknown = await fixture(context, {maps: {roughness: {file: "textures/terrain/maps/stone.roughness.png"}}});
  await assert.rejects(loadResourceManifest(unknown.root, unknown.manifestPath), /contains unknown map roughness/u);

  const misplaced = await fixture(context, {maps: {normal: {file: "textures/fluid/stone.normal.png"}}});
  await assert.rejects(loadResourceManifest(misplaced.root, misplaced.manifestPath), /must use a PNG inside textures\/terrain/u);

  const categoryEscape = await fixture(context, {
    maps: {normal: {file: "textures/terrain/../fluid/stone.normal.png"}},
  });
  await assert.rejects(
    loadResourceManifest(categoryEscape.root, categoryEscape.manifestPath),
    /must use a PNG inside textures\/terrain/u,
  );

  const layered = await fixture(context, {
    maps: {normal: {file: "textures/terrain/maps/stone.normal.png"}},
    variants: [{layers: [{file: "textures/terrain/overlay.png"}]}],
  });
  await assert.rejects(
    loadResourceManifest(layered.root, layered.manifestPath),
    /cannot combine author maps with albedo layers/u,
  );

  const stale = await fixture(context, {formatVersion: 4});
  await assert.rejects(loadResourceManifest(stale.root, stale.manifestPath), /Unsupported client resource pack source format/u);
});
