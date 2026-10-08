import {gameSettings, subscribeGameSettings} from "../../../settings/preferences.mjs";
import "@babylonjs/core/Collisions/collisionCoordinator.js";
import "@babylonjs/core/Culling/ray.js";
import {createRenderEngine} from "./render-engine.mjs";
import {Color3, Color4} from "@babylonjs/core/Maths/math.color.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";
import {Mesh} from "@babylonjs/core/Meshes/mesh.js";
import {DefaultRenderingPipeline} from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js";
import {ColorCurves} from "@babylonjs/core/Materials/colorCurves.js";
import {ImageProcessingConfiguration} from "@babylonjs/core/Materials/imageProcessingConfiguration.js";
import {Scene} from "@babylonjs/core/scene.js";
import {
  loadTextureBank,
  requireTextureBankDefinitions,
} from "./texture-bank.mjs";
import {createTerrainGroundProbe, terrainColumnKey} from "./terrain-ground.mjs";
import {LatestFrameWorkQueue, TranslucentSortScheduler, WeatherColumnInvalidationScheduler} from "./surface-work-scheduler.mjs";
import {ClimateTintField} from "./climate-tint.mjs";
import {VoxelMaterialLibrary} from "./material-library.mjs";
import {createNavigationCamera, createNavigation} from "./camera.mjs";
import {createEnvironmentAdapter} from "./environment.mjs";
import {chunkKey, requireCanvas, requireInteger, requireSurfaceDependencies, requireSurfaceOptions, validateChunkMesh} from "./surface-contract.mjs";
import {SurfaceLifetime} from "./surface-lifetime.mjs";
import {WorldMinimapRenderer} from "./minimap.mjs";
import {TranslucentMeshSorter} from "./translucent-sort.mjs";
import {ChunkPresentation} from "./chunk-presentation.mjs";
import {resizeWithinBudget} from "./render-budget.mjs";
import {VoxelLightingTextures} from "./voxel-lighting.mjs";
import {LocalLights} from "./local-lights.mjs";
import {FrameStatistics} from "./frame-statistics.mjs";
import {DistanceDetail} from "./distance-detail.mjs";
import {BlockSelectionOutline} from "./block-selection.mjs";
import {installChunkGeometry} from "./packed-geometry.mjs";

import {createLeafParticles} from "./leaf-particles.mjs";
import {WaterCapture} from "./water-capture.mjs";
import {collectLeafEmitters} from "./leaf-simulation.mjs";

const surfaces = new WeakSet();

