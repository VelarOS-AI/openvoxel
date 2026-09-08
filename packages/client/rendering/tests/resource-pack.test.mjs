import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  buildResourcePack,
  computeResourceHash,
  loadEnvironmentResources,
  planTextureBanks,
  requireClientTextureMemoryBudget,
} from "../tools/resource-pack.mjs";
import {buildTextureArray, textureArrayLayerBytes} from "../tools/texture-array.mjs";

const channels = ["albedo", "normal", "material", "emissive"];
const roles = ["opaque", "cutout", "translucent", "fluid"];
const outputPromise = buildResourcePack();
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

test("texture bank roles follow model behavior instead of a reserved model key", () => {
  const customFluidModel = "example:model/liquid-surface";
  const texture = "example:texture/liquid";
  const blockCatalog = {catalog: {componentProfiles: [{render: {
    model: customFluidModel,
    material: "example:material/liquid",
    layer: "translucent",
    textures: {all: texture},
    animation: null,
  }}]}};
  const plan = planTextureBanks(blockCatalog, [], [], [{key: customFluidModel, kind: "fluid"}]);

  assert.equal(plan.assignments.get(texture), "fluid");
  assert.throws(
    () => planTextureBanks(blockCatalog, [], [], []),
    /references unknown model example:model\/liquid-surface/u,
  );
});

test("texture array storage converts RGBA8 layers to GPU row order without changing channels", () => {
  const topToBottom = Buffer.from([
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16,
  ]);
  assert.deepEqual(textureArrayLayerBytes(topToBottom, 2), Buffer.from([
    9, 10, 11, 12, 13, 14, 15, 16,
    1, 2, 3, 4, 5, 6, 7, 8,
  ]));
  assert.throws(() => textureArrayLayerBytes(Buffer.alloc(15), 2), /one complete RGBA8 tile/u);
});

test("texture array construction rejects a bank before exceeding its channel memory budget", async () => {
  const variants = Array.from({length: 64}, () => ({}));
  await assert.rejects(buildTextureArray({
    dataRoot: "/does-not-need-to-exist",
    array: {tileSize: 256, maximumLayers: 256, mipmaps: true},
    textureSources: [{key: "openvoxel:texture/block/oversized", variants}],
    surfaceProfiles: new Map(),
  }), /bytes per channel/u);
});

function pixel(data, width, height, layer, x, y) {
  const layerBytes = width * height * 4;
  const offset = layer * layerBytes + (y * width + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}

function decodedChannel(level, channel) {
  return Buffer.from(level[`${channel}Data`], "base64");
}

function channelAverage(data, level, variant, channel) {
  let total = 0;
  let count = 0;
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      const value = pixel(data, level.width, level.height, variant.layer, x, y);
      if (value[3] === 0) continue;
      total += value[channel];
      count += 1;
    }
  }
  assert.ok(count > 0, "Texture region must contain at least one visible pixel");
  return total / count;
}

function channelLayer(data, level, variant) {
  const layerBytes = level.width * level.height * 4;
  return data.subarray(variant.layer * layerBytes, (variant.layer + 1) * layerBytes);
}

function identityLevel(name, width, height) {
  return {
    width,
    height,
    albedoBytes: Buffer.from(`${name}-albedo`),
    normalBytes: Buffer.from(`${name}-normal`),
    materialBytes: Buffer.from(`${name}-material`),
    emissiveBytes: Buffer.from(`${name}-emissive`),
  };
}

