import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import {buildResourcePack} from "../tools/resource-pack.mjs";

const channels = ["albedo", "normal", "material", "emissive"];
const roles = ["opaque", "cutout", "translucent", "fluid"];
const outputPromise = buildResourcePack();

function pixel(data, width, x, y) {
  const offset = (y * width + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}

function regionBounds(bank, variant) {
  return {
    left: Math.floor(variant.u0 * bank.width),
    right: Math.floor(variant.u1 * bank.width),
    top: bank.height - 1 - Math.floor(variant.v1 * bank.height),
    bottom: bank.height - 1 - Math.floor(variant.v0 * bank.height),
  };
}

function channelAverage(decoded, bank, variant, channel) {
  const {left, right, top, bottom} = regionBounds(bank, variant);
  let total = 0;
  let count = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const value = pixel(decoded.data, bank.width, x, y);
      if (value[3] === 0) continue;
      total += value[channel];
      count += 1;
    }
  }
  assert.ok(count > 0, "Texture region must contain at least one visible pixel");
  return total / count;
}

async function decodedBanks(output) {
  const decoded = new Map();
  for (const images of output.bankImages) {
    decoded.set(images.role, Object.fromEntries(await Promise.all(channels.map(async (channel) => [
      channel,
      await sharp(images[`${channel}Bytes`]).ensureAlpha().raw().toBuffer({resolveWithObject: true}),
    ]))));
  }
  return decoded;
}

test("resource pack exposes four generated texture banks and a closed authoring inventory", async () => {
  const {artifact, audit, bankImages} = await outputPromise;
  assert.equal(artifact.artifactVersion, 4);
  assert.equal(artifact.formatVersion, 4);
  assert.equal(artifact.textureBanks.length, 4);
  assert.deepEqual(artifact.textureBanks.map((bank) => bank.role), roles);
  assert.deepEqual(bankImages.map((bank) => bank.role), roles);
  assert.equal(artifact.textures.length, 45);
  assert.equal(artifact.textures.reduce((total, texture) => total + texture.variants.length, 0), 57);

  for (const bank of artifact.textureBanks) {
    assert.equal(bank.key, `openvoxel:texture-bank/${bank.role}`);
    assert.equal(bank.storage, "atlas");
    assert.equal(bank.mipmaps, true);
    assert.ok(bank.width > 0 && bank.height > 0);
    for (const channel of channels) {
      assert.match(bank[`${channel}DataUrl`], /^data:image\/png;base64,/u);
    }
  }

  assert.equal(audit.sourceImages.length, 46);
  assert.equal(new Set(audit.sourceImages.map((source) => source.path)).size, 46);
  assert.equal(audit.sourceImages.filter((source) => source.path.startsWith("textures/")).length, 45);
  for (const source of audit.sourceImages.filter((candidate) => candidate.path.startsWith("textures/"))) {
    assert.equal(source.width, 32, `${source.path} width`);
    assert.equal(source.height, 32, `${source.path} height`);
  }
  assert.deepEqual(audit.unusedFiles, []);
  assert.equal(audit.textureCount, 45);
  assert.equal(audit.variantCount, 57);
  assert.deepEqual(audit.categories, {terrain: 20, vegetation: 21, fluid: 4});
  assert.deepEqual(
    Object.fromEntries(audit.banks.map((bank) => [bank.role, bank.variantCount])),
    {opaque: 40, cutout: 12, translucent: 1, fluid: 4},
  );
  assert.ok(audit.estimatedGpuBytes > 0);
});