export class BabylonWorldGraphics {
  constructor(canvas, options, engine, scene, camera, navigation, textureBanks, environment, lifetime, pipeline) {
    this.canvas = canvas;
    this.edge = options.edge;
    this.engine = engine;
    this.scene = scene;
    this.camera = camera;
    this.navigation = navigation;
    this.textureBanks = textureBanks;
    this.environment = environment;
    this.climateTintField = new ClimateTintField(options.edge, options.climateAt);
    this.climateTintField.setTime(options.environmentFrame.climateMilliseconds);
    this.lifetime = lifetime;
    this.blockSelection = new BlockSelectionOutline(scene);
    lifetime.defer(() => this.blockSelection.dispose());
    this.lighting = new VoxelLightingTextures(scene, options.edge);
    lifetime.defer(() => this.lighting.dispose());
    this.materialLibrary = new VoxelMaterialLibrary(scene, options, textureBanks, this.climateTintField, environment.atmosphere, this.lighting);
    lifetime.defer(() => this.materialLibrary.dispose());
    lifetime.defer(() => this.climateTintField.clear());
    this.chunks = new Map();
    this.distanceDetail = new DistanceDetail();
    lifetime.defer(() => this.distanceDetail.clear());
    this.chunkPresentation = new ChunkPresentation(key => !this.lighting.enabled || this.lighting.chunks.has(key));
    lifetime.defer(() => this.chunkPresentation.clear());
    this.terrainMeshes = new Set();
    this.terrainColumns = new Map();
    this.localLights = new LocalLights(scene, this.lighting, this.terrainColumns, this.edge);
    lifetime.defer(() => this.localLights.dispose());
    this.waterCapture = new WaterCapture(scene, camera, this.materialLibrary.waterSurfaceRuntime, this.terrainColumns, environment, this.edge);
    lifetime.defer(() => this.waterCapture.dispose());
    this.terrainGroundProbe = createTerrainGroundProbe(
      this.terrainMeshes,
      options.maximumWorldY - options.minimumWorldY + this.edge * 2,
      {chunkEdge: this.edge, terrainColumns: this.terrainColumns},
    );
    this.leafGroundProbe = createTerrainGroundProbe(
      this.terrainMeshes, options.maximumWorldY - options.minimumWorldY + this.edge * 2,
      {chunkEdge: this.edge, terrainColumns: this.terrainColumns, meshFilter: mesh => !mesh.hasFoliage},
    );
    this.leaves = createLeafParticles(scene, environment.textures.leaf, this.edge,
      position => this.climateTintField.forPosition(position).corners[0],
      (x, z, y) => this.leafGroundProbe.sampleColumn(x, z, y));
    lifetime.defer(() => this.leaves.dispose());
    this.weatherProbeOriginY = options.maximumWorldY + this.edge;
    this.weatherGroundAt = (x, z) => this.terrainGroundProbe.sampleColumn(x, z, this.weatherProbeOriginY);
    this.weatherColumnInvalidations = new WeatherColumnInvalidationScheduler(
      (chunkX, chunkZ) => this.environment.invalidateTerrainColumn(chunkX, chunkZ),
    );
    this.meshCount = 0;
    this.quadCount = 0;
    this.translucentSorters = new Map();
    this.minimap = options.minimapCanvas == null ? null : new WorldMinimapRenderer(scene, engine, camera, canvas, options.minimapCanvas, this.terrainColumns, options);
    lifetime.defer(() => this.minimap?.dispose());
    this.chunkUploadQueue = new LatestFrameWorkQueue((chunk) => this.setChunkMesh(chunk));
    this.translucentSortScheduler = new TranslucentSortScheduler({
      positionFor: (mesh) => mesh.position,
      maximumDistance: this.edge * 3.5,
    });
    const restoreSorting = engine.onContextRestoredObservable.add(() => {
      for (const sorter of this.translucentSorters.values()) sorter.restore();
      this.localLights.invalidate();
    });
    lifetime.defer(() => engine.onContextRestoredObservable.remove(restoreSorting));
    this.released = false;
    let appliedSettings = null;
    const applySettings = settings => {
      const previous = appliedSettings;
      appliedSettings = settings;
      this.settings = settings;
      camera.fov = settings.fov * Math.PI / 180;
      scene.shadowsEnabled = settings.shadows;
      if (previous?.softShadows !== settings.softShadows) environment.setSoftShadows(settings.softShadows);
      scene.imageProcessingConfiguration.exposure = settings.brightness;
      scene.imageProcessingConfiguration.colorCurves.globalSaturation = settings.saturation;
      if (previous?.antialias !== settings.antialias) pipeline.fxaaEnabled = settings.antialias;
      if (previous?.bloom !== settings.bloom) pipeline.bloomEnabled = settings.bloom;
      if (previous !== null && previous.viewDistance !== settings.viewDistance) environment.renderDistance = this.edge * settings.viewDistance;
      environment.fogMultiplier = settings.fog;
      environment.updateVisuals(environment.frame.lightningFlash);
      camera.maxZ = Math.max(512, environment.renderDistance * 5);
      this.waterCapture.enabled = settings.waterReflections;
      this.materialLibrary.vegetationMotionRuntime.enabled = settings.vegetationMotion;
      environment.weather.enabled = settings.particles;
      this.leaves.enabled = settings.particles;
      if (previous?.renderScale !== settings.renderScale) resizeWithinBudget(engine, canvas, undefined, settings.renderScale);
    };
    applySettings(gameSettings());
    const settingsSubscription = subscribeGameSettings(applySettings);
    lifetime.defer(() => settingsSubscription.close());
    this.resizeObserver = new ResizeObserver(() => resizeWithinBudget(engine, canvas, undefined, this.settings.renderScale));
    lifetime.defer(() => this.resizeObserver.disconnect());
    this.resizeObserver.observe(canvas);
    const frameStatistics = new FrameStatistics(options.frameSampled);
    const visibilityChanged = () => frameStatistics.sample(performance.now(), false);
    canvas.ownerDocument.addEventListener("visibilitychange", visibilityChanged);
    lifetime.defer(() => canvas.ownerDocument.removeEventListener("visibilitychange", visibilityChanged));
    this.render = () => {
      const deltaMs = Math.min(engine.getDeltaTime(), 100);
      navigation.update(deltaMs);
      this.weatherColumnInvalidations.advance(deltaMs);
      if (this.chunkPresentation.update()) environment.shadowRefresh.invalidate();
      this.chunkUploadQueue.drainFrame();
      this.climateTintField.update();
      this.distanceDetail.update(deltaMs, this.camera.globalPosition);
      this.weatherColumnInvalidations.flushReady();
      this.sortNextTranslucentMesh(deltaMs);
      this.materialLibrary.update(deltaMs, this.camera.globalPosition);
      environment.update(
        deltaMs,
        this.camera.globalPosition,
        null,
        this.weatherGroundAt,
      );
      this.leaves.update(deltaMs, this.camera.globalPosition, environment.frame);
      this.localLights.update(deltaMs, this.camera.globalPosition);
      this.waterCapture.update(deltaMs);
      scene.render();
      // The map also samples shadows; capture only after this frame's light
      // depth maps have been generated, just like the water camera targets.
      if (this.settings.minimap) { this.minimap?.update(deltaMs); this.minimap?.draw(); }
      frameStatistics.sample(performance.now(), !canvas.ownerDocument.hidden);
    };
    lifetime.defer(() => engine.stopRenderLoop(this.render));
    engine.runRenderLoop(this.render);
    surfaces.add(this);
  }

