import {Constants} from "@babylonjs/core/Engines/constants.js";
import {ShaderMaterial} from "@babylonjs/core/Materials/shaderMaterial.js";
import {Mesh} from "@babylonjs/core/Meshes/mesh.js";
import {VertexBuffer} from "@babylonjs/core/Buffers/buffer.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";

const vertexSource = `precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 worldViewProjection;
varying vec2 textureUv;
varying vec4 particleColor;
void main() {
  textureUv = uv;
  particleColor = color;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

const fragmentSource = `precision highp float;
uniform sampler2D weatherTexture;
varying vec2 textureUv;
varying vec4 particleColor;
void main() {
  vec4 color = texture2D(weatherTexture, textureUv) * particleColor;
  if (color.a <= 0.0) discard;
  gl_FragColor = color;
}`;

const quadCorners = Object.freeze([[-1, -1], [1, -1], [1, 1], [-1, 1]]);
const rainCorners = Object.freeze([[-1, -1], [1, -1], [0, 1]]);
const rainUvs = Object.freeze([0, 0, 1, 0, 0.5, 1]);
const fullUvs = Object.freeze([0, 0, 1, 0, 1, 1, 0, 1]);

/** Source sheet rows are top-first; uploaded WebP textures use bottom-first V. */
export function snowflakeSpriteUvs(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 15) throw new RangeError("Snowflake slot must be from 0 through 15");
  const left = (slot % 4) / 4;
  const top = 1 - Math.floor(slot / 4) / 4;
  return [left, top - 0.25, left + 0.25, top - 0.25, left + 0.25, top, left, top];
}

const snowUvs = Object.freeze(Array.from({length: 16}, (_, slot) => Object.freeze(snowflakeSpriteUvs(slot))));

/** Stable at vertical view directions, where cross(view, worldUp) degenerates. */
export function weatherBillboardAxes(forward) {
  const horizontalLength = Math.hypot(forward.x, forward.z);
  const right = horizontalLength > 0.0001
    ? {x: -forward.z / horizontalLength, y: 0, z: forward.x / horizontalLength}
    : {x: -1, y: 0, z: 0};
  const up = {
    x: -right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y,
  };
  const upLength = Math.hypot(up.x, up.y, up.z) || 1;
  up.x /= upLength;
  up.y /= upLength;
  up.z /= upLength;
  return {right, up};
}

const horizontalAxes = Object.freeze({
  right: Object.freeze({x: 1, y: 0, z: 0}),
  up: Object.freeze({x: 0, y: 0, z: 1}),
});
const verticalUp = Object.freeze({x: 0, y: 1, z: 0});

export function createWeatherSpriteBuffers(capacity, triangle = false) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Weather batch capacity must be positive");
  const vertexCount = triangle ? 3 : 4;
  const indexCount = triangle ? 3 : 6;
  const indices = new Uint16Array(capacity * indexCount);
  for (let index = 0; index < capacity; index += 1) {
    const vertex = index * vertexCount;
    indices.set(triangle ? [vertex, vertex + 1, vertex + 2] : [vertex, vertex + 1, vertex + 2, vertex + 2, vertex + 3, vertex], index * indexCount);
  }
  return {
    positions: new Float32Array(capacity * vertexCount * 3),
    uvs: new Float32Array(capacity * vertexCount * 2),
    colors: new Float32Array(capacity * vertexCount * 4),
    indices,
    capacity,
    vertexCount,
    indexCount,
  };
}

/** Write one source-sized sprite into a reused CPU/GPU batch without allocation. */
export function writeWeatherSprite(buffers, index, kind, particle, axes, light, fade) {
  if (index < 0 || index >= buffers.capacity) throw new RangeError("Weather sprite index exceeds its fixed batch");
  const triangle = kind === "rain";
  const corners = triangle ? rainCorners : quadCorners;
  const uvs = triangle ? rainUvs : kind === "snow" || kind === "snowSplash" ? snowUvs[particle.slot] : fullUvs;
  const basis = particle.horizontal ? horizontalAxes : axes;
  const up = triangle ? verticalUp : basis.up;
  const halfWidth = triangle ? 0.02 : particle.halfSize;
  const halfHeight = triangle ? 0.15 : particle.halfSize;
  const opacity = Math.max(0, Math.min(1, fade));
  for (let corner = 0; corner < corners.length; corner += 1) {
    const vertex = index * buffers.vertexCount + corner;
    const rightOffset = corners[corner][0] * halfWidth;
    const upOffset = corners[corner][1] * halfHeight;
    buffers.positions[vertex * 3] = particle.x + basis.right.x * rightOffset + up.x * upOffset;
    buffers.positions[vertex * 3 + 1] = particle.y + basis.right.y * rightOffset + up.y * upOffset;
    buffers.positions[vertex * 3 + 2] = particle.z + basis.right.z * rightOffset + up.z * upOffset;
    // Only the full-image rain impact sprite flips. Snow retains its source
    // atlas cell and orientation while falling and after contacting ground.
    buffers.uvs[vertex * 2] = kind === "rainSplash" && particle.flipX ? 1 - uvs[corner * 2] : uvs[corner * 2];
    buffers.uvs[vertex * 2 + 1] = kind === "rainSplash" && particle.flipY ? 1 - uvs[corner * 2 + 1] : uvs[corner * 2 + 1];
    buffers.colors[vertex * 4] = light * opacity;
    buffers.colors[vertex * 4 + 1] = light * opacity;
    buffers.colors[vertex * 4 + 2] = light * opacity;
    buffers.colors[vertex * 4 + 3] = opacity;
  }
}

/** Four shared batches replace individual meshes; authored RGB is premultiplied. */
export function createWeatherParticleBatch(scene, texture, kind, capacity) {
  const buffers = createWeatherSpriteBuffers(capacity, kind === "rain");
  const name = kind === "rainSplash" ? "rain-splash" : kind === "snowSplash" ? "snow-splash" : kind;
  const mesh = new Mesh("openvoxel-" + name, scene);
  const material = new ShaderMaterial("openvoxel-" + name + "-material", scene, {vertexSource, fragmentSource}, {
    attributes: ["position", "uv", "color"],
    uniforms: ["worldViewProjection"],
    samplers: ["weatherTexture"],
    needAlphaBlending: true,
  });
  material.setTexture("weatherTexture", texture);
  material.alphaMode = Constants.ALPHA_PREMULTIPLIED_PORTERDUFF;
  material.backFaceCulling = false;
  material.disableDepthWrite = kind === "rain" || kind === "snow";
  material.forceDepthWrite = !material.disableDepthWrite;
  material.fogEnabled = false;
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 3;
  mesh.alphaIndex = kind === "rainSplash" || kind === "snowSplash" ? 0 : 1;
  mesh.setVerticesData(VertexBuffer.PositionKind, buffers.positions, true);
  mesh.setVerticesData(VertexBuffer.UVKind, buffers.uvs, true);
  mesh.setVerticesData(VertexBuffer.ColorKind, buffers.colors, true);
  mesh.setIndices(buffers.indices);
  // A full-capacity submesh borrows its mesh's bounds. Shortening indexCount
  // turns it into a partial submesh, which must already own valid bounds for
  // Babylon's transparent sort. Both forms share this reused bounds object.
  const bounds = mesh.getBoundingInfo();
  mesh.subMeshes[0].setBoundingInfo(bounds);
  const minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  mesh.setEnabled(false);
  let count = 0;
  return {
    mesh,
    buffers,
    emitRate: 0,
    getActiveCount: () => count,
    reset() {
      count = 0;
      minimum.set(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
      maximum.set(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
    },
    append(particle, axes, light, fade) {
      if (count >= capacity) return false;
      writeWeatherSprite(buffers, count, kind, particle, axes, light, fade);
      const start = count * buffers.vertexCount * 3;
      for (let corner = 0; corner < buffers.vertexCount; corner += 1) {
        const index = start + corner * 3;
        minimum.x = Math.min(minimum.x, buffers.positions[index]);
        minimum.y = Math.min(minimum.y, buffers.positions[index + 1]);
        minimum.z = Math.min(minimum.z, buffers.positions[index + 2]);
        maximum.x = Math.max(maximum.x, buffers.positions[index]);
        maximum.y = Math.max(maximum.y, buffers.positions[index + 1]);
        maximum.z = Math.max(maximum.z, buffers.positions[index + 2]);
      }
      count += 1;
      return true;
    },
    upload() {
      mesh.setEnabled(count > 0);
      mesh.subMeshes[0].indexCount = count * buffers.indexCount;
      if (count === 0) return;
      bounds.reConstruct(minimum, maximum, mesh.getWorldMatrix());
      mesh.updateVerticesData(VertexBuffer.PositionKind, buffers.positions, false, false);
      mesh.updateVerticesData(VertexBuffer.UVKind, buffers.uvs, false, false);
      mesh.updateVerticesData(VertexBuffer.ColorKind, buffers.colors, false, false);
    },
    dispose() {
      mesh.dispose(false, false);
      material.dispose(false, false);
      count = 0;
    },
  };
}
