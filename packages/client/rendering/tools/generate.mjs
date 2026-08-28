import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildResourcePack, paths } from "./resource-pack.mjs";

async function writeChanged(path, value) {
  let current = null;
  try {
    current = await readFile(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const next = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (current !== null && current.equals(next)) return;
  await writeFile(path, next);
}

const output = await buildResourcePack();
await mkdir(dirname(paths.artifact), {recursive: true});
await Promise.all([
  writeChanged(paths.artifact, output.artifactText),
  writeChanged(paths.atlas, output.atlasBytes),
]);