function identityFixture(overrides = {}) {
  return {
    manifest: {
      formatVersion: 9,
      owner: "openvoxel",
      textureCatalogs: ["textures/terrain.yml", "textures/fluid.yml"],
      texturePipeline: {tileSize: 32, maximumArrayLayers: 256, mipmaps: true},
      environment,
    },
    catalogs: [
      {
        file: "textures/terrain.yml",
        document: {category: "terrain", textures: [
          {key: "openvoxel:texture/block/stone", file: "textures/terrain/stone.png"},
          {key: "openvoxel:texture/block/dirt", file: "textures/terrain/dirt.png"},
        ]},
      },
      {
        file: "textures/fluid.yml",
        document: {category: "fluid", textures: [{key: "openvoxel:texture/block/water", file: "textures/fluid/water.png"}]},
      },
    ],
    sourceImages: [
      {path: environment.clouds.texture, bytes: Buffer.from("clouds")},
      {path: environment.sky.sun, bytes: Buffer.from("sun")},
      {path: environment.precipitation.rain, bytes: Buffer.from("rain")},
      {path: "textures/terrain/stone.png", bytes: Buffer.from("stone")},
    ],
    bankAssignments: new Map([
      ["openvoxel:texture/block/stone", "opaque"],
      ["openvoxel:texture/block/dirt", "opaque"],
    ]),
    payload: {artifactVersion: 8, textureBanks: [{key: "openvoxel:texture-bank/opaque"}]},
    bankChannels: [
      {role: "opaque", levels: [identityLevel("opaque-0", 2, 2), identityLevel("opaque-1", 1, 1)]},
      {role: "cutout", levels: [identityLevel("cutout-0", 2, 2), identityLevel("cutout-1", 1, 1)]},
    ],
    ...overrides,
  };
}

async function writeEnvironmentImage(root, file, width, height, format = "webp") {
  const path = join(root, file);
  await mkdir(dirname(path), {recursive: true});
  const image = sharp({create: {width, height, channels: 4, background: {r: 255, g: 255, b: 255, alpha: 1}}});
  await (format === "webp" ? image.webp() : image.png()).toFile(path);
}

async function environmentFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "openvoxel-environment-resources-"));
  context.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all(environmentFiles.map((file) => writeEnvironmentImage(
    root,
    file,
    file === environment.precipitation.rain ? 1 : 2,
    2,
  )));
  return root;
}

test("environment image resources validate transport format and role-specific shape", async (context) => {
  const root = await environmentFixture(context);
  const loaded = await loadEnvironmentResources(root, environment);
  assert.equal(loaded.sourceImages.length, 15);
  const encodedHeapBytes = loaded.sourceImages.reduce(
    (total, image) => total + Math.floor((image.bytes.byteLength + 2) / 3) * 4 * 2,
    0,
  );
  assert.deepEqual(loaded.memory, {
    imageCount: 15,
    decodedRgbaBytes: 232,
    gpuBytes: 232,
    encodedHeapBytes,
    residentBytes: 232 + encodedHeapBytes,
  });
  assert.deepEqual(Object.keys(loaded.artifact), ["sky", "clouds", "precipitation"]);
  assert.equal(loaded.artifact.sky.moonDataUrls.length, 8);
  for (const value of [
    loaded.artifact.sky.sunDataUrl,
    loaded.artifact.sky.glowDataUrl,
    loaded.artifact.sky.starDataUrl,
    ...loaded.artifact.sky.moonDataUrls,
    loaded.artifact.clouds.textureDataUrl,
    loaded.artifact.precipitation.rainDataUrl,
    loaded.artifact.precipitation.rainSplashDataUrl,
    loaded.artifact.precipitation.snowDataUrl,
  ]) assert.match(value, /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/u);

  await writeEnvironmentImage(root, environment.sky.sun, 2, 2, "png");
  await assert.rejects(loadEnvironmentResources(root, environment), /Environment sky sun must be a WebP image/u);
  await writeEnvironmentImage(root, environment.sky.sun, 2, 1);
  await assert.rejects(loadEnvironmentResources(root, environment), /Environment sky sun must be square/u);
  await writeEnvironmentImage(root, environment.sky.sun, 2, 2);

  await writeEnvironmentImage(root, environment.clouds.texture, 2, 1);
  await assert.rejects(loadEnvironmentResources(root, environment), /Environment clouds texture must be square/u);
  await writeEnvironmentImage(root, environment.clouds.texture, 2, 2);

  await writeEnvironmentImage(root, environment.precipitation.rain, 3, 2);
  await assert.rejects(loadEnvironmentResources(root, environment), /rain height must be at least its width/u);
  await writeEnvironmentImage(root, environment.precipitation.rain, 1, 2049);
  await assert.rejects(loadEnvironmentResources(root, environment), /must not exceed 2048 pixels on either axis/u);
});

