import {Vector2} from "@babylonjs/core/Maths/math.vector.js";
import {Texture} from "@babylonjs/core/Materials/Textures/texture.js";
import {Mesh} from "@babylonjs/core/Meshes/mesh.js";
import {VertexBuffer} from "@babylonjs/core/Buffers/buffer.js";
import {VertexData} from "@babylonjs/core/Meshes/mesh.vertexData.js";
import {createEnvironmentSpriteMaterial} from "./environment-sprite-material.mjs";

const cloudGridSize = 7;
const cloudGridCenter = 3;
const cloudRingRadii = Object.freeze([0, 0.8, 0.95, 1]);
const cloudRingBrightness = Object.freeze([0.75, 0.66]);

export const cloudTextureRepeat = 1.75;
export const cloudWindIntegrationLimitMilliseconds = 5_000;
const cloudDimensions = Object.freeze({
  horizontalRadius: 1_900,
  zenithHeight: 600,
  horizonHeight: 60,
  textureWorldPeriod: 1_900 / cloudTextureRepeat,
});

function requireFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(label + " must be a finite number");
  }
  return value;
}

function requireUnit(value, label) {
  value = requireFinite(value, label);
  if (value < 0 || value > 1) throw new RangeError(label + " must be from 0 through 1");
  return value;
}

function fractional(value) {
  return value - Math.floor(value);
}

function wrappedCloudDisplacement(value) {
  return value % cloudDimensions.textureWorldPeriod;
}

/** World-space dome scale and texture frequency are independent of terrain LOD. */
export function cloudLayerDimensions() {
  return cloudDimensions;
}

/**
 * Four radial bands carry the authored cloud texture toward the horizon.
 * UVs come from XZ positions, not grid indices: nonlinear ring spacing must
 * never stretch one texture tile across each long triangle.
 */
export function cloudLayerGeometry() {
  const dimensions = cloudLayerDimensions();
  const positions = [];
  const normals = [];
  const uvs = [];
  const ringIndices = [];
  const indices = [];

  for (let gridZ = 0; gridZ < cloudGridSize; gridZ += 1) {
    for (let gridX = 0; gridX < cloudGridSize; gridX += 1) {
      const offsetX = gridX - cloudGridCenter;
      const offsetZ = gridZ - cloudGridCenter;
      const ringIndex = Math.max(Math.abs(offsetX), Math.abs(offsetZ));
      const radius = cloudRingRadii[ringIndex];
      const radialScale = ringIndex > 0 ? radius / Math.hypot(offsetX, offsetZ) : 0;
      const worldX = offsetX * radialScale * dimensions.horizontalRadius;
      const worldZ = offsetZ * radialScale * dimensions.horizontalRadius;
      const worldY = mix(dimensions.zenithHeight, dimensions.horizonHeight, radius * radius);
      positions.push(worldX, worldY, worldZ);
      normals.push(0, -1, 0);
      // Images upload with invertY=true; compensate authored top-first V.
      uvs.push(worldX / dimensions.textureWorldPeriod, -worldZ / dimensions.textureWorldPeriod);
      ringIndices.push(ringIndex);
    }
  }

  for (let gridZ = 1; gridZ < cloudGridSize; gridZ += 1) {
    for (let gridX = 1; gridX < cloudGridSize; gridX += 1) {
      const current = gridZ * cloudGridSize + gridX;
      const left = current - 1;
      const upperLeft = left - cloudGridSize;
      const upper = current - cloudGridSize;
      const x = gridX - cloudGridCenter;
      const z = gridZ - cloudGridCenter;
      if ((x <= 0 && z <= 0) || (x > 0 && z > 0)) {
        indices.push(current, left, upperLeft, upperLeft, upper, current);
      } else {
        indices.push(current, left, upper, left, upperLeft, upper);
      }
    }
  }

  return {
    ...dimensions,
    positions,
    normals,
    uvs,
    ringIndices,
    indices,
  };
}

function mix(left, right, amount) {
  return left + (right - left) * amount;
}

