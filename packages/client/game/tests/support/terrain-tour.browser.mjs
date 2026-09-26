import {instantiateWorldGenerator, defaultGenerator} from "@openvoxel/world-generation";
import {basePackedBlockCatalogSource, blockStateCatalog, collectBlockRenderResources} from "@openvoxel/blocks";
import {loadBuiltinClientResourcePack, createClientRenderCatalog, createClientLightField, meshChunk} from "@openvoxel/renderer";
import {openWorldGraphics} from "@openvoxel/game";
import {worldYearMilliseconds} from "@openvoxel/world";
import {collectLeafEmitters} from "../../src/backends/babylon/native/leaf-simulation.mjs";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";

const pack = await loadBuiltinClientResourcePack();
const source = basePackedBlockCatalogSource;
const catalog = createClientRenderCatalog({
  content: {contentHash: pack.targetContentHash, packs: []},
  schemaVersion: source.schemaVersion, catalogVersion: source.catalogVersion,
  stateMapHash: "0".repeat(64), generator: defaultGenerator,
  generatorHash: "0".repeat(64), generatorCatalogHash: "0".repeat(64),
  minimumWorldY: 0, maximumWorldY: 255, seaLevel: 64,
  resources: collectBlockRenderResources(blockStateCatalog()),
  blocks: source.blocks, componentProfiles: source.componentProfiles, states: source.states,
}, pack);
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
let surface;
let activeSite;
let shoreTarget;
let activeScene = null;
globalThis.__openVoxelCaptureScene = scene => { activeScene = scene; };

globalThis.discoverSpawnSites = () => ["openvoxel", "continental-ridges", "climate-extremes"].map((seed, index) => {
  const generator = instantiateWorldGenerator(defaultGenerator, seed, 16);
  return {name: `start-${index + 1}`, seed, ...generator.findSpawn()};
});

globalThis.discoverTerrainSites = async () => {
  const found = new Map();
  for (const seed of ["continental-ridges", "climate-extremes"]) {
    const generator = instantiateWorldGenerator(defaultGenerator, seed, 16);
    if (!found.has("spawn")) found.set("spawn", {name: "spawn", seed, ...generator.findSpawn()});
    for (let x = -768; x <= 768; x += 128) {
      for (let z = -768; z <= 768; z += 128) {
        const sample = generator.sample({x, z});
        const site = {seed, x, z, y: sample.surfaceY + 1, biome: sample.biome, terrainType: sample.terrainType};
        if (sample.biome.endsWith("/coast") && sample.surfaceY > 64 && sample.surfaceY <= 68 && !found.has("coast")) found.set("coast", {...site, name: "coast"});
        if (sample.terrainType.endsWith("/river") && !found.has("river")) found.set("river", {...site, name: "river"});
        if (sample.biome.endsWith("/desert") && !found.has("desert")) found.set("desert", {...site, name: "desert"});
        if (sample.biome.endsWith("/forest") && sample.surfaceY > 70 && !found.has("forest")) found.set("forest", {...site, name: "forest"});
        if (sample.terrainType.endsWith("/plain") && sample.surfaceY > 67 && !found.has("plain")) found.set("plain", {...site, name: "plain"});
        if (sample.terrainType.endsWith("/hill") && !found.has("hill")) found.set("hill", {...site, name: "hill"});
        if (sample.biome.endsWith("/tundra") && sample.surfaceY > 67 && !found.has("tundra")) found.set("tundra", {...site, name: "tundra"});
        if (sample.surfaceY > (found.get("mountain")?.y ?? 95)) found.set("mountain", {...site, name: "mountain"});
      }
      await pause();
    }
  }
  for (const name of ["spawn", "coast", "river", "desert", "forest", "mountain"]) {
    if (!found.has(name)) throw new Error("Terrain tour corpus is missing " + name);
  }
  return [...found.values()];
};

