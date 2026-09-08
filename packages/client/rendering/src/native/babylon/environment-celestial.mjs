import {Vector3, Vector4, Quaternion} from "@babylonjs/core/Maths/math.vector.js";
import {Texture} from "@babylonjs/core/Materials/Textures/texture.js";
import {Mesh} from "@babylonjs/core/Meshes/mesh.js";
import {VertexData} from "@babylonjs/core/Meshes/mesh.vertexData.js";
import {environmentAlphaIndices} from "./environment-effects.mjs";
import {createEnvironmentSpriteMaterial} from "./environment-sprite-material.mjs";

// Texture geometry follows SubsystemSky: these are half sizes at distance 900,
// independent of terrain view distance. The shared sky shader handles far clipping.
export const celestialDistance = 900;
export const starCount = 250;
const latitude = 35 * Math.PI / 180;
const celestialPole = new Vector3(0, Math.sin(latitude), Math.cos(latitude));
const saturate = (value) => Math.max(0, Math.min(1, value));

export function celestialPresentation(frame) {
  const clear = 1 - frame.precipitationIntensity;
  // Use the project's seasonal sun elevation, rather than imposing the
  // reference world's fixed dawn and dusk times on its astronomy.
  const twilight = saturate(1 - Math.abs(frame.sunDirection.y) / 0.25);
  const sunBlue = 1 - twilight * (95 / 255);
  const moonOpacity = (1 - frame.daylightIntensity) * clear;
  const sunTint = [clear, clear, sunBlue * clear, clear];
  const glowTint = (strength) => sunTint.map((component) => component * clear * strength);
  return {
    sunHalfSize: 90 + 70 * twilight,
    moonHalfSize: 60 + 20 * twilight,
    sunTint,
    moonTint: [moonOpacity, moonOpacity, moonOpacity, moonOpacity],
    sunGlowTint: glowTint(0.6),
    moonGlowTint: glowTint(0.2),
    starOpacity: frame.starIntensity,
  };
}

function prepareTexture(texture) {
  texture.hasAlpha = true;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.updateSamplingMode(Texture.BILINEAR_SAMPLINGMODE);
  return texture;
}

function prepareMesh(scene, name, data, material, alphaIndex) {
  const mesh = new Mesh(name, scene);
  data.applyToMesh(mesh, false);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.applyFog = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 1;
  mesh.alphaIndex = alphaIndex;
  return mesh;
}

function createBody(scene, name, texture, alphaIndex, additive = false) {
  const data = new VertexData();
  data.positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  // QueueCelestialBody uses top-first source rows. Our WebP upload flips rows,
  // so convert its V coordinate once while retaining the orbital corner order.
  data.uvs = [1, 1, 1, 0, 0, 0, 0, 1];
  data.indices = [0, 1, 2, 0, 2, 3];
  const material = createEnvironmentSpriteMaterial(scene, name + "-material", prepareTexture(texture), {additive});
  const mesh = prepareMesh(scene, name, data, material, alphaIndex);
  return {mesh, material};
}

export function celestialOrientation(lightDirection) {
  const outward = new Vector3(-lightDirection.x, -lightDirection.y, -lightDirection.z).normalize();
  let tangent = Vector3.Cross(outward, celestialPole);
  if (tangent.lengthSquared() < 0.000001) tangent = Vector3.Cross(outward, Vector3.Right());
  tangent.normalize();
  const up = Vector3.Cross(tangent, outward).normalize();
  // The authored quad's front normal points back toward the viewer. Keeping
  // this handedness also preserves the phase texture's orientation.
  return Quaternion.RotationQuaternionFromAxis(tangent, up, outward.scale(-1));
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

export function starFieldGeometry() {
  const random = seededRandom(10);
  const positions = [];
  const colors = [];
  const uvs = [];
  const indices = [];
  for (let index = 0; index < starCount; index += 1) {
    const brightness = 0.7 + random() * 0.3;
    const longitude = random() * 2 * Math.PI;
    const y = random() * 2 - 1;
    const horizontal = Math.sqrt(1 - y * y);
    const outward = new Vector3(horizontal * Math.cos(longitude), y, horizontal * Math.sin(longitude));
    const tangent = Vector3.Cross(Math.abs(y) > 0.95 ? Vector3.Right() : Vector3.Up(), outward).normalize();
    const up = Vector3.Cross(outward, tangent).normalize();
    const center = outward.scale(celestialDistance);
    const halfSize = 7.65 * brightness ** 3;
    const tint = [0.8 + random() * 0.2, 0.8, 0.8 + random() * 0.2, brightness ** 4];
    const firstVertex = positions.length / 3;
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const point = center.add(tangent.scale(x * halfSize)).add(up.scale(z * halfSize));
      positions.push(point.x, point.y, point.z);
      colors.push(...tint);
    }
    uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
    indices.push(firstVertex, firstVertex + 1, firstVertex + 2, firstVertex + 2, firstVertex + 3, firstVertex);
  }
  return {positions, colors, uvs, indices};
}