/**
 * Wind displacement advances only between adjacent authoritative samples.
 * Duplicate samples are idempotent; clock corrections and long gaps replace
 * the anchor without integrating an unbounded distance.
 */
export function advanceCloudWind(state, worldMilliseconds, windX, windZ) {
  worldMilliseconds = requireFinite(worldMilliseconds, "Cloud wind world milliseconds");
  windX = requireFinite(windX, "Cloud wind x");
  windZ = requireFinite(windZ, "Cloud wind z");
  if (worldMilliseconds < 0) throw new RangeError("Cloud wind world milliseconds cannot be negative");
  if (state === null) {
    return {worldMilliseconds, windX, windZ, displacementX: 0, displacementZ: 0};
  }
  if (typeof state !== "object") throw new TypeError("Cloud wind state must be a record or null");
  const previousWorldMilliseconds = requireFinite(state.worldMilliseconds, "Previous cloud wind world milliseconds");
  const previousWindX = requireFinite(state.windX, "Previous cloud wind x");
  const previousWindZ = requireFinite(state.windZ, "Previous cloud wind z");
  let displacementX = requireFinite(state.displacementX, "Cloud wind displacement x");
  let displacementZ = requireFinite(state.displacementZ, "Cloud wind displacement z");
  const elapsedMilliseconds = worldMilliseconds - previousWorldMilliseconds;
  if (elapsedMilliseconds === 0 && windX === previousWindX && windZ === previousWindZ) return state;
  if (elapsedMilliseconds > 0 && elapsedMilliseconds <= cloudWindIntegrationLimitMilliseconds) {
    const halfSeconds = elapsedMilliseconds / 2_000;
    displacementX = wrappedCloudDisplacement(displacementX + (previousWindX + windX) * halfSeconds);
    displacementZ = wrappedCloudDisplacement(displacementZ + (previousWindZ + windZ) * halfSeconds);
  }
  return {worldMilliseconds, windX, windZ, displacementX, displacementZ};
}

/** Render-time extrapolation is pure, bounded, and never mutates the anchor. */
export function cloudWindDisplacementAt(state, worldMilliseconds) {
  worldMilliseconds = requireFinite(worldMilliseconds, "Cloud wind render world milliseconds");
  if (worldMilliseconds < 0) throw new RangeError("Cloud wind render world milliseconds cannot be negative");
  if (state === null) return {x: 0, z: 0};
  if (typeof state !== "object") throw new TypeError("Cloud wind state must be a record or null");
  const anchorMilliseconds = requireFinite(state.worldMilliseconds, "Cloud wind anchor world milliseconds");
  const windX = requireFinite(state.windX, "Cloud wind anchor x");
  const windZ = requireFinite(state.windZ, "Cloud wind anchor z");
  const displacementX = requireFinite(state.displacementX, "Cloud wind anchor displacement x");
  const displacementZ = requireFinite(state.displacementZ, "Cloud wind anchor displacement z");
  const elapsedMilliseconds = worldMilliseconds - anchorMilliseconds;
  if (elapsedMilliseconds <= 0 || elapsedMilliseconds > cloudWindIntegrationLimitMilliseconds) {
    return {x: displacementX, z: displacementZ};
  }
  const seconds = elapsedMilliseconds / 1_000;
  return {
    x: wrappedCloudDisplacement(displacementX + windX * seconds),
    z: wrappedCloudDisplacement(displacementZ + windZ * seconds),
  };
}

/**
 * Vertex RGBA is premultiplied too: cloud light/fade scales RGB and alpha,
 * and the transparent outer edge must be transparent black, not fog RGB.
 */