test("environment decoded RGBA memory participates in the shared 128 MiB texture budget", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openvoxel-environment-budget-"));
  context.after(() => rm(root, {recursive: true, force: true}));
  const image = await sharp({
    create: {width: 2048, height: 2048, channels: 4, background: {r: 255, g: 255, b: 255, alpha: 1}},
  }).webp().toBuffer();
  await Promise.all(environmentFiles.map(async (file) => {
    const path = join(root, file);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, image);
  }));
  const decodedRgbaBytes = 15 * 2048 * 2048 * 4;
  const encodedHeapBytes = 15 * Math.floor((image.byteLength + 2) / 3) * 4 * 2;
  const estimatedResidentBytes = decodedRgbaBytes + encodedHeapBytes;

  await assert.rejects(
    loadEnvironmentResources(root, environment),
    new RegExp(`estimated ${estimatedResidentBytes} resident texture bytes; the limit is 134217728`, "u"),
  );

  const environmentMemory = {
    imageCount: 15,
    decodedRgbaBytes: 32,
    gpuBytes: 32,
    encodedHeapBytes: 16,
    residentBytes: 48,
  };
  assert.equal(
    requireClientTextureMemoryBudget([{gpuBytes: 1, residentBytes: 134217680}], environmentMemory).estimatedResidentBytes,
    134217728,
  );
  assert.throws(
    () => requireClientTextureMemoryBudget([{gpuBytes: 1, residentBytes: 134217681}], environmentMemory),
    /estimated 134217729 resident texture bytes; the limit is 134217728/u,
  );
});

test("generated material metadata distinguishes water, solid, and permeable precipitation surfaces", async () => {
  const {artifact} = await outputPromise;
  const expected = {
    "openvoxel:material/cross": "none",
    "openvoxel:material/ice": "solid",
    "openvoxel:material/leaves": "solid",
    "openvoxel:material/magma": "solid",
    "openvoxel:material/metal": "solid",
    "openvoxel:material/model": "solid",
    "openvoxel:material/terrain": "solid",
    "openvoxel:material/water": "water",
  };
  assert.deepEqual(Object.fromEntries(artifact.materials.map((material) => [material.key, material.precipitationSurface])), expected);
});