function createStars(scene, texture) {
  const data = Object.assign(new VertexData(), starFieldGeometry());
  const material = createEnvironmentSpriteMaterial(scene, "openvoxel-star-material", prepareTexture(texture), {
    additive: true,
    vertexColors: true,
  });
  const mesh = prepareMesh(scene, "openvoxel-stars", data, material, environmentAlphaIndices.stars);
  mesh.hasVertexAlpha = true;
  return {mesh, material, count: starCount};
}

export function createCelestialLayer(scene, textures) {
  const sun = createBody(scene, "openvoxel-sun", textures.sun, environmentAlphaIndices.sun);
  const moon = createBody(scene, "openvoxel-moon", textures.moons[0], environmentAlphaIndices.moon);
  const sunGlow = createBody(scene, "openvoxel-sun-glow", textures.glow, environmentAlphaIndices.sunGlow, true);
  const moonGlow = createBody(scene, "openvoxel-moon-glow", textures.glow, environmentAlphaIndices.moonGlow, true);
  const stars = createStars(scene, textures.star);
  let presentation = null;
  let currentFrame = null;
  let moonPhase = null;
  function applyBody(body, halfSize, rgba, orientation) {
    body.mesh.scaling.setAll(halfSize);
    body.mesh.rotationQuaternion = orientation;
    body.material.setVector4("ovTint", new Vector4(...rgba));
    body.mesh.isVisible = rgba[3] > 0.001;
  }
  return {
    sun, moon, sunGlow, moonGlow, stars,
    applyFrame(frame) {
      currentFrame = frame;
      presentation = celestialPresentation(frame);
      const sunOrientation = celestialOrientation(frame.sunDirection);
      const moonOrientation = celestialOrientation(frame.moonDirection);
      applyBody(sun, presentation.sunHalfSize, presentation.sunTint, sunOrientation);
      applyBody(sunGlow, presentation.sunHalfSize * 3.5, presentation.sunGlowTint, sunOrientation);
      applyBody(moon, presentation.moonHalfSize, presentation.moonTint, moonOrientation);
      applyBody(moonGlow, presentation.moonHalfSize * 3.5, presentation.moonGlowTint, moonOrientation);
      if (moonPhase !== frame.moonPhase) {
        moonPhase = frame.moonPhase;
        moon.material.setTexture("ovTexture", prepareTexture(textures.moons[moonPhase]));
      }
      stars.material.setVector4("ovTint", new Vector4(1, 1, 1, presentation.starOpacity));
      stars.mesh.isVisible = presentation.starOpacity > 0.01;
      stars.mesh.rotationQuaternion = Quaternion.RotationAxis(celestialPole, -2 * Math.PI * frame.timeOfDay);
    },
    update(center) {
      for (const [body, glow, direction] of [[sun, sunGlow, currentFrame.sunDirection], [moon, moonGlow, currentFrame.moonDirection]]) {
        body.mesh.position.set(center.x - direction.x * celestialDistance, center.y - direction.y * celestialDistance, center.z - direction.z * celestialDistance);
        glow.mesh.position.copyFrom(body.mesh.position);
      }
      stars.mesh.position.copyFrom(center);
    },
    stats() {
      return {
        sunVisible: sun.mesh.isVisible && currentFrame.sunDirection.y < 0.12,
        moonVisible: moon.mesh.isVisible && currentFrame.moonDirection.y < 0.12,
        starVisibility: presentation.starOpacity,
      };
    },
    dispose() {
      for (const body of [sun, moon, sunGlow, moonGlow, stars]) {
        body.mesh.dispose(false, false);
        body.material.dispose(false, false);
      }
    },
  };
}
