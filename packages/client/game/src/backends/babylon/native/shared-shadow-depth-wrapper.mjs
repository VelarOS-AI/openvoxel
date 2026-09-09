import {DrawWrapper} from "@babylonjs/core/Materials/drawWrapper.js";
import {ShadowDepthWrapper} from "@babylonjs/core/Materials/shadowDepthWrapper.js";

let nextWrapperId = 0;

// Babylon 9.23 gives every SubMesh a random shader token and retains disposed
// meshes. Keep its shader injection and per-draw state, but make program identity
// follow the original Effect and make all observer/effect ownership explicit.
export class SharedShadowDepthWrapper extends ShadowDepthWrapper {
  constructor(material, scene, options) {
    super(material, scene, options);
    this.sharedWrapperId = nextWrapperId++;
    this.nextEffectId = 0;
    this.originalEffectTokens = new WeakMap();
    this.meshCleanupObservers = new Map();
    this.disposed = false;
    this.effectCleanupObserver = material.onEffectCreatedObservable.add(({subMesh}) => {
      const mesh = subMesh?.getMesh();
      if (!mesh || this.meshCleanupObservers.has(mesh)) return;
      const observer = mesh.onDisposeObservable.addOnce(() => {
        this._meshes.delete(mesh);
        this.meshCleanupObservers.delete(mesh);
      });
      this.meshCleanupObservers.set(mesh, observer);
    });
  }

  _makeEffect(subMesh, defines, generator, renderPassId) {
    if (this.disposed) return null;
    const original = this._subMeshToEffect.get(subMesh);
    if (!original || !original[0].isReady()) return null;
    const [effect, originalRenderPassId] = original;
    let entry = this._subMeshToDepthWrapper.get(subMesh, generator);
    if (!entry) {
      let token = this.originalEffectTokens.get(effect);
      if (token === undefined) {
        token = `openvoxel-shadow:${this.sharedWrapperId}:${this.nextEffectId++}`;
        this.originalEffectTokens.set(effect, token);
      }
      const mainDrawWrapper = new DrawWrapper(this._scene.getEngine());
      const originalDefines = subMesh._getDrawWrapper(originalRenderPassId)?.defines;
      mainDrawWrapper.defines = typeof originalDefines === "string" ? null : originalDefines ?? null;
      entry = {drawWrapper: [], mainDrawWrapper, depthDefines: "", token};
      entry.drawWrapper[renderPassId] = mainDrawWrapper;
      this._subMeshToDepthWrapper.set(subMesh, generator, entry);
    }
    const previous = entry.mainDrawWrapper.effect;
    const result = super._makeEffect(subMesh, defines, generator, renderPassId);
    // A generator define change replaces this entry's createEffect reference.
    if (previous && previous !== entry.mainDrawWrapper.effect) previous.dispose();
    return result;
  }

  _deleteDepthWrapperEffect(subMesh) {
    const entries = this._subMeshToDepthWrapper.mm.get(subMesh);
    if (!entries) return;
    for (const entry of entries.values()) {
      // Additional render-pass wrappers share this one acquired Effect reference.
      // Detach their pointers before disposing draw contexts, then release once.
      const effect = entry.mainDrawWrapper.effect;
      const wrappers = new Set([entry.mainDrawWrapper, ...entry.drawWrapper.filter(Boolean)]);
      for (const wrapper of wrappers) {
        wrapper.effect = null;
        wrapper.dispose(true);
      }
      effect?.dispose();
    }
    this._subMeshToDepthWrapper.mm.delete(subMesh);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._baseMaterial.onEffectCreatedObservable.remove(this.effectCleanupObserver);
    this.effectCleanupObserver = null;
    super.dispose();
    for (const [mesh, observer] of this.meshCleanupObservers) mesh.onDisposeObservable.remove(observer);
    this.meshCleanupObservers.clear();
    for (const subMesh of this._subMeshToDepthWrapper.mm.keys()) this._deleteDepthWrapperEffect(subMesh);
    this._subMeshToEffect.clear();
    this._meshes.clear();
    this.originalEffectTokens = new WeakMap();
  }
}