test("resource pack exposes four generated texture arrays and a closed authoring inventory", async () => {
  const {artifact, audit, bankChannels} = await outputPromise;
  assert.equal(artifact.artifactVersion, 8);
  assert.equal(artifact.formatVersion, 8);
  assert.equal(audit.formatVersion, 4);
  assert.deepEqual(Object.keys(artifact.environment), ["sky", "clouds", "precipitation"]);
  assert.deepEqual(Object.keys(artifact.environment.sky), ["sunDataUrl", "glowDataUrl", "starDataUrl", "moonDataUrls"]);
  assert.deepEqual(Object.keys(artifact.environment.clouds), ["textureDataUrl"]);
  assert.deepEqual(Object.keys(artifact.environment.precipitation), ["rainDataUrl", "rainSplashDataUrl", "snowDataUrl"]);
  assert.equal(artifact.environment.sky.moonDataUrls.length, 8);
  for (const value of [
    artifact.environment.sky.sunDataUrl,
    artifact.environment.sky.glowDataUrl,
    artifact.environment.sky.starDataUrl,
    ...artifact.environment.sky.moonDataUrls,
    artifact.environment.clouds.textureDataUrl,
    artifact.environment.precipitation.rainDataUrl,
    artifact.environment.precipitation.rainSplashDataUrl,
    artifact.environment.precipitation.snowDataUrl,
  ]) assert.match(value, /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/u);
  assert.equal(artifact.textureBanks.length, 4);
  assert.deepEqual(artifact.textureBanks.map((bank) => bank.role), roles);
  assert.deepEqual(bankChannels.map((bank) => bank.role), roles);
  assert.equal(artifact.textures.length, 45);
  assert.equal(artifact.textures.reduce((total, texture) => total + texture.variants.length, 0), 57);
  assert.deepEqual(
    artifact.textures.map(({key}) => key),
    artifact.textures.map(({key}) => key).sort(),
    "texture artifacts must use deterministic key order",
  );

  for (const bank of artifact.textureBanks) {
    assert.equal(bank.key, `openvoxel:texture-bank/${bank.role}`);
    assert.equal(bank.storage, "texture_2d_array");
    assert.ok(bank.layerCount > 0);
    assert.deepEqual(bank.levels.map(({width, height}) => [width, height]), [
      [32, 32],
      [16, 16],
      [8, 8],
      [4, 4],
      [2, 2],
      [1, 1],
    ]);
    for (const level of bank.levels) {
      for (const channel of channels) {
        assert.match(level[`${channel}Data`], /^[A-Za-z0-9+/]+={0,2}$/u);
        assert.equal(decodedChannel(level, channel).byteLength, level.width * level.height * bank.layerCount * 4);
      }
    }
  }
  const banksByKey = new Map(artifact.textureBanks.map((bank) => [bank.key, bank]));
  for (const texture of artifact.textures) {
    const bank = banksByKey.get(texture.bankKey);
    assert.ok(bank != null, `${texture.key} texture bank`);
    if (bank.role === "cutout") assert.ok(typeof texture.alphaCutoff === "number", `${texture.key} cutout alpha cutoff`);
    else assert.equal(texture.alphaCutoff, null, `${texture.key} non-cutout alpha cutoff`);
  }

  assert.equal(audit.sourceImages.length, 94);
  assert.equal(new Set(audit.sourceImages.map((source) => source.path)).size, 94);
  assert.equal(audit.sourceImages.filter((source) => source.path.startsWith("textures/")).length, 79);
  assert.equal(audit.sourceImages.filter((source) => source.path.includes("/maps/")).length, 34);
  for (const source of audit.sourceImages.filter((candidate) => candidate.path.startsWith("textures/"))) {
    assert.equal(source.width, 32, `${source.path} width`);
    assert.equal(source.height, 32, `${source.path} height`);
  }
  const environmentDimensions = new Map([
    ["environment/sky/clouds.webp", [256, 256]],
    ["environment/sky/sun.webp", [64, 64]],
    ["environment/sky/sky-glow.webp", [32, 32]],
    ["environment/sky/star.webp", [32, 32]],
    ...environment.sky.moons.map((file) => [file, [64, 64]]),
    ["environment/weather/rain.webp", [8, 64]],
    ["environment/weather/rain-splash.webp", [10, 10]],
    ["environment/weather/snow.webp", [64, 64]],
  ]);
  const environmentImages = audit.sourceImages.filter(({path}) => path.startsWith("environment/"));
  assert.equal(environmentImages.length, environmentDimensions.size);
  for (const source of environmentImages) {
    assert.deepEqual([source.width, source.height], environmentDimensions.get(source.path), `${source.path} dimensions`);
    assert.match(source.sha256, /^[0-9a-f]{64}$/u);
  }
  const expectedEnvironmentDecodedRgbaBytes = [...environmentDimensions.values()]
    .reduce((total, [width, height]) => total + width * height * 4, 0);
  const environmentDataUrls = [
    artifact.environment.sky.sunDataUrl,
    artifact.environment.sky.glowDataUrl,
    artifact.environment.sky.starDataUrl,
    ...artifact.environment.sky.moonDataUrls,
    artifact.environment.clouds.textureDataUrl,
    artifact.environment.precipitation.rainDataUrl,
    artifact.environment.precipitation.rainSplashDataUrl,
    artifact.environment.precipitation.snowDataUrl,
  ];
  const expectedEnvironmentEncodedHeapBytes = environmentDataUrls.reduce(
    (total, url) => total + (url.length - "data:image/webp;base64,".length) * 2,
    0,
  );
  assert.deepEqual(audit.environment, {
    imageCount: 15,
    decodedRgbaBytes: expectedEnvironmentDecodedRgbaBytes,
    gpuBytes: expectedEnvironmentDecodedRgbaBytes,
    encodedHeapBytes: expectedEnvironmentEncodedHeapBytes,
    residentBytes: expectedEnvironmentDecodedRgbaBytes + expectedEnvironmentEncodedHeapBytes,
  });
  assert.deepEqual(audit.unusedFiles, []);
  assert.equal(audit.textureCount, 45);
  assert.equal(audit.variantCount, 57);
  assert.deepEqual(audit.categories, {terrain: 20, vegetation: 21, fluid: 4});
  assert.deepEqual(
    Object.fromEntries(audit.banks.map((bank) => [bank.role, bank.variantCount])),
    {opaque: 40, cutout: 12, translucent: 1, fluid: 4},
  );
  for (const bank of audit.banks) {
    assert.equal(bank.storage, "texture_2d_array");
    assert.equal(bank.array.width, 32);
    assert.equal(bank.array.height, 32);
    assert.equal(bank.array.layers, bank.variantCount);
    assert.equal(bank.array.mipmaps, true);
    assert.equal(bank.array.mipLevelCount, 6);
    assert.equal(bank.array.gpuBytes, bank.memory.gpuBytes);
    assert.equal(bank.memory.cpuRestoreBytes, bank.memory.gpuBytes);
    assert.ok(bank.memory.encodedHeapBytes > 0);
    assert.equal(
      bank.memory.residentBytes,
      bank.memory.gpuBytes + bank.memory.cpuRestoreBytes + bank.memory.encodedHeapBytes,
    );
  }
  const channelSources = {normal: {}, material: {}, emissive: {}};
  for (const bank of audit.banks) {
    for (const channel of Object.keys(channelSources)) {
      for (const [source, count] of Object.entries(bank.channelSources[channel])) {
        channelSources[channel][source] = (channelSources[channel][source] ?? 0) + count;
      }
    }
  }
  assert.deepEqual(channelSources, {
    normal: {"authored-height": 19, "authored-normal": 4, composed: 1, generated: 33},
    material: {"authored-material": 23, composed: 1, generated: 33},
    emissive: {"authored-emissive": 2, composed: 1, generated: 54},
  });
  const auditedVariants = audit.banks.flatMap((bank) => bank.variants);
  assert.equal(auditedVariants.length, 57);
  const stoneLayer = auditedVariants.find((variant) => variant.textureKey === "openvoxel:texture/block/stone" && variant.variantIndex === 1);
  assert.ok(stoneLayer != null, "Stone composed variant must be individually auditable");
  assert.deepEqual(stoneLayer.channels.albedo, {mode: "composed", inputs: ["authored-albedo"]});
  assert.deepEqual(stoneLayer.channels.normal, {mode: "composed", inputs: ["authored-height"]});
  assert.deepEqual(stoneLayer.channels.material, {mode: "composed", inputs: ["authored-material"]});
  assert.deepEqual(stoneLayer.channels.emissive, {mode: "composed", inputs: ["generated"]});
  assert.equal(audit.maximumResidentBytes, 128 * 1024 * 1024);
  assert.equal(
    audit.gpuBytes,
    audit.environment.gpuBytes + audit.banks.reduce((total, bank) => total + bank.memory.gpuBytes, 0),
  );
  assert.equal(
    audit.estimatedResidentBytes,
    audit.environment.residentBytes + audit.banks.reduce((total, bank) => total + bank.memory.residentBytes, 0),
  );
  assert.ok(audit.estimatedResidentBytes <= audit.maximumResidentBytes);
});

