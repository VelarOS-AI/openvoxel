import { readFile } from "node:fs/promises";
import { buildResourcePack, paths } from "./resource-pack.mjs";

const output = await buildResourcePack();
const [artifact, atlas, normalAtlas, specularAtlas] = await Promise.all([
  readFile(paths.artifact),
  readFile(paths.atlas),
  readFile(paths.normalAtlas),
  readFile(paths.specularAtlas),
]);
if (
  !artifact.equals(Buffer.from(output.artifactText))
  || !atlas.equals(output.atlasBytes)
  || !normalAtlas.equals(output.normalAtlasBytes)
  || !specularAtlas.equals(output.specularAtlasBytes)
) {
  throw new Error("Generated client resource pack is stale; run npm run generate --workspace @openvoxel/renderer");
}
