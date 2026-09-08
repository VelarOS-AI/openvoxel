import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";
import sharp from "sharp";
import {parse, stringify} from "yaml";
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

const environment = {
  sky: {
    sun: "environment/sky/sun.webp",
    glow: "environment/sky/sky-glow.webp",
    star: "environment/sky/star.webp",
    moons: Array.from({length: 8}, (_value, index) => `environment/sky/moon-${String(index + 1).padStart(2, "0")}.webp`),
  },
  clouds: {texture: "environment/sky/clouds.webp"},
  precipitation: {
    rain: "environment/weather/rain.webp",
    rainSplash: "environment/weather/rain-splash.webp",
    snow: "environment/weather/snow.webp",
  },
};

const environmentFiles = [
  environment.sky.sun,
  environment.sky.glow,
  environment.sky.star,
  ...environment.sky.moons,
  environment.clouds.texture,
  environment.precipitation.rain,
  environment.precipitation.rainSplash,
  environment.precipitation.snow,
];

async function imageBytes(format = "png") {
  const image = sharp({create: {width: 2, height: 2, channels: 4, background: {r: 128, g: 128, b: 255, alpha: 1}}});
  return format === "webp" ? image.webp().toBuffer() : image.png().toBuffer();
}

async function fixture(context, {formatVersion = 9, maps = {}, variants = [], texturePipeline = null} = {}) {
  const root = await mkdtemp(join(tmpdir(), "openvoxel-resource-manifest-"));
  context.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    mkdir(join(root, "environment", "sky"), {recursive: true}),
    mkdir(join(root, "environment", "weather"), {recursive: true}),
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
    texturePipeline: texturePipeline ?? {tileSize: 2, maximumArrayLayers: 32, mipmaps: true},
    environment,
    surfaceProfiles: [surfaceProfile],
    models: [],
    materials: [],
    tints: [],
    animations: [],
  };
  const referencedFiles = new Set([
    texture.file,
    ...Object.values(maps).map(({file}) => file),
    ...variants.flatMap((variant) => (variant.layers ?? []).flatMap((layer) => [
      layer.albedo?.file,
      ...Object.values(layer.maps ?? {}).map(({file}) => file),
      layer.mask?.file,
    ])),
  ].filter((file) => file != null));
  const catalogPath = join(root, "textures", "terrain.yml");
  await Promise.all([
    writeFile(join(root, "resource-pack.yml"), stringify(manifest)),
    writeFile(catalogPath, stringify({category: "terrain", textures: [texture]})),
    ...environmentFiles.map(async (file) => writeFile(join(root, file), await imageBytes("webp"))),
    ...[...referencedFiles].map(async (file) => {
      const path = join(root, file);
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, await imageBytes());
    }),
  ]);
  return {root, manifestPath: join(root, "resource-pack.yml"), catalogPath};
}

async function updateYaml(path, update) {
  const document = parse(await readFile(path, "utf8"));
  update(document);
  await writeFile(path, stringify(document));
}

test("author format v9 normalizes optional PBR map declarations and array limits", async (context) => {
  const maps = {
    height: {file: "textures/terrain/maps/stone.height.png"},
    material: {file: "textures/terrain/maps/stone.material.png"},
    emissive: {file: "textures/terrain/maps/stone.emissive.png"},
  };
  const {root, manifestPath} = await fixture(context, {maps});
  const source = await loadResourceManifest(root, manifestPath);
  assert.deepEqual(source.textures[0].maps, maps);
  assert.deepEqual(source.packing, {tileSize: 2, maximumLayers: 32, mipmaps: true});
  assert.equal(source.imageFiles.length, 19);
  assert.deepEqual(source.unusedFiles, []);
});

