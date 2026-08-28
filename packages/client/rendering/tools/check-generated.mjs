import { readFile } from "node:fs/promises";
import { buildResourcePack, paths } from "./resource-pack.mjs";

const output = await buildResourcePack();
const [artifact, atlas] = await Promise.all([readFile(paths.artifact), readFile(paths.atlas)]);
if (!artifact.equals(Buffer.from(output.artifactText)) || !atlas.equals(output.atlasBytes)) {
  throw new Error("Generated client resource pack is stale; run npm run generate --workspace @openvoxel/renderer");
}