globalThis.loadTerrainSite = async (site, radius = 4, year = null) => {
  surface?.close();
  activeSite = site;
  const generator = instantiateWorldGenerator(defaultGenerator, site.seed, 16);
  const center = generator.sample({x: site.x, z: site.z});
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  shoreTarget = directions.map(([dx, dz]) => generator.sample({x: site.x + dx * 48, z: site.z + dz * 48}))
    .sort((a, b) => a.surfaceY - b.surfaceY)[0].position;
  const chunks = new Map();
  const cx = Math.floor(site.x / 16), cz = Math.floor(site.z / 16);
  const counts = {};
  const byId = new Map(source.states.map(state => [state.runtimeId, state.blockKey]));
  for (let x = cx - radius; x <= cx + radius; x += 1) {
    for (let z = cz - radius; z <= cz + radius; z += 1) {
      const samples = [[0, 0], [15, 0], [0, 15], [15, 15], [8, 8]].map(([dx, dz]) => generator.sample({x: x * 16 + dx, z: z * 16 + dz}));
      const bottom = Math.max(0, Math.floor(Math.min(...samples.map(s => s.surfaceY)) / 16) - 1);
      const top = Math.min(15, Math.floor((Math.max(64, ...samples.map(s => s.surfaceY)) + 24) / 16));
      for (let y = bottom; y <= top; y += 1) chunks.set(`${x}:${y}:${z}`, generator.generate({x, y, z}));
      for (const sample of samples) {
        const chunk = chunks.get(`${x}:${Math.floor(sample.surfaceY / 16)}:${z}`);
        const index = (sample.position.x - x * 16) + 16 * (sample.position.z - z * 16 + 16 * (sample.surfaceY % 16));
        const block = byId.get(chunk.palette[chunk.indices[index]]);
        counts[block] = (counts[block] ?? 0) + 1;
      }
    }
    await pause();
  }
  const target = {x: site.x, y: Math.max(center.surfaceY + 1, center.waterLevel ?? 64), z: site.z};
  surface = await openWorldGraphics({
    canvas: document.querySelector("canvas"), catalog, edge: 16,
    targetX: target.x, targetY: target.y, targetZ: target.z, horizontalChunkRadius: 6,
    navigationMode: "orbit", movementMode: "creative-flight", collisionAt: () => null,
    viewChanged: () => null, minimumWorldY: 0, maximumWorldY: 255,
    worldSeed: site.seed, worldClimate: {temperaturePeriod: 1024, humidityPeriod: 896, samplingStep: 4, seaLevel: 64},
    initialEnvironment: {worldMilliseconds: year === null ? 600000 : Math.round(((year - 0.125 + 1) % 1) * worldYearMilliseconds), samplePosition: target, timeOfDay: 0.5, moonPhase: 0,
      cloudiness: 0.15, precipitation: "none", precipitationIntensity: 0, windX: 2, windZ: 0.5, lightning: null},
  });
  const lighting = createClientLightField(16, catalog.lightStates);
  surface.setLighting(lighting.solve([...chunks.values()].map(chunk => ({
    position: chunk.position, blocks: Uint32Array.from(chunk.indices, index => chunk.palette[index]),
  })), []));
  for (const chunk of chunks.values()) {
    const {x: chunkX, y: chunkY, z: chunkZ} = chunk.position;
    if (Math.abs(chunkX - cx) === radius || Math.abs(chunkZ - cz) === radius) continue;
    const padded = new Uint32Array(18 ** 3);
    for (let y = 0; y < 18; y += 1) for (let z = 0; z < 18; z += 1) for (let x = 0; x < 18; x += 1) {
      const wx = chunkX * 16 + x - 1, wy = chunkY * 16 + y - 1, wz = chunkZ * 16 + z - 1;
      const nx = Math.floor(wx / 16), ny = Math.floor(wy / 16), nz = Math.floor(wz / 16);
      const neighbor = chunks.get(`${nx}:${ny}:${nz}`);
      if (neighbor) padded[x + 18 * (z + 18 * y)] = neighbor.palette[neighbor.indices[(wx - nx * 16) + 16 * (wz - nz * 16 + 16 * (wy - ny * 16))]];
    }
    await surface.enqueueChunkMesh(meshChunk(chunk.position, 16, padded, catalog.states, 1));
  }
  const camera = activeScene.activeCamera;
  camera.setTarget(new Vector3(target.x, target.y, target.z));
  return {site, currentHeight: center.surfaceY, surfaceSamples: counts, stats: surface.stats()};
};

