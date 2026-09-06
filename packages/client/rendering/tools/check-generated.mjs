import {readdir, readFile} from "node:fs/promises";
import {buildResourcePack, paths} from "./resource-pack.mjs";

const output = await buildResourcePack();
const [artifact, audit] = await Promise.all([
  readFile(paths.artifact),
  readFile(paths.audit),
]);
let obsoleteBankEntries = [];
try {
  obsoleteBankEntries = (await readdir(paths.bankRoot, {withFileTypes: true}))
    .map((entry) => entry.name)
    .sort();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (!artifact.equals(Buffer.from(output.artifactText))
  || !audit.equals(Buffer.from(output.auditText))
  || obsoleteBankEntries.length > 0) {
  throw new Error("Generated client resource pack is stale; run npm run generate --workspace @openvoxel/renderer");
}
