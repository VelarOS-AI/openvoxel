import {readdir, readFile} from "node:fs/promises";
import {relative, resolve} from "node:path";
import {buildWebAssets} from "./web-assets.mjs";

async function outputFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await outputFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path));
    else throw new Error(`Generated Web asset ${path} has an unsupported file kind`);
  }
  return files;
}

const {files, outputRoot} = await buildWebAssets();
const expectedPaths = [...files.keys()].sort();
let actualPaths;
try {
  actualPaths = (await outputFiles(outputRoot)).sort();
} catch (error) {
  if (error?.code === "ENOENT") throw new Error("Generated Web assets are missing; run npm run generate --workspace @openvoxel/web");
  throw error;
}
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error("Generated Web asset file set is stale; run npm run generate --workspace @openvoxel/web");
}
for (const [relativePath, expected] of files) {
  const actual = await readFile(resolve(outputRoot, relativePath));
  if (!actual.equals(expected)) throw new Error(`Generated Web asset ${relativePath} is stale; run npm run generate --workspace @openvoxel/web`);
}
