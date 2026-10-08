import {createHash} from "node:crypto";
import {readdir, readFile} from "node:fs/promises";
import {dirname, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {buildCreativePreviewAssets} from "@openvoxel/game/creative-preview-assets";
import {webgpuRuntimeAssets} from "@openvoxel/game/webgpu-runtime-assets";
import {parse} from "yaml";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(appRoot, "data/assets.yml");
const outputRoot = resolve(appRoot, "public/generated");
const audioRoot = resolve(appRoot, "data/audio");
const controlsRoot = resolve(appRoot, "data/controls");

async function authoredAudioFiles(directory = audioRoot) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await authoredAudioFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".flac")) files.push(path);
    else throw new Error(`Web audio asset ${path} is not a FLAC file or directory`);
  }
  return files.sort();
}

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be a record`);
  return value;
}

function requireList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a list`);
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be non-empty text`);
  return value;
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireUnique(value, values, label) {
  if (values.has(value)) throw new Error(`${label} repeats ${value}`);
  values.add(value);
  return value;
}

function svgSymbol(svg, key, label) {
  const viewBox = svg.match(/\bviewBox="([^"]+)"/u)?.[1];
  const body = svg.match(/^<svg\b[^>]*>([\s\S]*)<\/svg>$/u)?.[1]
    ?.replace(/<!--![\s\S]*?-->/gu, "");
  if (viewBox === undefined || body === undefined || body.trim() === "") {
    throw new Error(`${label} is not a supported SVG icon`);
  }
  return `<symbol id="${key}" viewBox="${viewBox}">${body}</symbol>`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export async function buildWebAssets() {
  const sourceText = await readFile(sourcePath, "utf8");
  const source = requireRecord(parse(sourceText), "Web asset manifest");
  if (source.formatVersion !== 1) throw new Error("Unsupported Web asset manifest format");
  const files = new Map();
  const sourceBytes = [];
  for (const {name, bytes} of await webgpuRuntimeAssets()) {
    files.set(`webgpu/${name}`, bytes);
    sourceBytes.push(bytes);
  }
  const fontOutputs = new Set();
  const fonts = [];
  for (const raw of requireList(source.fonts, "Web asset fonts")) {
    const font = requireRecord(raw, "Web font");
    const family = requireText(font.family, "Web font family");
    const weight = requireInteger(font.weight, 100, 900, `Web font ${family} weight`);
    const specifier = requireText(font.source, `Web font ${family} source`);
    if (!specifier.startsWith("@fontsource/")) throw new Error(`Web font ${family} must come from @fontsource`);
    const output = requireUnique(requireText(font.output, `Web font ${family} output`), fontOutputs, "Web font output");
    if (!/^[a-z0-9-]+\.woff2$/u.test(output)) throw new Error(`Web font output ${output} is invalid`);
    const bytes = await readFile(fileURLToPath(import.meta.resolve(specifier)));
    files.set(`fonts/${output}`, bytes);
    sourceBytes.push(bytes);
    fonts.push({family, weight, output});
  }

  const creativeBlocks = [];
  for (const {previewName, bytes} of await buildCreativePreviewAssets()) {
    files.set(`creative-blocks/${previewName}.png`, bytes);
    sourceBytes.push(bytes);
    creativeBlocks.push(previewName);
  }

  const audio = [];
  for (const path of await authoredAudioFiles()) {
    const name = relative(audioRoot, path).split(/[/\\]/u).join("/");
    const bytes = await readFile(path);
    files.set(`audio/${name}`, bytes);
    sourceBytes.push(bytes);
    audio.push(name);
  }

  const iconKeys = new Set();
  const controls = [];
  for (const name of (await readdir(controlsRoot)).sort()) {
    if (!/^[A-Za-z_]+\.png$/u.test(name)) throw new Error(`Invalid touch control asset ${name}`);
    const bytes = await readFile(resolve(controlsRoot, name));
    files.set(`controls/${name}`, bytes);
    sourceBytes.push(bytes);
    controls.push(name);
  }
  const icons = [];
  const symbols = [];
  for (const raw of requireList(source.icons, "Web asset icons")) {
    const icon = requireRecord(raw, "Web icon");
    const key = requireUnique(requireText(icon.key, "Web icon key"), iconKeys, "Web icon key");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(key)) throw new Error(`Web icon key ${key} is invalid`);
    const style = requireText(icon.style, `Web icon ${key} style`);
    if (style !== "solid" && style !== "regular") throw new Error(`Web icon ${key} style is invalid`);
    const specifier = `@fortawesome/fontawesome-free/svgs/${style}/${key}.svg`;
    const bytes = await readFile(fileURLToPath(import.meta.resolve(specifier)));
    sourceBytes.push(bytes);
    symbols.push(svgSymbol(bytes.toString("utf8"), key, `Web icon ${key}`));
    icons.push({key, style});
  }
  const sprite = Buffer.from([
    '<svg xmlns="http://www.w3.org/2000/svg">',
    '<!-- Font Awesome Free 7.3.1 icons: CC BY 4.0; generated from the declared npm dependency. -->',
    ...symbols,
    '</svg>\n',
  ].join(""));
  files.set("icons.svg", sprite);

  const licenseOutputs = new Set();
  const licenses = [];
  for (const raw of requireList(source.licenses, "Web asset licenses")) {
    const license = requireRecord(raw, "Web asset license");
    const specifier = requireText(license.source, "Web asset license source");
    if (!specifier.startsWith("@fontsource/") && !specifier.startsWith("@fortawesome/")) {
      throw new Error(`Web asset license ${specifier} must belong to a declared asset dependency`);
    }
    const output = requireUnique(requireText(license.output, `Web asset license ${specifier} output`), licenseOutputs, "Web asset license output");
    if (!/^[a-z0-9-]+\.txt$/u.test(output)) throw new Error(`Web asset license output ${output} is invalid`);
    const bytes = await readFile(fileURLToPath(import.meta.resolve(specifier)));
    files.set(`licenses/${output}`, bytes);
    sourceBytes.push(bytes);
    licenses.push({specifier, output});
  }

  const digest = createHash("sha256");
  digest.update(JSON.stringify(canonical({formatVersion: source.formatVersion, fonts, creativeBlocks, audio, controls, icons, licenses})));
  for (const bytes of sourceBytes) digest.update(bytes);
  digest.update(sprite);
  const manifest = {
    artifactVersion: 1,
    contentHash: digest.digest("hex"),
    fonts,
    creativeBlocks,
    audio,
    controls,
    icons,
    licenses,
  };
  files.set("asset-manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return {files, outputRoot};
}