test("resource hash is deterministic and covers every authoring and generated boundary", () => {
  const fixture = identityFixture();
  const baseline = computeResourceHash(fixture);
  const reordered = identityFixture({
    manifest: {
      texturePipeline: {mipmaps: true, maximumArrayLayers: 256, tileSize: 32},
      textureCatalogs: [...fixture.manifest.textureCatalogs].reverse(),
      environment: fixture.manifest.environment,
      owner: "openvoxel",
      formatVersion: 9,
    },
    catalogs: [...fixture.catalogs].reverse().map((catalog) => ({
      ...catalog,
      document: catalog.document.textures == null
        ? catalog.document
        : {...catalog.document, textures: [...catalog.document.textures].reverse()},
    })),
    sourceImages: [...fixture.sourceImages].reverse(),
    bankAssignments: new Map([...fixture.bankAssignments].reverse()),
    bankChannels: [...fixture.bankChannels].reverse(),
  });
  assert.equal(
    computeResourceHash(reordered),
    baseline,
    "object keys, catalog and texture declarations, source images, assignments, and bank enumeration must be normalized",
  );

  const cases = [
    ["manifest recipe", {manifest: {...identityFixture().manifest, owner: "changed"}}],
    ["catalog recipe", {catalogs: fixture.catalogs.map((catalog) => catalog.file === "textures/terrain.yml"
      ? {...catalog, document: {...catalog.document, textures: catalog.document.textures.map((texture) => (
        texture.key === "openvoxel:texture/block/stone" ? {...texture, file: "textures/terrain/changed.png"} : texture
      ))}}
      : catalog)}],
    ["source image bytes", {sourceImages: fixture.sourceImages.map((source) => (
      source.path === "textures/terrain/stone.png" ? {...source, bytes: Buffer.from("changed")} : source
    ))}],
    ["environment image bytes", {sourceImages: fixture.sourceImages.map((source) => (
      source.path === environment.sky.sun ? {...source, bytes: Buffer.from("changed")} : source
    ))}],
    ["bank assignment", {bankAssignments: new Map([
      ["openvoxel:texture/block/stone", "cutout"],
      ["openvoxel:texture/block/dirt", "opaque"],
    ])}],
    ["artifact payload", {payload: {artifactVersion: 8, textureBanks: [{key: "changed"}]}}],
    ["base generated bank bytes", {bankChannels: fixture.bankChannels.map((bank) => bank.role === "opaque"
      ? {...bank, levels: [{...bank.levels[0], albedoBytes: Buffer.from("changed")}, bank.levels[1]]}
      : bank)}],
    ["non-base generated bank bytes", {bankChannels: fixture.bankChannels.map((bank) => bank.role === "opaque"
      ? {...bank, levels: [bank.levels[0], {...bank.levels[1], normalBytes: Buffer.from("changed")}]}
      : bank)}],
    ["mip level order", {bankChannels: fixture.bankChannels.map((bank) => bank.role === "opaque"
      ? {...bank, levels: [...bank.levels].reverse()}
      : bank)}],
  ];
  for (const [label, overrides] of cases) {
    assert.notEqual(computeResourceHash(identityFixture(overrides)), baseline, `${label} must affect resource identity`);
  }
});

