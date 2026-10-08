import {performance} from "node:perf_hooks";
import {createHash} from "node:crypto";
import {builtinContentCatalog} from "@openvoxel/content";
import {baseBlockCatalogSource, createWorldBlockRegistry, packBlockCatalog, collectBlockRenderResources} from "@openvoxel/blocks";
import {createWorldGeneratorRegistry, instantiateWorldGenerator, defaultGenerator} from "@openvoxel/world-generation";
import {createClientRenderCatalog, snapshotChunkNeighborhood} from "../dist/index.js";
import {builtinClientResourcePack} from "../dist/builtin-resource-pack.js";
import {meshChunkWithIndex} from "../dist/mesher.js";
import {indexRenderStates} from "../dist/meshing/catalog.js";

const selected = builtinContentCatalog.defaultContent();
const blocks = createWorldBlockRegistry(baseBlockCatalogSource, selected.blockContributions);
const packed = packBlockCatalog(blocks.source);
const definitions = createWorldGeneratorRegistry(undefined, selected.generatorContributions, selected.ecosystemPacks);
const generator = instantiateWorldGenerator(defaultGenerator, "continental-ridges", 16, blocks, definitions);
const catalog = createClientRenderCatalog({
  content: selected.identity, schemaVersion: packed.schemaVersion, catalogVersion: packed.catalogVersion,
  stateMapHash: "0".repeat(64), generator: defaultGenerator, generatorHash: "0".repeat(64),
  generatorCatalogHash: "0".repeat(64), minimumWorldY: 0, maximumWorldY: 255, seaLevel: 64,
  resources: collectBlockRenderResources(blocks.registry.states()),
  blocks: packed.blocks, componentProfiles: packed.componentProfiles, states: packed.states,
}, builtinClientResourcePack);
const byRuntimeId = indexRenderStates(catalog.states);
const cache = new Map();
function chunkAt(position) {
  const key = `${position.x}:${position.y}:${position.z}`;
  if (!cache.has(key)) {
    const chunk = generator.generate(position);
    cache.set(key, {position, edge: 16, blockAtIndex: index => chunk.palette[chunk.indices[index]]});
  }
  return cache.get(key);
}
const inputs = [];
for (let x = 26; x <= 30; x += 1) for (let z = -3; z <= 1; z += 1) for (let y = 2; y <= 6; y += 1) {
  const position = {x, y, z};
  inputs.push({position, padded: snapshotChunkNeighborhood(chunkAt(position), chunkAt)});
}
for (let pass = 0; pass < 2; pass += 1) {
  const checksum = createHash("sha256");
  let elapsedMs = 0;
  let quads = 0;
  const times = [];
  for (const {position, padded} of inputs) {
    const started = performance.now();
    const mesh = meshChunkWithIndex(position, 16, padded, byRuntimeId, 1);
    const elapsed = performance.now() - started;
    elapsedMs += elapsed;
    times.push(elapsed);
    quads += mesh.quadCount;
    checksum.update(JSON.stringify(mesh.portalSummary));
    for (const batch of mesh.batches) {
      checksum.update(batch.pipelineKey);
      for (const field of ["positions", "normals", "uvs", "textureLayers", "tintRoles", "colors", "indices"]) {
        checksum.update(JSON.stringify([...batch[field]]));
      }
    }
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({pass, chunks: inputs.length, elapsedMs: Math.round(elapsedMs), p95Ms: times[Math.floor(times.length * .95)], quads, checksum: checksum.digest("hex")}));
}