  requireLive() {
    if (!surfaces.has(this) || this.released) throw new Error("Voxel surface is released");
  }

  setBlockSelection(selection) {
    this.requireLive();
    this.blockSelection.set(selection);
  }

  sortNextTranslucentMesh(deltaMs) {
    const position = this.camera.globalPosition;
    const mesh = this.translucentSortScheduler.next(position, deltaMs);
    if (mesh === null) return;
    this.translucentSorters.get(mesh).sort(position);
  }

  addTerrainMesh(mesh, columnKey) {
    this.localLights.invalidate();
    this.terrainMeshes.add(mesh);
    this.waterCapture.register(mesh);
    let meshes = this.terrainColumns.get(columnKey);
    if (meshes === undefined) {
      meshes = new Set();
      this.terrainColumns.set(columnKey, meshes);
    }
    meshes.add(mesh);
  }

  removeTerrainMesh(mesh, columnKey) {
    this.distanceDetail.remove(mesh);
    this.localLights.invalidate();
    this.leaves?.remove(mesh);
    this.waterCapture?.remove(mesh);
    this.terrainMeshes.delete(mesh);
    const meshes = this.terrainColumns.get(columnKey);
    if (meshes === undefined) return;
    meshes.delete(mesh);
    if (meshes.size === 0) this.terrainColumns.delete(columnKey);
  }

  invalidateTerrainColumn(chunkX, chunkZ) {
    this.minimap?.invalidateColumn(chunkX, chunkZ);
    this.terrainGroundProbe.invalidateColumn(chunkX, chunkZ);
    this.leafGroundProbe?.invalidateColumn(chunkX, chunkZ);
    this.weatherColumnInvalidations.invalidate(chunkX, chunkZ);
  }

  disposeChunk(key, invalidate = true) {
    const current = this.chunks.get(key);
    if (current === undefined) return;
    for (const mesh of current.meshes) {
      this.removeTerrainMesh(mesh, current.columnKey);
      this.translucentSorters.delete(mesh);
      this.translucentSortScheduler.delete(mesh);
      this.environment.removeShadowCaster(mesh);
      mesh.checkCollisions = false;
    }
    this.meshCount -= current.meshes.length;
    this.quadCount -= current.quads;
    this.chunks.delete(key);
    this.chunkPresentation.remove(key);
    for (const mesh of current.meshes) mesh.dispose(false, false);
    if (invalidate) this.invalidateTerrainColumn(current.columnX, current.columnZ);
  }

