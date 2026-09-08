import "@babylonjs/core/Collisions/collisionCoordinator.js";
import "@babylonjs/core/Culling/ray.js";
import {Engine} from "@babylonjs/core/Engines/engine.js";
import {Color3, Color4} from "@babylonjs/core/Maths/math.color.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";
import {Mesh} from "@babylonjs/core/Meshes/mesh.js";
import {VertexData} from "@babylonjs/core/Meshes/mesh.vertexData.js";
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
import {chunkKey, requireCanvas, requireInteger, requireSurfaceDependencies, requireSurfaceOptions, validateChunkMesh} from "./surface-contract.mjs";
import {SurfaceLifetime} from "./surface-lifetime.mjs";

const surfaces = new WeakSet();

export class BabylonVoxelSurface {
  constructor(canvas, options, engine, scene, camera, navigation, textureBanks, environment, lifetime) {
    this.canvas = canvas;
    this.edge = options.edge;
    this.engine = engine;
    this.scene = scene;
    this.camera = camera;
    this.navigation = navigation;
    this.textureBanks = textureBanks;
    this.environment = environment;
    this.climateTintField = new ClimateTintField(options.edge, options.climateAt);
    this.climateTintField.setTime(options.environmentFrame.worldMilliseconds);
    this.lifetime = lifetime;
    this.materialLibrary = new VoxelMaterialLibrary(scene, options, textureBanks, this.climateTintField);
    lifetime.defer(() => this.materialLibrary.dispose());
    lifetime.defer(() => this.climateTintField.clear());
    this.chunks = new Map();
    this.terrainMeshes = new Set();
    this.terrainColumns = new Map();
    this.terrainGroundProbe = createTerrainGroundProbe(
      this.terrainMeshes,
      options.maximumWorldY - options.minimumWorldY + this.edge * 2,
      {chunkEdge: this.edge, terrainColumns: this.terrainColumns},
    );
    this.weatherProbeOriginY = options.maximumWorldY + this.edge;
    this.weatherGroundAt = (x, z) => this.terrainGroundProbe.sampleColumn(x, z, this.weatherProbeOriginY);
    this.weatherColumnInvalidations = new WeatherColumnInvalidationScheduler(
      (chunkX, chunkZ) => this.environment.invalidateTerrainColumn(chunkX, chunkZ),
    );
    this.meshCount = 0;
    this.quadCount = 0;
    this.translucentMeshes = new Set();
    this.chunkUploadQueue = new LatestFrameWorkQueue((chunk) => this.setChunkMesh(chunk));
    this.translucentSortScheduler = new TranslucentSortScheduler({
      positionFor: (mesh) => mesh.position,
      maximumDistance: this.edge * 3.5,
    });
    this.released = false;
    this.resizeObserver = new ResizeObserver(() => engine.resize());
    lifetime.defer(() => this.resizeObserver.disconnect());
    this.resizeObserver.observe(canvas);
    this.render = () => {
      const deltaMs = Math.min(engine.getDeltaTime(), 100);
      navigation.update(deltaMs);
      this.weatherColumnInvalidations.advance(deltaMs);
      this.chunkUploadQueue.drainOne();
      this.weatherColumnInvalidations.flushReady();
      this.sortNextTranslucentMesh(deltaMs);
      this.materialLibrary.update(deltaMs);
      environment.update(
        deltaMs,
        this.camera.globalPosition,
        null,
        this.weatherGroundAt,
      );
      scene.render();
    };
    lifetime.defer(() => engine.stopRenderLoop(this.render));
    engine.runRenderLoop(this.render);
    surfaces.add(this);
  }

  requireLive() {
    if (!surfaces.has(this) || this.released) throw new Error("Voxel surface is released");
  }

  sortNextTranslucentMesh(deltaMs) {
    const position = this.camera.globalPosition;
    const mesh = this.translucentSortScheduler.next(position, deltaMs);
    if (mesh === null) return;
    // Babylon 接收世界空间参考点，并在 updateFacetData 内部通过逆世界
    // 矩阵转换到 Mesh 局部空间；这里不能再次减去 Chunk 原点。
    mesh.facetDepthSortFrom = position;
    mesh.updateFacetData();
  }

  addTerrainMesh(mesh, columnKey) {
    this.terrainMeshes.add(mesh);
    let meshes = this.terrainColumns.get(columnKey);
    if (meshes === undefined) {
      meshes = new Set();
      this.terrainColumns.set(columnKey, meshes);
    }
    meshes.add(mesh);
  }

  removeTerrainMesh(mesh, columnKey) {
    this.terrainMeshes.delete(mesh);
    const meshes = this.terrainColumns.get(columnKey);
    if (meshes === undefined) return;
    meshes.delete(mesh);
    if (meshes.size === 0) this.terrainColumns.delete(columnKey);
  }

  invalidateTerrainColumn(chunkX, chunkZ) {
    this.terrainGroundProbe.invalidateColumn(chunkX, chunkZ);
    this.weatherColumnInvalidations.invalidate(chunkX, chunkZ);
  }