test("resource pack identity is reproducible across complete builds", async () => {
  const [first, second] = await Promise.all([outputPromise, buildResourcePack()]);
  assert.equal(second.artifact.resourceHash, first.artifact.resourceHash);
});

test("every bank keeps complete mip levels and four RGBA8 channels aligned by layer", async () => {
  const output = await outputPromise;
  const banksByKey = new Map(output.artifact.textureBanks.map((bank) => [bank.key, bank]));
  const channelsByRole = new Map(output.bankChannels.map((bank) => [bank.role, bank]));
  const layersByBank = new Map(roles.map((role) => [role, new Set()]));

  for (const bank of output.artifact.textureBanks) {
    const bankChannels = channelsByRole.get(bank.role);
    assert.ok(bankChannels != null, `${bank.role} bank channels`);
    assert.equal(bank.levels.length, bankChannels.levels.length, `${bank.role} mip level count`);
    let previousWidth = bank.levels[0].width;
    let previousHeight = bank.levels[0].height;
    for (const [mipLevel, level] of bank.levels.entries()) {
      const rawLevel = bankChannels.levels[mipLevel];
      assert.equal(rawLevel.width, level.width, `${bank.role} mip ${mipLevel} width`);
      assert.equal(rawLevel.height, level.height, `${bank.role} mip ${mipLevel} height`);
      if (mipLevel > 0) {
        assert.equal(level.width, Math.max(1, Math.floor(previousWidth / 2)), `${bank.role} mip ${mipLevel} halved width`);
        assert.equal(level.height, Math.max(1, Math.floor(previousHeight / 2)), `${bank.role} mip ${mipLevel} halved height`);
      }
      previousWidth = level.width;
      previousHeight = level.height;
      const levelChannels = Object.fromEntries(channels.map((channel) => [channel, decodedChannel(level, channel)]));
      for (const channel of channels) {
        assert.deepEqual(levelChannels[channel], rawLevel[`${channel}Bytes`], `${bank.role} mip ${mipLevel} ${channel} artifact bytes`);
      }
      for (let layer = 0; layer < bank.layerCount; layer += 1) {
        for (let y = 0; y < level.height; y += 1) {
          for (let x = 0; x < level.width; x += 1) {
            const alpha = pixel(levelChannels.albedo, level.width, level.height, layer, x, y)[3];
            for (const channel of channels.slice(1)) {
              assert.equal(
                pixel(levelChannels[channel], level.width, level.height, layer, x, y)[3],
                alpha,
                `${bank.role} mip ${mipLevel} layer ${layer} ${channel} alpha`,
              );
            }
          }
        }
      }
    }
    assert.deepEqual([previousWidth, previousHeight], [1, 1], `${bank.role} mip chain must reach 1x1`);
  }

  for (const texture of output.artifact.textures) {
    const bank = banksByKey.get(texture.bankKey);
    assert.ok(bank != null, `${texture.key} must reference a texture bank`);
    const baseLevel = bank.levels[0];
    const bankChannels = Object.fromEntries(channels.map((channel) => [channel, decodedChannel(baseLevel, channel)]));
    const textureSurfaces = new Set();
    assert.ok(texture.variants.length > 0, `${texture.key} must provide at least one variant`);
    for (const [variantIndex, variant] of texture.variants.entries()) {
      const label = `${texture.key} variant ${variantIndex}`;
      assert.equal(Number.isInteger(variant.layer), true, `${label} layer must be an integer`);
      assert.ok(variant.layer >= 0 && variant.layer < bank.layerCount, `${label} layer must be in bounds`);
      assert.equal(layersByBank.get(bank.role).has(variant.layer), false, `${label} must own a distinct ${bank.role} layer`);
      layersByBank.get(bank.role).add(variant.layer);

      for (let y = 0; y < baseLevel.height; y += 1) {
        for (let x = 0; x < baseLevel.width; x += 1) {
          const albedo = pixel(bankChannels.albedo, baseLevel.width, baseLevel.height, variant.layer, x, y);
          for (const channel of channels.slice(1)) {
            assert.equal(
              pixel(bankChannels[channel], baseLevel.width, baseLevel.height, variant.layer, x, y)[3],
              albedo[3],
              `${label} ${channel} alpha`,
            );
          }
        }
      }
      const surfaceHash = createHash("sha256");
      for (const channel of channels) surfaceHash.update(channelLayer(bankChannels[channel], baseLevel, variant));
      const textureHash = surfaceHash.digest("hex");
      assert.equal(textureSurfaces.has(textureHash), false, `${label} must not duplicate another PBR surface of the same logical texture`);
      textureSurfaces.add(textureHash);
    }
  }

  for (const bank of output.artifact.textureBanks) {
    const bankTextures = output.artifact.textures.filter((texture) => texture.bankKey === bank.key);
    assert.deepEqual(
      bankTextures.flatMap((texture) => texture.variants.map((variant) => variant.layer)),
      [...Array(bank.layerCount).keys()],
      `${bank.role} layers must follow deterministic texture-key and variant order`,
    );
    assert.deepEqual([...layersByBank.get(bank.role)].sort((left, right) => left - right), [...Array(bank.layerCount).keys()]);
  }
});