test("every bank keeps four channels aligned with texel-centered UVs and copied padding", async () => {
  const output = await outputPromise;
  const decoded = await decodedBanks(output);
  const banksByKey = new Map(output.artifact.textureBanks.map((bank) => [bank.key, bank]));
  const imagesByRole = new Map(output.bankImages.map((images) => [images.role, images]));
  const regionsByBank = new Map(roles.map((role) => [role, new Set()]));

  for (const bank of output.artifact.textureBanks) {
    const bankChannels = decoded.get(bank.role);
    const images = imagesByRole.get(bank.role);
    assert.ok(bankChannels != null && images != null, `${bank.role} bank images`);
    assert.equal(bankChannels.albedo.info.width, bank.width);
    assert.equal(bankChannels.albedo.info.height, bank.height);
    for (const channel of channels) {
      assert.deepEqual(bankChannels[channel].info, bankChannels.albedo.info, `${bank.role} ${channel} dimensions`);
      const dataUrl = bank[`${channel}DataUrl`];
      const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
      assert.deepEqual(Buffer.from(encoded, "base64"), images[`${channel}Bytes`], `${bank.role} ${channel} artifact bytes`);
    }
  }

  for (const texture of output.artifact.textures) {
    const bank = banksByKey.get(texture.bankKey);
    assert.ok(bank != null, `${texture.key} must reference a texture bank`);
    const bankChannels = decoded.get(bank.role);
    const texturePixels = new Set();
    assert.ok(texture.variants.length > 0, `${texture.key} must provide at least one variant`);
    for (const [variantIndex, variant] of texture.variants.entries()) {
      const label = `${texture.key} variant ${variantIndex}`;
      for (const [coordinate, extent] of [
        [variant.u0, bank.width],
        [variant.u1, bank.width],
        [variant.v0, bank.height],
        [variant.v1, bank.height],
      ]) {
        const texelCoordinate = coordinate * extent;
        assert.ok(Math.abs(texelCoordinate - Math.floor(texelCoordinate) - 0.5) < 1e-9, `${label} UV must address a texel center`);
      }

      const {left, right, top, bottom} = regionBounds(bank, variant);
      const middleX = Math.floor((left + right) / 2);
      const middleY = Math.floor((top + bottom) / 2);
      const region = `${left}:${top}:${right}:${bottom}`;
      assert.equal(regionsByBank.get(bank.role).has(region), false, `${label} must own a distinct ${bank.role} region`);
      regionsByBank.get(bank.role).add(region);

      const albedoTile = [];
      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) {
          const albedo = pixel(bankChannels.albedo.data, bank.width, x, y);
          albedoTile.push(...albedo);
          for (const channel of channels.slice(1)) {
            assert.equal(pixel(bankChannels[channel].data, bank.width, x, y)[3], albedo[3], `${label} ${channel} alpha`);
          }
        }
      }
      const textureHash = createHash("sha256").update(Uint8Array.from(albedoTile)).digest("hex");
      assert.equal(texturePixels.has(textureHash), false, `${label} must not duplicate another variant of the same logical texture`);
      texturePixels.add(textureHash);

      for (const channel of channels) {
        const data = bankChannels[channel].data;
        assert.deepEqual(pixel(data, bank.width, left - 1, middleY), pixel(data, bank.width, left, middleY), `${label} ${channel} left padding`);
        assert.deepEqual(pixel(data, bank.width, right + 1, middleY), pixel(data, bank.width, right, middleY), `${label} ${channel} right padding`);
        assert.deepEqual(pixel(data, bank.width, middleX, top - 1), pixel(data, bank.width, middleX, top), `${label} ${channel} top padding`);
        assert.deepEqual(pixel(data, bank.width, middleX, bottom + 1), pixel(data, bank.width, middleX, bottom), `${label} ${channel} bottom padding`);
      }
    }
  }
});

test("generated ORM and emissive channels preserve material intent and animation locality", async () => {
  const output = await outputPromise;
  const decoded = await decodedBanks(output);
  const banksByKey = new Map(output.artifact.textureBanks.map((bank) => [bank.key, bank]));
  const textures = new Map(output.artifact.textures.map((texture) => [texture.key, texture]));
  const sample = (key, channel, component) => {
    const texture = textures.get(key);
    assert.ok(texture != null, `Expected texture ${key}`);
    const bank = banksByKey.get(texture.bankKey);
    assert.ok(bank != null, `Expected bank ${texture.bankKey}`);
    return channelAverage(decoded.get(bank.role)[channel], bank, texture.variants[0], component);
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
      assert.equal(texture?.variants.length, 1, `${animation.key} frame ${key} must own one bank region`);
      return texture;
    });
    assert.equal(new Set(frames.map((texture) => texture.bankKey)).size, 1, `${animation.key} frames must share a bank`);
    const bank = banksByKey.get(frames[0].bankKey);
    const regions = frames.map((texture) => texture.variants[0]);
    const width = (regions[0].u1 - regions[0].u0) * bank.width;
    const height = (regions[0].v1 - regions[0].v0) * bank.height;
    for (const region of regions) {
      assert.ok(Math.abs((region.u1 - region.u0) * bank.width - width) < 1e-9, `${animation.key} frame width`);
      assert.ok(Math.abs((region.v1 - region.v0) * bank.height - height) < 1e-9, `${animation.key} frame height`);
    }
  }
});
