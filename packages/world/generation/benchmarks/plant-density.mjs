// Compare real pack-driven placement over a 128x128 suitable grassland patch.
// An optional prior builtin-packs artifact makes density changes reviewable.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {baseBlockCatalogSource, createWorldBlockRegistry} from "@openvoxel/blocks";
import {createWorldGeneratorRegistry, defaultGenerator} from "@openvoxel/world-generation";
import {createSurvivalBlockPalette} from "../dist/survival/block-palette.js";
import {columnPlanner, createGenerationFields} from "../dist/survival/terrain.js";
import {groundPlantFeatures} from "../dist/survival/ground-plants.js";
import {createEcologyPatterns} from "../dist/survival/ecology-patterns.js";
import {random} from "../dist/node_modules/velar/random.js";

const current = new URL("../../../content/packs/generated/builtin-packs.json", import.meta.url);
for (const path of [...process.argv.slice(2), current]) {
  const artifacts = JSON.parse(await readFile(path, "utf8"));
  const packs = artifacts.toSorted((a, b) => a.owner.localeCompare(b.owner));
  const registry = createWorldBlockRegistry(baseBlockCatalogSource, packs.flatMap(pack => pack.blocks ?? [])).registry;
  const definitions = createWorldGeneratorRegistry(undefined,
    packs.flatMap(pack => pack.worldGeneration ?? []), packs.flatMap(pack => pack.ecosystem ?? []));
  const profile = definitions.definition(defaultGenerator);
  const blocks = createSurvivalBlockPalette(registry, definitions.palette(profile.palette).blocks);
  const core = columnPlanner(createGenerationFields("density-corpus", profile), 16).columns(0, 0);
  const base = core.sampleAt(0, 0);
  for (const biome of ["openvoxel:biome/meadow", "botanical:flower_fields"]) {
    const counts = new Map(), patches = [], root = random("density-corpus").fork("decoration");
    const patterns = createEcologyPatterns("density-corpus", "ground", profile.vegetation.groundPatchPeriod);
    for (let chunkX = -4; chunkX < 4; chunkX++) for (let chunkZ = -4; chunkZ < 4; chunkZ++) {
      const column = {...core, minimumX: chunkX * 16, minimumZ: chunkZ * 16, sampleAt: (x, z) => ({...base,
        position: {x, z}, biome, biomeFamily: "openvoxel:biome/meadow", temperature: 12, humidity: 9,
        slope: 0, surfaceY: 76, roadDistance: null, waterBody: null, waterLevel: null, riverStrength: 0,
      })};
      const plants = groundPlantFeatures(profile, blocks, registry, column, root, patterns);
      patches.push(plants.length);
      for (const plant of plants) {
        const key = registry.requireStateByRuntimeId(plant.writes[0].runtimeId).blockKey;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const total = patches.reduce((a, b) => a + b, 0);
    const purple = [...counts].filter(([key]) => /purple_flower|lavender|allium/u.test(key)).reduce((n, [, count]) => n + count, 0);
    assert.ok(total > 0 && counts.size >= 8, "grassland should retain a mixed community");
    if (path === current) assert.ok(purple / 16384 < .025, "purple plants should remain sparse");
    console.log(JSON.stringify({source: path === current ? "current" : "prior", biome, columns: 64,
      plants: total, purple, coverage: total / 16384, minPatch: Math.min(...patches), maxPatch: Math.max(...patches),
      species: [...counts].sort((a, b) => b[1] - a[1])}));
  }
}
