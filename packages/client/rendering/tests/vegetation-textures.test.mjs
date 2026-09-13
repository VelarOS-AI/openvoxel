import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import test from "node:test";
import sharp from "sharp";

const textureRoot = fileURLToPath(new URL("../data/textures/vegetation/", import.meta.url));
const cropTextures = [
  ...Array.from({length: 8}, (_value, age) => `rye_${age}.png`),
  ...Array.from({length: 3}, (_value, age) => `cotton_${age}.png`),
  ...Array.from({length: 8}, (_value, age) => `wheat_${age}.png`),
  ...Array.from({length: 4}, (_value, age) => `pumpkin_stem_${age}.png`),
  "large_dry_bush.png",
];
const pumpkinTextures = ["pumpkin_side.png", "pumpkin_top.png", "pumpkin_front.png"];
const ecologyTextures = [
  "birch_sapling.png",
  "blue_flower.png",
  "deadwood_side.png",
  "deadwood_top.png",
  "fallen_leaves.png",
  "kelp.png",
  "mimosa_sapling.png",
  "oak_sapling.png",
  "poplar_sapling.png",
  "rotten_pumpkin_front.png",
  "rotten_pumpkin_side.png",
  "rotten_pumpkin_top.png",
  "sea_urchin.png",
  "seagrass.png",
  "spruce_sapling.png",
  "tall_spruce_leaves.png",
  "starfish.png",
  "vine.png",
  "yellow_flower.png",
];
const ecologyCutouts = ecologyTextures.filter((name) => !name.startsWith("deadwood_") && !name.startsWith("rotten_pumpkin_") && !["starfish.png", "sea_urchin.png"].includes(name));

async function texture(name) {
  const path = `${textureRoot}${name}`;
  const [bytes, metadata, pixels] = await Promise.all([
    readFile(path),
    sharp(path).metadata(),
    sharp(path).ensureAlpha().raw().toBuffer(),
  ]);
  return {bytes, metadata, pixels};
}

test("ecology textures stay native 32px PNG assets", async () => {
  for (const name of [...cropTextures, ...pumpkinTextures, ...ecologyTextures]) {
    const loaded = await texture(name);
    assert.equal(loaded.metadata.format, "png", name);
    assert.equal(loaded.metadata.width, 32, name);
    assert.equal(loaded.metadata.height, 32, name);
  }
});

test("ecology overlays and plants preserve visible cutout silhouettes", async () => {
  for (const name of ecologyCutouts) {
    const loaded = await texture(name);
    const alpha = Array.from({length: 32 * 32}, (_value, index) => loaded.pixels[index * 4 + 3]);
    assert.ok(alpha.some((value) => value === 0), `${name} needs transparent cutout pixels`);
    assert.ok(alpha.some((value) => value > 0), `${name} needs visible pixels`);
  }
});

test("six generated tree crowns use distinct decoded leaf paintings", async () => {
  const leaves = ["oak_leaves.png", "birch_leaves.png", "spruce_leaves.png", "tall_spruce_leaves.png", "mimosa_leaves.png", "poplar_leaves.png"];
  const hashes = new Set();
  for (const name of leaves) hashes.add(createHash("sha256").update((await texture(name)).pixels).digest("hex"));
  assert.equal(hashes.size, leaves.length);
});

test("deadwood faces remain opaque authored surfaces", async () => {
  for (const name of ecologyTextures.filter((entry) => entry.startsWith("deadwood_"))) {
    const loaded = await texture(name);
    for (let index = 3; index < loaded.pixels.length; index += 4) assert.equal(loaded.pixels[index], 255, name);
  }
});

test("crop stages preserve cutout alpha and remain visually distinct", async () => {
  const hashes = new Set();
  for (const name of cropTextures) {
    const loaded = await texture(name);
    const alpha = Array.from({length: 32 * 32}, (_value, index) => loaded.pixels[index * 4 + 3]);
    assert.ok(alpha.some((value) => value === 0), `${name} needs transparent cutout pixels`);
    assert.ok(alpha.some((value) => value > 0), `${name} needs visible plant pixels`);
    hashes.add(createHash("sha256").update(loaded.bytes).digest("hex"));
  }
  assert.equal(hashes.size, cropTextures.length);
});

test("pumpkin surfaces share the authored model painting", async () => {
  const hashes = new Set();
  for (const name of pumpkinTextures) {
    const loaded = await texture(name);
    for (let index = 3; index < loaded.pixels.length; index += 4) assert.equal(loaded.pixels[index], 255, name);
    hashes.add(createHash("sha256").update(loaded.bytes).digest("hex"));
  }
  assert.equal(hashes.size, 1);
});