test("cutout mip levels retain each layer's nearest practical alpha coverage", async () => {
  const {artifact} = await outputPromise;
  const bank = artifact.textureBanks.find(({role}) => role === "cutout");
  assert.ok(bank != null, "Expected a cutout texture bank");
  const cutoffByLayer = new Map();
  for (const texture of artifact.textures.filter(({bankKey}) => bankKey === bank.key)) {
    assert.ok(typeof texture.alphaCutoff === "number", `${texture.key} alpha cutoff`);
    for (const variant of texture.variants) cutoffByLayer.set(variant.layer, texture.alphaCutoff);
  }
  assert.equal(cutoffByLayer.size, bank.layerCount);
  const coverage = (level, layer, cutoff) => {
    const cutoffByte = Math.ceil(cutoff * 255);
    const data = decodedChannel(level, "albedo");
    const layerBytes = level.width * level.height * 4;
    let passing = 0;
    for (let offset = layer * layerBytes + 3; offset < (layer + 1) * layerBytes; offset += 4) {
      if (data[offset] >= cutoffByte) passing += 1;
    }
    return passing / (level.width * level.height);
  };
  let partialLayerCount = 0;
  for (let layer = 0; layer < bank.layerCount; layer += 1) {
    const cutoff = cutoffByLayer.get(layer);
    if (cutoff === 0) continue;
    const reference = coverage(bank.levels[0], layer, cutoff);
    if (reference > 0 && reference < 1) partialLayerCount += 1;
    for (const [mipLevel, level] of bank.levels.entries()) {
      const actual = coverage(level, layer, cutoff);
      const tolerance = 1 / Math.min(level.width, level.height);
      assert.ok(
        Math.abs(actual - reference) <= tolerance + Number.EPSILON,
        `cutout layer ${layer} mip ${mipLevel} alpha coverage drift`,
      );
      if (reference > 0) assert.ok(actual > 0, `cutout layer ${layer} mip ${mipLevel} must remain visible`);
      if (reference === 0 || reference === 1) {
        assert.equal(actual, reference, `cutout layer ${layer} mip ${mipLevel} endpoint coverage`);
      }
    }
  }
  assert.ok(partialLayerCount > 0, "Cutout coverage check must exercise partially transparent layers");
});

