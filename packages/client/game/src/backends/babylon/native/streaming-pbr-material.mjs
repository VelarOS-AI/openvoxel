import {PBRMaterial} from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import {PassUniformBuffer} from "./pass-uniform-buffer.mjs";
import {voxelPipelineReady} from "./voxel-pipeline-warmup.mjs";
import {MeshMaterialBindings} from "./mesh-material-bindings.mjs";
import {MaterialDefineStrings} from "./material-define-strings.mjs";

const frameBindings = new WeakMap();

export class StreamingPBRMaterial extends PBRMaterial {
  _prepareEffect(mesh, renderingMesh, defines, onCompiled = null, onError = null, useInstances = null, useClipPlane = null) {
    this.defineStrings ??= new MaterialDefineStrings();
    this.defineStrings.attach(defines);
    return super._prepareEffect(mesh, renderingMesh, defines, onCompiled, onError, useInstances, useClipPlane);
  }

  attachMesh(mesh, budget) {
    this.meshBindings ??= new MeshMaterialBindings(this, budget);
    this.meshBindings.attach(mesh);
  }

  _markAllSubMeshesAsDirty(callback) {
    if (!this.meshBindings) return super._markAllSubMeshesAsDirty(callback);
    if (this.getScene().blockMaterialDirtyMechanism || this._blockDirtyMechanism) return;
    this.meshBindings.forEachDraw(wrapper => {
      if (wrapper.defines?.markAllAsDirty) callback(wrapper.defines);
    });
  }

  markDirty(force = false) {
    if (!this.meshBindings) return super.markDirty(force);
    this.meshBindings.forEachDraw(wrapper => {
      wrapper._wasPreviouslyReady = false;
      wrapper._wasPreviouslyUsingInstances = null;
      wrapper._forceRebindOnNextCall = force;
    });
    if (force) this.markAsDirty(PBRMaterial.AllDirtyFlag);
  }

  _mustRebind(scene, effect, subMesh, visibility = 1) {
    const buffer = this._uniformBuffer;
    if (!this.checkReadyOnlyOnce || !(buffer instanceof PassUniformBuffer)) {
      return super._mustRebind(scene, effect, subMesh, visibility);
    }
    const context = effect._pipelineContext;
    const renderId = scene.getRenderId(), pass = scene.getEngine().currentRenderPassId;
    const previous = frameBindings.get(context);
    // Each mesh retains its texture bindings and shares an immutable recipe.
    // Scene globals need one full PBR bind per Effect/render;
    // mesh/scene UBOs and lights still follow Babylon's unconditional GPU path.
    if (buffer.isSync && !subMesh._drawWrapper._forceRebindOnNextCall
      && buffer._valueCache.openVoxelBinding === context
      && previous?.renderId === renderId && previous.pass === pass) {
      this._callbackPluginEventBindForSubMesh(this._eventInfo);
      return false;
    }
    if (previous) { previous.renderId = renderId; previous.pass = pass; }
    else frameBindings.set(context, {renderId, pass});
    buffer._valueCache.openVoxelBinding = context;
    return true;
  }

  isReadyForSubMesh(mesh, subMesh, instances) {
    this.meshBindings?.select(mesh);
    // Frozen recipes may still acquire a local light, toggle shadows, or
    // receive a replacement texture after device restore. Honor dirty defines
    // before taking Babylon's ready-once fast path.
    const frozen = this.checkReadyOnlyOnce;
    const dirty = frozen && subMesh.materialDefines?.isDirty;
    if (dirty) this.checkReadyOnlyOnce = false;
    try {
      const ready = super.isReadyForSubMesh(mesh, subMesh, instances);
      if (dirty && ready) subMesh._drawWrapper._forceRebindOnNextCall = true;
      return ready && voxelPipelineReady(this.getScene().getEngine(), this, mesh, subMesh.effect);
    } finally {
      this.checkReadyOnlyOnce = frozen;
    }
  }

  bindForSubMesh(world, mesh, subMesh) {
    this.meshBindings?.select(mesh);
    const buffer = this._uniformBuffer;
    if (this.checkReadyOnlyOnce && buffer instanceof PassUniformBuffer) {
      buffer._checkNewFrame();
      const scene = this.getScene(), color = scene.ambientColor;
      let values = buffer._valueCache.openVoxelSceneInputs;
      if (!values) values = buffer._valueCache.openVoxelSceneInputs = [];
      if (values[0] !== color.r || values[1] !== color.g || values[2] !== color.b
        || values[3] !== scene.environmentIntensity || values[4] !== mesh.visibility) {
        values[0] = color.r; values[1] = color.g; values[2] = color.b;
        values[3] = scene.environmentIntensity; values[4] = mesh.visibility;
        buffer._needSync = true;
      }
    }
    super.bindForSubMesh(world, mesh, subMesh);
  }

  _createUniformBuffer() {
    super._createUniformBuffer();
    const engine = this.getScene().getEngine();
    if (engine.isWebGPU && this._forceGLSL) {
      this._uniformBuffer.dispose();
      this._uniformBuffer = new PassUniformBuffer(engine, this.name);
    }
  }

  dispose(...args) {
    this.defineStrings?.clear();
    this.meshBindings?.dispose();
    this.meshBindings = null;
    super.dispose(...args);
  }
}
