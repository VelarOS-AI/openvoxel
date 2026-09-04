import {mkdir, rm, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {buildWebAssets} from "./web-assets.mjs";

const {files, outputRoot} = await buildWebAssets();
await rm(outputRoot, {recursive: true, force: true});
for (const [relativePath, bytes] of files) {
  const path = resolve(outputRoot, relativePath);
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, bytes);
}