test("environment schema is closed and requires eight distinct moon phases", async (context) => {
  const valid = await fixture(context);
  const source = await loadResourceManifest(valid.root, valid.manifestPath);
  assert.deepEqual(source.environment, environment);
  assert.equal(source.environment.sky.moons.length, 8);
  assert.equal(new Set(source.environment.sky.moons).size, 8);

  const unknownEnvironment = await fixture(context);
  await updateYaml(unknownEnvironment.manifestPath, (document) => {
    document.environment.wind = {texture: "environment/sky/clouds.webp"};
  });
  await assert.rejects(loadResourceManifest(unknownEnvironment.root, unknownEnvironment.manifestPath), /environment contains unknown field wind/u);

  const unknownSky = await fixture(context);
  await updateYaml(unknownSky.manifestPath, (document) => {
    document.environment.sky.horizon = "environment/sky/sky-glow.webp";
  });
  await assert.rejects(loadResourceManifest(unknownSky.root, unknownSky.manifestPath), /environment sky contains unknown field horizon/u);

  const unknownClouds = await fixture(context);
  await updateYaml(unknownClouds.manifestPath, (document) => {
    document.environment.clouds.speed = 1;
  });
  await assert.rejects(loadResourceManifest(unknownClouds.root, unknownClouds.manifestPath), /environment clouds contains unknown field speed/u);

  const unknownPrecipitation = await fixture(context);
  await updateYaml(unknownPrecipitation.manifestPath, (document) => {
    document.environment.precipitation.hail = "environment/weather/snow.webp";
  });
  await assert.rejects(
    loadResourceManifest(unknownPrecipitation.root, unknownPrecipitation.manifestPath),
    /environment precipitation contains unknown field hail/u,
  );

  const missingPhase = await fixture(context);
  await updateYaml(missingPhase.manifestPath, (document) => {
    document.environment.sky.moons.pop();
  });
  await assert.rejects(loadResourceManifest(missingPhase.root, missingPhase.manifestPath), /exactly eight moon phases/u);

  const repeatedPhase = await fixture(context);
  await updateYaml(repeatedPhase.manifestPath, (document) => {
    document.environment.sky.moons[7] = document.environment.sky.moons[0];
  });
  await assert.rejects(loadResourceManifest(repeatedPhase.root, repeatedPhase.manifestPath), /moon phases must use distinct images/u);

  const misplacedWeather = await fixture(context);
  await updateYaml(misplacedWeather.manifestPath, (document) => {
    document.environment.precipitation.rain = "environment/sky/clouds.webp";
  });
  await assert.rejects(loadResourceManifest(misplacedWeather.root, misplacedWeather.manifestPath), /must use a WebP inside environment\/weather/u);
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

  const atlas = await fixture(context, {
    texturePipeline: {tileSize: 2, atlasPadding: 2, maximumAtlasColumns: 1, mipmaps: true},
  });
  await assert.rejects(
    loadResourceManifest(atlas.root, atlas.manifestPath),
    /texturePipeline contains unknown field atlasPadding/u,
  );

  const stale = await fixture(context, {formatVersion: 8});
  await assert.rejects(loadResourceManifest(stale.root, stale.manifestPath), /Unsupported client resource pack source format/u);
});

test("material precipitation surfaces are required finite policies independent of resource names", async (context) => {
  const {root, manifestPath} = await fixture(context);
  const material = {key: "openvoxel:material/custom", precipitationSurface: "water"};
  await updateYaml(manifestPath, (document) => { document.materials = [material]; });
  assert.equal((await loadResourceManifest(root, manifestPath)).manifest.materials[0].precipitationSurface, "water");
  await updateYaml(manifestPath, (document) => { document.materials[0].precipitationSurface = "solid"; });
  assert.equal((await loadResourceManifest(root, manifestPath)).manifest.materials[0].precipitationSurface, "solid");
  await updateYaml(manifestPath, (document) => { document.materials[0].precipitationSurface = "none"; });
  assert.equal((await loadResourceManifest(root, manifestPath)).manifest.materials[0].precipitationSurface, "none");

  for (const invalid of [null, "", "liquid", "Water", 1, true, {}, []]) {
    await updateYaml(manifestPath, (document) => { document.materials[0].precipitationSurface = invalid; });
    await assert.rejects(loadResourceManifest(root, manifestPath), /precipitationSurface must be none, solid, or water/u);
  }
  await updateYaml(manifestPath, (document) => { delete document.materials[0].precipitationSurface; });
  await assert.rejects(loadResourceManifest(root, manifestPath), /precipitationSurface must be none, solid, or water/u);
});

test("material layers own complete PBR inputs and close their image inventory", async (context) => {
  const variants = [{
    weight: 2,
    transform: {shiftX: 1},
    layers: [{
      albedo: {file: "textures/terrain/overlay.png"},
      maps: {
        height: {file: "textures/terrain/maps/overlay.height.png"},
        material: {file: "textures/terrain/maps/overlay.material.png"},
        emissive: {file: "textures/terrain/maps/overlay.emissive.png"},
      },
      mask: {file: "textures/terrain/maps/overlay.mask.png"},
      opacity: 0.4,
      blend: "overlay",
      transform: {rotate: 90, flipX: true},
    }],
  }];
  const maps = {normal: {file: "textures/terrain/maps/stone.normal.png"}};
  const {root, manifestPath} = await fixture(context, {maps, variants});
  const source = await loadResourceManifest(root, manifestPath);
  const layer = source.textures[0].variants[0].layers[0];

  assert.deepEqual(layer, variants[0].layers[0]);
  assert.deepEqual(source.referencedImageFiles, [
    ...environmentFiles,
    "textures/terrain/maps/overlay.emissive.png",
    "textures/terrain/maps/overlay.height.png",
    "textures/terrain/maps/overlay.mask.png",
    "textures/terrain/maps/overlay.material.png",
    "textures/terrain/maps/stone.normal.png",
    "textures/terrain/overlay.png",
    "textures/terrain/stone.png",
  ].sort());
  assert.deepEqual(source.unusedFiles, []);
});