  disposeChunk(key, invalidate = true) {
    const current = this.chunks.get(key);
    if (current === undefined) return;
    for (const mesh of current.meshes) {
      this.removeTerrainMesh(mesh, current.columnKey);
      this.translucentMeshes.delete(mesh);
      this.translucentSortScheduler.delete(mesh);
      this.environment.removeShadowCaster(mesh);
      mesh.dispose(false, false);
    }
    this.meshCount -= current.meshes.length;
    this.quadCount -= current.quads;
    this.chunks.delete(key);
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
        const material = this.materialLibrary.materialFor(batch);
        const mesh = new Mesh("chunk:" + validated.key + ":" + index, this.scene);
        meshes.push(mesh);
        const data = new VertexData();
        data.positions = positions;
        data.normals = normals;
        data.uvs = uvs;
        data.colors = colors;
        data.indices = indices;
        // Babylon 只会在 Mesh 之间排序透明对象。水面和侧壁在一个 Chunk
        // 内仍需按三角形从远到近排序，因此透明索引缓冲必须保持可更新。
        data.applyToMesh(mesh, batch.layer === "translucent");
        mesh.setVerticesData("textureLayer", textureLayers, false, 1);
        mesh.setVerticesData("tintRole", tintRoles, false, 1);
        mesh.hasClimateTint = tintRoles.some((role) => role !== 0);
        mesh.precipitationSurface = this.materialLibrary.materialDefinitions.get(batch.materialKey).precipitationSurface;
        mesh.material = material;
        mesh.position.set(validated.x * this.edge, validated.y * this.edge, validated.z * this.edge);
        mesh.useVertexColors = true;
        mesh.hasVertexAlpha = false;
        mesh.isPickable = false;
        mesh.checkCollisions = batch.layer === "opaque";
        mesh.receiveShadows = batch.layer !== "translucent";
        // 透明地形在天体和云层之后绘制，但通过组间保留深度继续
        // 受不透明地形遮挡。
        mesh.renderingGroupId = batch.layer === "translucent" ? 2 : 0;
        mesh.freezeWorldMatrix();
        if (batch.layer === "translucent") {
          mesh.mustDepthSortFacets = true;
          this.translucentMeshes.add(mesh);
          this.translucentSortScheduler.add(mesh);
        } else {
          const definition = this.materialLibrary.materialDefinitions.get(batch.materialKey);
          if (definition === undefined) throw new Error("Unknown voxel material " + batch.materialKey);
          if (definition.castsShadows) this.environment.addShadowCaster(mesh);
        }
      }
      // Keep the previous visible Chunk until the complete replacement has
      // passed validation and every new mesh has reached GPU staging.
      this.disposeChunk(validated.key, false);
      this.meshCount += meshes.length;
      this.quadCount += validated.quads;
      for (const mesh of meshes) this.addTerrainMesh(mesh, columnKey);
      this.chunks.set(validated.key, {meshes, quads: validated.quads, columnKey, columnX: validated.x, columnZ: validated.z});
      this.invalidateTerrainColumn(validated.x, validated.z);
    } catch (error) {
      for (const mesh of meshes) {
        this.removeTerrainMesh(mesh, columnKey);
        this.translucentMeshes.delete(mesh);
        this.translucentSortScheduler.delete(mesh);
        this.environment.removeShadowCaster(mesh);
        mesh.dispose(false, false);
      }
      throw error;
    }
  }

  enqueueChunkMesh(chunk) {
    this.requireLive();
    const position = chunk?.position;
    const x = requireInteger(position?.x, -33_554_431, 33_554_431, "Chunk x");
    const y = requireInteger(position?.y, -33_554_431, 33_554_431, "Chunk y");
    const z = requireInteger(position?.z, -33_554_431, 33_554_431, "Chunk z");
    return this.chunkUploadQueue.enqueue(chunkKey(x, y, z), chunk);
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
    return this.environment.stats();
  }

  setEnvironmentFrame(frame) {
    this.requireLive();
    this.environment.applyFrame(frame);
    this.climateTintField.setTime(frame.worldMilliseconds);
  }

  release() {
    if (!surfaces.has(this) || this.released) return;
    this.released = true;
    this.engine.stopRenderLoop(this.render);
    this.chunkUploadQueue.clear();
    try {
      for (const key of [...this.chunks.keys()]) this.disposeChunk(key);
    } finally {
      this.chunks.clear();
      this.meshCount = 0;
      this.quadCount = 0;
      this.translucentMeshes.clear();
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
    const engine = new Engine(canvas, true, {preserveDrawingBuffer: false, stencil: true, antialias: true}, true);
    lifetime.defer(() => engine.dispose());
    if (engine.webGLVersion < 2) throw new Error("Voxel rendering requires WebGL 2 texture arrays");
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
    scene.imageProcessingConfiguration.exposure = 0.84;
    scene.imageProcessingConfiguration.contrast = 1.06;
    scene.fogMode = Scene.FOGMODE_LINEAR;
    const target = new Vector3(options.targetX, options.targetY, options.targetZ);
    const camera = createNavigationCamera(scene, canvas, options, target, edge, horizontalChunkRadius, renderDistance);
    const textureBanks = new Map();
    for (const definition of textureBankDefinitions) {
      const bank = loadTextureBank(scene, definition, maximumTextureArrayLayers);
      textureBanks.set(bank.key, bank);
      lifetime.defer(() => {
        for (const texture of [bank.albedo, bank.normal, bank.material, bank.emissive]) texture.dispose();
        textureBanks.delete(bank.key);
      });
    }
    const environment = await dependencies.createEnvironment(scene, edge, renderDistance, options.environmentResources, options.environmentFrame);
    lifetime.defer(() => environment.dispose());
    const navigation = createNavigation(canvas, options, camera, dependencies);
    lifetime.defer(() => navigation.release());
    const contextRestoreObserver = engine.onContextRestoredObservable.add(() => {
      for (const bank of textureBanks.values()) bank.restore();
      environment.restore();
    });
    lifetime.defer(() => engine.onContextRestoredObservable.remove(contextRestoreObserver));
    return new BabylonVoxelSurface(canvas, options, engine, scene, camera, navigation, textureBanks, environment, lifetime);
  } catch (error) {
    try {
      lifetime.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Voxel surface initialization failed", {cause: error});
    }
    throw error;
  }
}