globalThis.terrainTourView = view => {
  const camera = activeScene.activeCamera;
  // The production orbit camera limits elevation for editing. Inspection
  // poses must retain eye height, including a first-person grazing angle.
  camera.checkCollisions = false;
  camera.upperBetaLimit = Math.PI - 0.02;
  camera.upperRadiusLimit = null;
  if (view.startsWith("water-low")) {
    const level = activeSite.waterLevel === undefined ? 65 : activeSite.waterLevel + 1;
    const side = view === "water-low-side" ? -1 : 1;
    camera.setTarget(activeSite.name === "coast"
      ? new Vector3(shoreTarget.x, level, shoreTarget.z)
      : new Vector3(activeSite.x - 22, level, activeSite.z - 20));
    camera.setPosition(activeSite.name === "coast"
      ? new Vector3(activeSite.x + (shoreTarget.x - activeSite.x) * 0.35 + 4 * side, level + 1.6, activeSite.z + (shoreTarget.z - activeSite.z) * 0.35)
      : new Vector3(activeSite.x + 4 * side, level + 1.6, activeSite.z + 6));
    return;
  }
  if (view === "water" || view === "water-motion") {
    camera.setTarget(new Vector3(activeSite.x, activeSite.waterLevel + 0.15, activeSite.z));
    camera.setPosition(activeSite.name === "pond"
      ? new Vector3(activeSite.x + 6, activeSite.waterLevel + 8, activeSite.z + 7)
      : new Vector3(activeSite.x + 14, activeSite.waterLevel + 5.5, activeSite.z + 17));
    return;
  }
  if (view === "foliage") {
    const emitters = activeScene.meshes.flatMap(mesh => {
      const roles = mesh.getVerticesData("tintRole");
      return roles === null ? [] : collectLeafEmitters(mesh.getVerticesData("position"), mesh.getVerticesData("normal"), roles, mesh.position);
    }).sort((a, b) => Math.hypot(a.x - activeSite.x, a.z - activeSite.z) - Math.hypot(b.x - activeSite.x, b.z - activeSite.z));
    if (emitters.length > 0) {
      const source = emitters[0];
      camera.setTarget(new Vector3(source.x, source.y, source.z));
      camera.setPosition(new Vector3(source.x + 9, source.y + 0.5, source.z + 10));
      return;
    }
  }
  if (view === "eye" && activeSite.name.startsWith("start-")) {
    camera.setTarget(new Vector3(shoreTarget.x, 65, shoreTarget.z));
    camera.setPosition(new Vector3(activeSite.x, activeSite.y + 1.62, activeSite.z));
    return;
  }
  camera.alpha = -Math.PI / 3;
  camera.beta = view === "top" ? 0.03 : 1.18;
  camera.radius = view === "top" ? 90 : 48;
};
globalThis.terrainTourFoliageStats = () => surface.environmentStats().leaves;
globalThis.terrainTourRenderStats = () => {
  const scene = activeScene;
  const camera = scene.activeCamera;
  return {fps: scene.getEngine().getFps(), camera: {x: camera.position.x, y: camera.position.y, z: camera.position.z, directionY: camera.getForwardRay().direction.y}, targets: scene.customRenderTargets.map(target => ({name: target.name, size: target.getSize(), meshes: target.renderList?.length})), meshes: scene.meshes.length};
};
globalThis.terrainTourClose = () => {surface?.close(); surface = null;};
globalThis.terrainTourReady = true;
