export const distanceDetail = Object.freeze({
  surfaceNear: 48, surfaceFar: 80,
  plantNear: 32, plantFar: 56,
  vineNear: 48, vineFar: 72,
});

export function detailCoverage(distance, near, far) {
  const t = Math.max(0, Math.min(1, (distance - near) / (far - near)));
  return 1 - t * t * (3 - 2 * t);
}

export function meshDetailDistance(mesh, eye) {
  const box = mesh.getBoundingInfo().boundingBox;
  return Math.hypot(Math.max(box.minimumWorld.x - eye.x, 0, eye.x - box.maximumWorld.x),
    Math.max(box.minimumWorld.y - eye.y, 0, eye.y - box.maximumWorld.y) * .5,
    Math.max(box.minimumWorld.z - eye.z, 0, eye.z - box.maximumWorld.z));
}

// Only coarse small-plant visibility needs CPU work. Continuous surface detail
// and dither coverage use the main eye on the GPU in every render pass.
export class DistanceDetail {
  constructor() {
    this.meshes = new Set();
    this.age = 100;
  }
  add(mesh, materialKey) {
    mesh.distanceDetailKind = materialKey === "openvoxel:material/cross" ? "plant"
      : materialKey === "openvoxel:material/vine" ? "vine" : "surface";
    if (mesh.distanceDetailKind !== "surface") this.meshes.add(mesh);
    this.age = 100;
  }
  remove(mesh) { this.meshes.delete(mesh); }
  update(deltaMs, eye) {
    this.age += deltaMs;
    if (this.age < 100) return;
    this.age = 0;
    for (const mesh of this.meshes) {
      mesh.isVisible = meshDetailDistance(mesh, eye) < distanceDetail[mesh.distanceDetailKind + "Far"];
    }
  }
  clear() { this.meshes.clear(); }
}

export class DistanceDetailFramePlugin extends MaterialPluginBase {
  constructor(material, runtime) {
    super(material, "OpenVoxelDetailFrame", 185, {}, true, false, true);
    this.runtime = runtime;
    this._enable(true);
  }
  isCompatible(language) { return language === 0; }
  getUniforms() { return {ubo: [{name: "ovDetailEye", size: 3, type: "vec3"}], fragment: "uniform vec3 ovDetailEye;"}; }
  bindForSubMesh(buffer) { const eye = this.runtime.player; buffer.updateFloat3("ovDetailEye", eye.x, eye.y, eye.z); }
  getCustomCode(stage) { return stage === "fragment" ? {CUSTOM_FRAGMENT_DEFINITIONS: ""} : null; }
}

export class DistanceDetailPlugin extends MaterialPluginBase {
  constructor(material, materialKey) {
    super(material, "OpenVoxelDistanceDetail", 186, {}, true, false, true);
    this.near = materialKey === "openvoxel:material/cross" ? distanceDetail.plantNear : distanceDetail.vineNear;
    this.far = materialKey === "openvoxel:material/cross" ? distanceDetail.plantFar
      : materialKey === "openvoxel:material/vine" ? distanceDetail.vineFar : 0;
    this.registerForExtraEvents = true;
    this._enable(true);
  }
  isCompatible(language) { return language === 0; }
  getUniforms() { return {ubo: [
    {name: "ovDetailMinimum", size: 4, type: "vec4"}, {name: "ovDetailMaximum", size: 4, type: "vec4"},
  ], fragment: "uniform vec4 ovDetailMinimum;\nuniform vec4 ovDetailMaximum;"}; }
  hardBindForSubMesh(buffer, _scene, _engine, subMesh) {
    const mesh = subMesh.getRenderingMesh(), cache = buffer._valueCache, flag = mesh.getWorldMatrix().updateFlag;
    const previous = cache?.openVoxelDetailBounds;
    if (previous?.id === mesh.uniqueId && previous.flag === flag) return;
    const box = mesh.getBoundingInfo().boundingBox, min = box.minimumWorld, max = box.maximumWorld;
    buffer.updateFloat4("ovDetailMinimum", min.x, min.y, min.z, this.near);
    buffer.updateFloat4("ovDetailMaximum", max.x, max.y, max.z, this.far);
    if (cache) cache.openVoxelDetailBounds = {id: mesh.uniqueId, flag};
  }
  getCustomCode(stage) {
    if (stage !== "fragment") return null;
    // Compute from uniforms in the fragment stage so WGSL can prove that the
    // normal-map derivative branch is uniform across the whole draw.
    return {CUSTOM_FRAGMENT_MAIN_BEGIN: `
vec3 ovDetailDelta = max(max(ovDetailMinimum.xyz - ovDetailEye, ovDetailEye - ovDetailMaximum.xyz), vec3(0.0));
ovDetailDelta.y *= 0.5;
float ovDetailDistance = length(ovDetailDelta);
float ovFineDetail = 1.0 - smoothstep(${distanceDetail.surfaceNear.toFixed(1)}, ${distanceDetail.surfaceFar.toFixed(1)}, ovDetailDistance);
${this.far > 0 ? `
float ovDistanceCoverage = 1.0 - smoothstep(ovDetailMinimum.w, ovDetailMaximum.w, ovDetailDistance);
if (ovDistanceCoverage < 1.0) {
  vec3 ovPixel = fract(vec3(floor(gl_FragCoord.xy).xyx) * 0.1031);
  ovPixel += dot(ovPixel, ovPixel.yzx + 33.33);
  if (ovDistanceCoverage <= fract((ovPixel.x + ovPixel.y) * ovPixel.z)) discard;
}` : ""}`};
  }
}

// Babylon asks each plugin for all injection strings once per injection point.
// These recipes are immutable; sharing the result avoids repeated string/object
// allocation while normal, shadow and water-clipping variants are prepared.
export function stableShaderCode(plugin) {
  const vertex = plugin.getCustomCode("vertex", 0);
  const fragment = plugin.getCustomCode("fragment", 0);
  plugin.getCustomCode = stage => stage === "vertex" ? vertex : stage === "fragment" ? fragment : null;
  return plugin;
}
import {MaterialPluginBase} from "@babylonjs/core/Materials/materialPluginBase.js";