test("generated ORM and emissive channels preserve material intent and animation locality", async () => {
  const output = await outputPromise;
  const banksByKey = new Map(output.artifact.textureBanks.map((bank) => [bank.key, bank]));
  const textures = new Map(output.artifact.textures.map((texture) => [texture.key, texture]));
  const sample = (key, channel, component) => {
    const texture = textures.get(key);
    assert.ok(texture != null, `Expected texture ${key}`);
    const bank = banksByKey.get(texture.bankKey);
    assert.ok(bank != null, `Expected bank ${texture.bankKey}`);
    const baseLevel = bank.levels[0];
    return channelAverage(decodedChannel(baseLevel, channel), baseLevel, texture.variants[0], component);
  };

  const stone = "openvoxel:texture/block/stone";
  const water = "openvoxel:texture/block/water";
  const copper = "openvoxel:texture/block/copper_ore";
  const magma = "openvoxel:texture/block/magma";
  assert.ok(sample(stone, "material", 1) > sample(water, "material", 1), "stone must be rougher than water");
  assert.ok(sample(copper, "material", 2) > sample(stone, "material", 2), "copper ore must be more metallic than stone");
  const magmaEmission = sample(magma, "emissive", 0) + sample(magma, "emissive", 1) + sample(magma, "emissive", 2);
  const stoneEmission = sample(stone, "emissive", 0) + sample(stone, "emissive", 1) + sample(stone, "emissive", 2);
  assert.ok(magmaEmission > stoneEmission, "magma must emit more light than stone");

  for (const animation of output.artifact.animations) {
    assert.ok(animation.frames.length > 1, `${animation.key} must contain visible motion`);
    const frames = animation.frames.map((key) => {
      const texture = textures.get(key);
      assert.equal(texture?.variants.length, 1, `${animation.key} frame ${key} must own one array layer`);
      return texture;
    });
    assert.equal(new Set(frames.map((texture) => texture.bankKey)).size, 1, `${animation.key} frames must share a bank`);
    const layers = frames.map((texture) => texture.variants[0].layer);
    assert.equal(new Set(layers).size, frames.length, `${animation.key} frames must own distinct array layers`);
  }
});

test("the shipped stone material layer changes PBR detail without emissive leakage", async () => {
  const {artifact} = await outputPromise;
  const stone = artifact.textures.find(({key}) => key === "openvoxel:texture/block/stone");
  assert.ok(stone != null, "Expected the shipped stone texture");
  assert.ok(stone.variants.length >= 2, "Stone must expose a composed material-layer variant");
  const bank = artifact.textureBanks.find(({key}) => key === stone.bankKey);
  assert.ok(bank != null, `Expected texture bank ${stone.bankKey}`);
  const level = bank.levels[0];
  const base = Object.fromEntries(channels.map((channel) => [
    channel,
    channelLayer(decodedChannel(level, channel), level, stone.variants[0]),
  ]));
  const composed = Object.fromEntries(channels.map((channel) => [
    channel,
    channelLayer(decodedChannel(level, channel), level, stone.variants[1]),
  ]));

  for (const channel of ["albedo", "normal", "material"]) {
    assert.equal(composed[channel].equals(base[channel]), false, `Stone ${channel} detail must change after composition`);
  }
  for (let offset = 0; offset < composed.albedo.byteLength; offset += 4) {
    const alpha = composed.albedo[offset + 3];
    for (const channel of channels.slice(1)) assert.equal(composed[channel][offset + 3], alpha, `${channel} alpha`);
    assert.deepEqual([...composed.emissive.subarray(offset, offset + 3)], [0, 0, 0], "Stone must remain non-emissive");
  }
});
