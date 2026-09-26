import {MaterialPluginBase} from "@babylonjs/core/Materials/materialPluginBase.js";

// Per-mesh coverage keeps opaque depth writes and cutout ordering intact.
// The mask is fixed in screen space; only its coverage threshold changes.
export class ChunkTransitionPlugin extends MaterialPluginBase {
  constructor(material) {
    super(material, "OpenVoxelChunkTransition", 190, {}, true, false, true);
    this.registerForExtraEvents = true;
    this._enable(true);
  }

  getClassName() { return "ChunkTransitionPlugin"; }
  isCompatible(shaderLanguage) { return shaderLanguage === 0; }
  getUniforms() { return {ubo: [{name: "ovChunkCoverage", size: 1, type: "float"}]}; }

  hardBindForSubMesh(buffer, _scene, _engine, subMesh) {
    buffer.updateFloat("ovChunkCoverage", subMesh.getRenderingMesh().chunkCoverage ?? 1);
  }

  getCustomCode(shaderType) {
    if (shaderType !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: "\nuniform float ovChunkCoverage;",
      CUSTOM_FRAGMENT_MAIN_BEGIN: `
if (ovChunkCoverage < 1.0) {
  vec3 ovPixel = fract(vec3(floor(gl_FragCoord.xy).xyx) * 0.1031);
  ovPixel += dot(ovPixel, ovPixel.yzx + 33.33);
  float ovCoverageNoise = fract((ovPixel.x + ovPixel.y) * ovPixel.z);
  if (ovChunkCoverage <= ovCoverageNoise) discard;
}`,
    };
  }
}

export class ChunkTransitions {
  constructor({enterMs = 280, leaveMs = 220, maximumRetiringMeshes = 128, ready = () => true} = {}) {
    this.enterMs = enterMs;
    this.leaveMs = leaveMs;
    this.maximumRetiringMeshes = maximumRetiringMeshes;
    this.entries = new Map();
    this.retiringMeshes = 0;
    this.ready = ready;
  }

  coverage(entry) {
    const value = entry.progress * entry.progress * (3 - 2 * entry.progress);
    for (const mesh of entry.meshes) mesh.chunkCoverage = value;
  }

  finish(key, entry) {
    this.entries.delete(key);
    if (entry.dispose) {
      this.retiringMeshes -= entry.meshes.length;
      entry.dispose();
    }
  }

  show(key, meshes, initial = 0) {
    const previous = this.entries.get(key);
    const progress = previous?.progress ?? initial;
    if (previous) this.finish(key, previous);
    const entry = {meshes, progress, dispose: null};
    this.coverage(entry);
    if (progress < 1 && meshes.length > 0) this.entries.set(key, entry);
  }

  hide(key, meshes, dispose) {
    const previous = this.entries.get(key);
    if (previous?.dispose) return;
    const entry = {meshes, progress: previous?.progress ?? 1, dispose};
    this.entries.delete(key);
    if (meshes.length === 0 || entry.progress <= 0) { dispose(); return; }
    this.entries.set(key, entry);
    this.retiringMeshes += meshes.length;
    // A fast teleport may retire an entire window in one frame.
    for (const [oldKey, old] of this.entries) {
      if (this.retiringMeshes <= this.maximumRetiringMeshes) break;
      if (old.dispose) this.finish(oldKey, old);
    }
  }

  update(deltaMs) {
    for (const [key, entry] of this.entries) {
      if (!entry.dispose && !this.ready(key)) continue;
      entry.progress = entry.dispose
        ? Math.max(0, entry.progress - deltaMs / this.leaveMs)
        : Math.min(1, entry.progress + deltaMs / this.enterMs);
      this.coverage(entry);
      if (entry.dispose ? entry.progress === 0 : entry.progress === 1) this.finish(key, entry);
    }
  }

  clear() {
    for (const [key, entry] of this.entries) this.finish(key, entry);
  }
}