  setChunkMesh(chunk) {
    this.requireLive();
    const validated = validateChunkMesh(chunk, this.edge, this.materialLibrary);
    const columnKey = terrainColumnKey(validated.x, validated.z);
    const meshes = [];
    try {
      for (const item of validated.batches) {
        const {index, batch, positions, normals, uvs, textureLayers, tintRoles, colors, indices} = item;
        const mesh = new Mesh("chunk:" + validated.key + ":" + index, this.scene);
        meshes.push(mesh);
        const material = this.materialLibrary.materialFor(batch, mesh);
        this.lighting.attach(mesh, validated.key);
        // Only translucent indices change during camera movement. The vertex
        // buffers remain static; shader-driven waves do not mutate them.
        installChunkGeometry(mesh, item);
        mesh.hasFoliage = tintRoles.some(role => role === 2 || (role >= 5 && role !== 7));
        mesh.leafEmitters = collectLeafEmitters(positions, normals, tintRoles, {x: validated.x * this.edge, y: validated.y * this.edge, z: validated.z * this.edge});
        mesh.hasClimateTint = tintRoles.some((role) => role !== 0);
        mesh.precipitationSurface = this.materialLibrary.materialDefinitions.get(batch.materialKey).precipitationSurface;
        mesh.material = material;
        this.distanceDetail.add(mesh, batch.materialKey);
        mesh.position.set(validated.x * this.edge, validated.y * this.edge, validated.z * this.edge);
        mesh.useVertexColors = true;
        mesh.hasVertexAlpha = false;
        mesh.isPickable = false;
        mesh.checkCollisions = batch.layer === "opaque";
        mesh.receiveShadows = true;
        // 透明地形在天体和云层之后绘制，但通过组间保留深度继续
        // 受不透明地形遮挡。
        mesh.renderingGroupId = batch.layer === "translucent" ? 2 : 0;
        mesh.freezeWorldMatrix();
        if (batch.layer === "translucent") {
          this.translucentSorters.set(mesh, new TranslucentMeshSorter(mesh, positions, indices));
          this.translucentSortScheduler.add(mesh);
        } else {
          const definition = this.materialLibrary.materialDefinitions.get(batch.materialKey);
          if (definition === undefined) throw new Error("Unknown voxel material " + batch.materialKey);
          mesh.castsVoxelShadow = definition.castsShadows;
          if (definition.castsShadows) this.environment.addShadowCaster(mesh);
        }
      }
      // Keep the previous visible Chunk until the complete replacement has
      // passed validation and every new mesh has reached GPU staging.
      this.disposeChunk(validated.key, false);
      this.chunkPresentation.show(validated.key, meshes);
      this.meshCount += meshes.length;
      this.quadCount += validated.quads;
      for (const mesh of meshes) {
        this.addTerrainMesh(mesh, columnKey);
        this.leaves.register(mesh, validated.x, validated.z, mesh.leafEmitters);
        mesh.leafEmitters = null;
      }
      this.chunks.set(validated.key, {meshes, quads: validated.quads, columnKey, columnX: validated.x, columnZ: validated.z});
      this.invalidateTerrainColumn(validated.x, validated.z);
    } catch (error) {
      for (const mesh of meshes) {
        this.removeTerrainMesh(mesh, columnKey);
        this.translucentSorters.delete(mesh);
        this.translucentSortScheduler.delete(mesh);
        this.environment.removeShadowCaster(mesh);
        mesh.dispose(false, false);
      }
      throw error;
    }
  }

  enqueueChunkMesh(chunk, mayCommit = () => true) {
    this.requireLive();
    const position = chunk?.position;
    const x = requireInteger(position?.x, -33_554_431, 33_554_431, "Chunk x");
    const y = requireInteger(position?.y, -33_554_431, 33_554_431, "Chunk y");
    const z = requireInteger(position?.z, -33_554_431, 33_554_431, "Chunk z");
    return this.chunkUploadQueue.enqueue(chunkKey(x, y, z), chunk, mayCommit);
  }

  removeChunk(x, y, z) {
    this.requireLive();
    const key = chunkKey(x, y, z);
    this.chunkUploadQueue.cancel(key);
    this.disposeChunk(key);
  }

  stats() {
    this.requireLive();
    const navigation = this.navigation.stats();
    return {
      backend: this.engine.isWebGPU ? "WebGPU" : "WebGL 2",
      chunks: this.chunks.size,
      meshes: this.meshCount,
      quads: this.quadCount,
      uploadQueuedChunks: this.chunkUploadQueue.size,
      translucentSortQueuedMeshes: this.translucentSortScheduler.size,
      navigationMode: navigation.navigationMode,
      movementMode: navigation.movementMode,
      viewX: navigation.viewX,
      viewY: navigation.viewY,
      viewZ: navigation.viewZ,
      viewChunkX: navigation.viewChunkX,
      viewChunkY: navigation.viewChunkY,
      viewChunkZ: navigation.viewChunkZ,
      forwardX: navigation.forwardX,
      forwardY: navigation.forwardY,
      forwardZ: navigation.forwardZ,
      pointerLocked: navigation.pointerLocked,
    };
  }

  environmentStats() {
    this.requireLive();
    return {...this.environment.stats(), leaves: this.leaves.stats()};
  }

  setEnvironmentFrame(frame) {
    this.requireLive();
    this.environment.applyFrame(frame);
    this.materialLibrary.setEnvironmentFrame(frame);
    this.climateTintField.setTime(frame.climateMilliseconds);
  }

  setLighting(update) {
    this.requireLive();
    this.lighting.apply(update);
    this.localLights.invalidate();
    this.waterCapture.dirty = true;
  }

