import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import sharp from "sharp";

const palettePath = new URL("../data/creative-palette.json", import.meta.url);
const resourcePackPath = fileURLToPath(import.meta.resolve("@openvoxel/renderer/resource-pack-data"));

function requireEntries(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty list`);
  return value;
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be non-empty text`);
  return value;
}

function requireLayer(value, count, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= count) {
    throw new Error(`${label} must select a texture bank layer`);
  }
  return value;
}

/** The game owns the palette; renderer's public artifact owns the actual texture pixels. */
export async function buildCreativePreviewAssets() {
  const [palette, resourcePack] = await Promise.all([
    readFile(palettePath, "utf8").then(JSON.parse),
    readFile(resourcePackPath, "utf8").then(JSON.parse),
  ]);
  if (palette?.formatVersion !== 1) throw new Error("Unsupported Creative palette format");
  const entries = requireEntries(palette.entries, "Creative palette entries");
  if (entries.length > 5) throw new Error("Creative palette exceeds the five available number keys");
  const textures = new Map(requireEntries(resourcePack.textures, "Renderer textures").map((texture) => [texture.key, texture]));
  const banks = new Map(requireEntries(resourcePack.textureBanks, "Renderer texture banks").map((bank) => [bank.key, bank]));
  const names = new Set();
  const stateKeys = new Set();
  const previews = [];
  for (const value of entries) {
    const entry = requireRecord(value, "Creative block entry");
    const label = requireText(entry.label, "Creative block label");
    const stateKey = requireText(entry.stateKey, `Creative block ${label} state key`);
    if (stateKeys.has(stateKey)) throw new Error(`Creative palette repeats state ${stateKey}`);
    stateKeys.add(stateKey);
    const previewName = requireText(entry.previewName, `Creative block ${label} preview name`);
    if (!/^[a-z][a-z0-9-]*$/u.test(previewName) || names.has(previewName)) {
      throw new Error(`Creative block ${label} has an invalid or repeated preview name ${previewName}`);
    }
    names.add(previewName);
    const textureKey = requireText(entry.textureKey, `Creative block ${label} texture key`);
    const texture = textures.get(textureKey);
    if (texture === undefined) throw new Error(`Renderer resource pack does not provide Creative texture ${textureKey}`);
    const bank = banks.get(texture.bankKey);
    const level = bank?.levels?.[0];
    if (level === undefined || !Number.isSafeInteger(level.width) || !Number.isSafeInteger(level.height)
      || level.width < 1 || level.height < 1 || typeof level.albedoData !== "string") {
      throw new Error(`Renderer texture bank is invalid for ${textureKey}`);
    }
    const layerBytes = level.width * level.height * 4;
    const pixels = Buffer.from(level.albedoData, "base64");
    if (!Number.isSafeInteger(bank.layerCount) || pixels.length !== layerBytes * bank.layerCount) {
      throw new Error(`Renderer texture bank albedo data is invalid for ${textureKey}`);
    }
    const layer = requireLayer(texture.variants?.[0]?.layer, bank.layerCount, textureKey);
    const source = pixels.subarray(layer * layerBytes, (layer + 1) * layerBytes);
    // Texture array layers store GPU bottom-first rows; PNG previews use top-first rows.
    const bytes = await sharp(source, {raw: {width: level.width, height: level.height, channels: 4}})
      .flip()
      .png()
      .toBuffer();
    previews.push({previewName, bytes});
  }
  return previews;
}