test("material layer schema rejects ambiguous maps, legacy fields, invalid policy, and path escapes", async (context) => {
  const layer = (overrides = {}) => ({
    albedo: {file: "textures/terrain/overlay.png"},
    ...overrides,
  });
  const conflict = await fixture(context, {variants: [{layers: [layer({maps: {
    normal: {file: "textures/terrain/maps/overlay.normal.png"},
    height: {file: "textures/terrain/maps/overlay.height.png"},
  }})]}]});
  await assert.rejects(loadResourceManifest(conflict.root, conflict.manifestPath), /cannot declare both normal and height maps/u);

  const legacy = await fixture(context, {variants: [{layers: [{file: "textures/terrain/overlay.png"}]}]});
  await assert.rejects(loadResourceManifest(legacy.root, legacy.manifestPath), /contains unknown field file/u);

  const blend = await fixture(context, {variants: [{layers: [layer({blend: "screen"})]}]});
  await assert.rejects(loadResourceManifest(blend.root, blend.manifestPath), /unsupported blend mode screen/u);

  const opacity = await fixture(context, {variants: [{layers: [layer({opacity: 1.01})]}]});
  await assert.rejects(loadResourceManifest(opacity.root, opacity.manifestPath), /opacity must be a number from 0.000001 through 1/u);

  const invisible = await fixture(context, {variants: [{layers: [layer({opacity: 0})]}]});
  await assert.rejects(loadResourceManifest(invisible.root, invisible.manifestPath), /opacity must be a number from 0.000001 through 1/u);

  const mapEscape = await fixture(context, {variants: [{layers: [layer({
    maps: {material: {file: "textures/terrain/../fluid/overlay.material.png"}},
  })]}]});
  await assert.rejects(loadResourceManifest(mapEscape.root, mapEscape.manifestPath), /must use a PNG inside textures\/terrain/u);

  const maskEscape = await fixture(context, {variants: [{layers: [layer({
    mask: {file: "textures/fluid/overlay.mask.png"},
  })]}]});
  await assert.rejects(loadResourceManifest(maskEscape.root, maskEscape.manifestPath), /must use a PNG inside textures\/terrain/u);

  const tooMany = await fixture(context, {variants: [{layers: Array.from({length: 5}, () => layer())}]});
  await assert.rejects(loadResourceManifest(tooMany.root, tooMany.manifestPath), /cannot contain more than four material layers/u);
});

test("author schema rejects unknown fields at every resource ownership boundary", async (context) => {
  const manifest = await fixture(context);
  await updateYaml(manifest.manifestPath, (document) => {
    document.rogue = {file: "textures/terrain/stone.png"};
  });
  await assert.rejects(loadResourceManifest(manifest.root, manifest.manifestPath), /manifest contains unknown field rogue/u);

  const catalog = await fixture(context);
  await updateYaml(catalog.catalogPath, (document) => {
    document.rogue = true;
  });
  await assert.rejects(loadResourceManifest(catalog.root, catalog.manifestPath), /catalog .* contains unknown field rogue/u);

  const texture = await fixture(context);
  await updateYaml(texture.catalogPath, (document) => {
    document.textures[0].rogue = true;
  });
  await assert.rejects(loadResourceManifest(texture.root, texture.manifestPath), /entry contains unknown field rogue/u);

  const variant = await fixture(context, {variants: [{rogue: true}]});
  await assert.rejects(loadResourceManifest(variant.root, variant.manifestPath), /variant 1 contains unknown field rogue/u);

  const layer = await fixture(context, {variants: [{layers: [{albedo: {file: "textures/terrain/overlay.png"}, rogue: true}]}]});
  await assert.rejects(loadResourceManifest(layer.root, layer.manifestPath), /layer 0 contains unknown field rogue/u);

  const albedo = await fixture(context, {variants: [{layers: [{albedo: {file: "textures/terrain/overlay.png", rogue: true}}]}]});
  await assert.rejects(loadResourceManifest(albedo.root, albedo.manifestPath), /albedo contains unknown field rogue/u);

  const mask = await fixture(context, {variants: [{layers: [{
    albedo: {file: "textures/terrain/overlay.png"},
    mask: {file: "textures/terrain/maps/overlay.mask.png", rogue: true},
  }]}]});
  await assert.rejects(loadResourceManifest(mask.root, mask.manifestPath), /mask contains unknown field rogue/u);
});