  release() {
    if (!surfaces.has(this) || this.released) return;
    this.released = true;
    this.engine.stopRenderLoop(this.render);
    this.chunkUploadQueue.clear();
    this.chunkPresentation.clear();
    try {
      for (const key of [...this.chunks.keys()]) this.disposeChunk(key);
    } finally {
      this.chunks.clear();
      this.meshCount = 0;
      this.quadCount = 0;
      this.translucentSorters.clear();
      this.translucentSortScheduler.clear();
      this.terrainMeshes.clear();
      this.terrainColumns.clear();
      this.weatherColumnInvalidations.clear();
      surfaces.delete(this);
      this.lifetime.dispose();
    }
  }
}

export async function createSurfaceAdapter(canvas, candidate, dependencies) {
  canvas = requireCanvas(canvas);
  const options = requireSurfaceOptions(candidate);
  dependencies = requireSurfaceDependencies(dependencies);
  const textureBankDefinitions = requireTextureBankDefinitions(options.textureBanks);
  if (typeof Uint8Array.fromBase64 !== "function") throw new Error("Voxel rendering requires the modern Uint8Array.fromBase64 Web API");
  const {edge, horizontalChunkRadius} = options;
  const renderDistance = edge * horizontalChunkRadius;
  const lifetime = new SurfaceLifetime();
  try {
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    const engine = await createRenderEngine(canvas, gameSettings().renderBackend);
    lifetime.defer(() => engine.dispose());
    // Follow display RAFs. A fixed cap skips refreshes unevenly on high/variable
    // refresh displays, and also delays input and camera integration.
    engine.renderEvenInBackground = false;
    resizeWithinBudget(engine, canvas);
    if (!engine.isWebGPU && engine.webGLVersion < 2) throw new Error("Voxel rendering requires WebGL 2 texture arrays");
    const maximumTextureArrayLayers = engine.getCaps().texture2DArrayMaxLayerCount;
    if (!Number.isSafeInteger(maximumTextureArrayLayers) || maximumTextureArrayLayers < 1) {
      throw new Error("Voxel rendering could not determine the GPU texture array layer limit");
    }
    const scene = new Scene(engine);
    lifetime.defer(() => scene.dispose());
    scene.useRightHandedSystem = true;
    scene.collisionsEnabled = true;
    for (let group = 1; group <= 4; group += 1) scene.setRenderingAutoClearDepthStencil(group, false, false, false);
    scene.clearColor = new Color4(0.19, 0.4, 0.66, 1);
    scene.ambientColor = new Color3(0.22, 0.25, 0.28);
    scene.skipPointerMovePicking = true;
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    scene.imageProcessingConfiguration.exposure = 0.95;
    const colorCurves = new ColorCurves();
    colorCurves.globalSaturation = -5;
    scene.imageProcessingConfiguration.colorCurves = colorCurves;
    scene.imageProcessingConfiguration.colorCurvesEnabled = true;
    scene.imageProcessingConfiguration.contrast = 1.03;
    scene.fogMode = Scene.FOGMODE_LINEAR;
    const target = new Vector3(options.targetX, options.targetY, options.targetZ);
    const camera = createNavigationCamera(scene, canvas, options, target, edge, horizontalChunkRadius, renderDistance);
    // Display-space post effects leave sky/fog and PBR exposure in their owners.
    const pipeline = new DefaultRenderingPipeline("openvoxel-environment-finish", false, scene, [camera], false);
    pipeline.fxaaEnabled = true;
    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.86;
    pipeline.bloomWeight = 0.08;
    pipeline.bloomKernel = 32;
    pipeline.bloomScale = 0.5;
    pipeline.prepare();
    lifetime.defer(() => pipeline.dispose());
    const textureBanks = new Map();
    for (const definition of textureBankDefinitions) {
      const bank = loadTextureBank(scene, definition, maximumTextureArrayLayers);
      textureBanks.set(bank.key, bank);
      lifetime.defer(() => {
        for (const texture of [bank.albedo, bank.normal, bank.material, bank.emissive]) texture.dispose();
        textureBanks.delete(bank.key);
      });
    }
    const environment = await createEnvironmentAdapter(scene, edge, renderDistance, options.environmentResources, options.environmentFrame);
    lifetime.defer(() => environment.dispose());
    const navigation = createNavigation(canvas, options, camera, dependencies);
    lifetime.defer(() => navigation.release());
    const contextRestoreObserver = engine.onContextRestoredObservable.add(() => {
      for (const bank of textureBanks.values()) bank.restore();
      environment.restore();
    });
    lifetime.defer(() => engine.onContextRestoredObservable.remove(contextRestoreObserver));
    return new BabylonWorldGraphics(canvas, options, engine, scene, camera, navigation, textureBanks, environment, lifetime, pipeline);
  } catch (error) {
    try {
      lifetime.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Voxel surface initialization failed", {cause: error});
    }
    throw error;
  }
}
