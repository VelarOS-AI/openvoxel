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
  const {artifact, atlasBytes} = await buildResourcePack();
  const decoded = await sharp(atlasBytes).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  const {width, height} = decoded.info;
  assert.equal(width, artifact.atlas.width);
  assert.equal(height, artifact.atlas.height);
  const atlasRegions = new Set();
  const texturePixels = new Set();

  for (const texture of artifact.textures) {
    for (const [coordinate, extent] of [
      [texture.u0, width],
      [texture.u1, width],
      [texture.v0, height],
      [texture.v1, height],
    ]) {
      const texelCoordinate = coordinate * extent;
      assert.ok(Math.abs(texelCoordinate - Math.floor(texelCoordinate) - 0.5) < 1e-9, `${texture.key} UV must address a texel center`);
    }

    const left = Math.floor(texture.u0 * width);
    const right = Math.floor(texture.u1 * width);
    const top = height - 1 - Math.floor(texture.v1 * height);
    const bottom = height - 1 - Math.floor(texture.v0 * height);
    const middleX = Math.floor((left + right) / 2);
    const middleY = Math.floor((top + bottom) / 2);
    const region = `${left}:${top}:${right}:${bottom}`;
    assert.equal(atlasRegions.has(region), false, `${texture.key} must own a distinct atlas region`);
    atlasRegions.add(region);
    const tileBytes = [];
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) tileBytes.push(...pixel(decoded.data, width, x, y));
    }
    const textureHash = createHash("sha256").update(Uint8Array.from(tileBytes)).digest("hex");
    assert.equal(texturePixels.has(textureHash), false, `${texture.key} must not duplicate another texture's pixels`);
    texturePixels.add(textureHash);
    assert.deepEqual(pixel(decoded.data, width, left - 1, middleY), pixel(decoded.data, width, left, middleY), `${texture.key} left padding`);
    assert.deepEqual(pixel(decoded.data, width, right + 1, middleY), pixel(decoded.data, width, right, middleY), `${texture.key} right padding`);
    assert.deepEqual(pixel(decoded.data, width, middleX, top - 1), pixel(decoded.data, width, middleX, top), `${texture.key} top padding`);
    assert.deepEqual(pixel(decoded.data, width, middleX, bottom + 1), pixel(decoded.data, width, middleX, bottom), `${texture.key} bottom padding`);
  }
});
