import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import {buildResourcePack} from "../tools/resource-pack.mjs";

function pixel(data, width, x, y) {
  const offset = (y * width + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}

test("atlas UVs stay on texel centers and padding repeats edge pixels", async () => {
  const {artifact, atlasBytes, normalAtlasBytes, specularAtlasBytes} = await buildResourcePack();
  const [decoded, normalDecoded, specularDecoded] = await Promise.all([
    sharp(atlasBytes).ensureAlpha().raw().toBuffer({resolveWithObject: true}),
    sharp(normalAtlasBytes).ensureAlpha().raw().toBuffer({resolveWithObject: true}),
    sharp(specularAtlasBytes).ensureAlpha().raw().toBuffer({resolveWithObject: true}),
  ]);
  const {width, height} = decoded.info;
  assert.equal(width, artifact.atlas.width);
  assert.equal(height, artifact.atlas.height);
  assert.deepEqual(normalDecoded.info, decoded.info);
  assert.deepEqual(specularDecoded.info, decoded.info);
  const atlasRegions = new Set();
  const texturePixels = new Set();

  for (const texture of artifact.textures) {
    assert.ok(texture.variants.length > 0, `${texture.key} must provide at least one variant`);
    for (const [variantIndex, variant] of texture.variants.entries()) {
      const label = `${texture.key} variant ${variantIndex}`;
      for (const [coordinate, extent] of [
        [variant.u0, width],
        [variant.u1, width],
        [variant.v0, height],
        [variant.v1, height],
      ]) {
        const texelCoordinate = coordinate * extent;
        assert.ok(Math.abs(texelCoordinate - Math.floor(texelCoordinate) - 0.5) < 1e-9, `${label} UV must address a texel center`);
      }

      const left = Math.floor(variant.u0 * width);
      const right = Math.floor(variant.u1 * width);
      const top = height - 1 - Math.floor(variant.v1 * height);
      const bottom = height - 1 - Math.floor(variant.v0 * height);
      const middleX = Math.floor((left + right) / 2);
      const middleY = Math.floor((top + bottom) / 2);
      const region = `${left}:${top}:${right}:${bottom}`;
      assert.equal(atlasRegions.has(region), false, `${label} must own a distinct atlas region`);
      atlasRegions.add(region);
      const tileBytes = [];
      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) tileBytes.push(...pixel(decoded.data, width, x, y));
      }
      const textureHash = createHash("sha256").update(Uint8Array.from(tileBytes)).digest("hex");
      assert.equal(texturePixels.has(textureHash), false, `${label} must not duplicate another variant's pixels`);
      texturePixels.add(textureHash);
      assert.deepEqual(pixel(decoded.data, width, left - 1, middleY), pixel(decoded.data, width, left, middleY), `${label} left padding`);
      assert.deepEqual(pixel(decoded.data, width, right + 1, middleY), pixel(decoded.data, width, right, middleY), `${label} right padding`);
      assert.deepEqual(pixel(decoded.data, width, middleX, top - 1), pixel(decoded.data, width, middleX, top), `${label} top padding`);
      assert.deepEqual(pixel(decoded.data, width, middleX, bottom + 1), pixel(decoded.data, width, middleX, bottom), `${label} bottom padding`);
      assert.deepEqual(pixel(normalDecoded.data, width, left - 1, middleY), pixel(normalDecoded.data, width, left, middleY), `${label} normal left padding`);
      assert.deepEqual(pixel(specularDecoded.data, width, right + 1, middleY), pixel(specularDecoded.data, width, right, middleY), `${label} specular right padding`);
    }
  }
  const textures = new Map(artifact.textures.map((texture) => [texture.key, texture]));
  for (const animation of artifact.animations) {
    assert.ok(animation.frames.length > 1, `${animation.key} must contain visible motion`);
    const regions = animation.frames.map((key) => {
      const texture = textures.get(key);
      assert.equal(texture?.variants.length, 1, `${animation.key} frame ${key} must own one atlas region`);
      return texture.variants[0];
    });
    const width = regions[0].u1 - regions[0].u0;
    const height = regions[0].v1 - regions[0].v0;
    for (const region of regions) {
      assert.equal(region.u1 - region.u0, width, `${animation.key} frame width`);
      assert.equal(region.v1 - region.v0, height, `${animation.key} frame height`);
    }
  }
  assert.notEqual(createHash("sha256").update(normalDecoded.data).digest("hex"), createHash("sha256").update(specularDecoded.data).digest("hex"));
});
