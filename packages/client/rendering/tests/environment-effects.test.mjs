import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {readFile} from "node:fs/promises";
import sharp from "sharp";
import {parse} from "yaml";
import {environmentAlphaIndices} from "../src/native/babylon/environment-effects.mjs";

test("authored environment textures retain premultiplied RGB for their blend contract", async () => {
  const root = new URL("../data/", import.meta.url);
  const {environment} = parse(await readFile(new URL("resource-pack.yml", root), "utf8"));
  const sources = [environment.sky.sun, environment.sky.glow, environment.sky.star, ...environment.sky.moons,
    environment.clouds.texture, ...Object.values(environment.precipitation)];
  assert.equal(sources.length, 15);
  let fractionalAlpha = 0;
  for (const source of sources) {
    const {data} = await sharp(fileURLToPath(new URL(source, root))).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    for (let offset = 0; offset < data.length; offset += 4) {
      const alpha = data[offset + 3];
      if (alpha > 0 && alpha < 255) fractionalAlpha += 1;
      for (let channel = 0; channel < 3; channel += 1) {
        assert.ok(data[offset + channel] <= alpha, `${source} texel ${offset / 4} violates premultiplied RGB`);
      }
    }
  }
  assert.ok(fractionalAlpha > 0, "The resource pack must exercise authored translucent edges");
});

test("environment transparency has an explicit back-to-front semantic order", () => {
  const indices = [
    environmentAlphaIndices.stars,
    environmentAlphaIndices.sunGlow,
    environmentAlphaIndices.moonGlow,
    environmentAlphaIndices.sun,
    environmentAlphaIndices.moon,
    environmentAlphaIndices.clouds,
  ];

  assert.ok(Object.isFrozen(environmentAlphaIndices));
  assert.ok(indices.every((value) => Number.isSafeInteger(value)));
  for (let index = 1; index < indices.length; index += 1) {
    assert.ok(indices[index] > indices[index - 1], "environment alpha indices must be strictly increasing");
  }
});

test("rain texture keeps transparent padding around a non-empty streak", async () => {
  const source = fileURLToPath(new URL("../data/environment/weather/rain.webp", import.meta.url));
  const image = sharp(source);
  const metadata = await image.metadata();
  const {data, info} = await image.ensureAlpha().raw().toBuffer({resolveWithObject: true});
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.hasAlpha, true);
  assert.ok(info.height >= info.width * 4, "rain source must be vertically oriented");

  let visibleCenterPixels = 0;
  const centerStart = Math.floor(info.width * 0.375);
  const centerEnd = Math.ceil(info.width * 0.625);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = centerStart; x < centerEnd; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] >= 96) visibleCenterPixels += 1;
    }
  }
  assert.ok(visibleCenterPixels > 0, "rain source must contain a visible center streak");

  for (const [x, y] of [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]]) {
    assert.ok(data[(y * info.width + x) * 4 + 3] <= 16, `rain corner (${x}, ${y}) must be transparent`);
  }
});