export function cloudVertexColors(ringIndices, cloudBrightness, cloudOpacity, fogColor, fogBlend = 0) {
  if (!Array.isArray(ringIndices)) throw new TypeError("Cloud ring indices must be an array");
  cloudBrightness = requireUnit(cloudBrightness, "Cloud brightness");
  cloudOpacity = requireUnit(cloudOpacity, "Cloud opacity");
  fogBlend = requireUnit(fogBlend, "Cloud fog blend");
  if (typeof fogColor !== "object" || fogColor === null) throw new TypeError("Cloud fog color must be a color");
  const fogRed = requireUnit(fogColor.r, "Cloud fog red");
  const fogGreen = requireUnit(fogColor.g, "Cloud fog green");
  const fogBlue = requireUnit(fogColor.b, "Cloud fog blue");
  const colors = [];
  for (const ringIndex of ringIndices) {
    if (!Number.isSafeInteger(ringIndex) || ringIndex < 0 || ringIndex > 3) {
      throw new RangeError("Cloud ring index must be from 0 through 3");
    }
    if (ringIndex <= 1) {
      const cloud = cloudBrightness * cloudRingBrightness[ringIndex];
      colors.push(
        mix(cloud, fogRed, fogBlend) * cloudOpacity,
        mix(cloud, fogGreen, fogBlend) * cloudOpacity,
        mix(cloud, fogBlue, fogBlend) * cloudOpacity,
        mix(cloud, 1, fogBlend) * cloudOpacity,
      );
    } else {
      const opacity = ringIndex === 2 ? cloudOpacity : 0;
      colors.push(fogRed * opacity, fogGreen * opacity, fogBlue * opacity, opacity);
    }
  }
  return colors;
}

/**
 * UV phase is derived from world coordinates and authoritative world time.
 * Reapplying the same frame therefore cannot introduce delta-time drift.
 */
export function cloudTextureOffset(center, worldMilliseconds, windState = null) {
  if (typeof center !== "object" || center === null) throw new TypeError("Cloud center must be a position");
  const centerX = requireFinite(center.x, "Cloud center x");
  const centerZ = requireFinite(center.z, "Cloud center z");
  worldMilliseconds = requireFinite(worldMilliseconds, "Cloud world milliseconds");
  if (worldMilliseconds < 0) throw new RangeError("Cloud world milliseconds cannot be negative");
  const {textureWorldPeriod} = cloudLayerDimensions();
  const seconds = worldMilliseconds / 1_000;
  const wind = cloudWindDisplacementAt(windState, worldMilliseconds);
  return {
    u: fractional(centerX / textureWorldPeriod - 0.002 * seconds - wind.x / textureWorldPeriod),
    v: fractional(-centerZ / textureWorldPeriod + 0.002 * seconds + wind.z / textureWorldPeriod),
  };
}

export function createCloudLayer(scene, texture, alphaIndex) {
  const geometry = cloudLayerGeometry();
  texture.name = "openvoxel-clouds";
  texture.hasAlpha = true;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.updateSamplingMode(Texture.BILINEAR_SAMPLINGMODE);

  const mesh = new Mesh("openvoxel-cloud-layer", scene);
  const data = new VertexData();
  data.positions = geometry.positions;
  data.normals = geometry.normals;
  data.uvs = geometry.uvs;
  data.colors = cloudVertexColors(geometry.ringIndices, 1, 0, {r: 0, g: 0, b: 0});
  data.indices = geometry.indices;
  data.hasVertexAlpha = true;
  data.applyToMesh(mesh, true);

  const material = createEnvironmentSpriteMaterial(scene, "openvoxel-cloud-material", texture, {vertexColors: true});
  const uvOffset = Vector2.Zero();
  let windState = null;

  mesh.material = material;
  mesh.useVertexColors = true;
  mesh.hasVertexAlpha = true;
  mesh.isPickable = false;
  mesh.applyFog = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 1;
  mesh.alphaIndex = alphaIndex;

  return {
    mesh,
    material,
    texture,
    geometry,
    applyFrame(frame) {
      windState = advanceCloudWind(windState, frame.worldMilliseconds, frame.windX, frame.windZ);
      mesh.updateVerticesData(VertexBuffer.ColorKind, cloudVertexColors(
        geometry.ringIndices,
        frame.cloudBrightness,
        frame.cloudOpacity,
        frame.fog,
      ));
    },
    update(center, worldMilliseconds) {
      mesh.position.set(center.x, 0, center.z);
      const offset = cloudTextureOffset(center, worldMilliseconds, windState);
      uvOffset.set(offset.u, offset.v);
      material.setVector2("ovUvOffset", uvOffset);
    },
  };
}
