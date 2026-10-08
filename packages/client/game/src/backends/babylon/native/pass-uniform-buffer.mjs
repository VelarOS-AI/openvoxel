import {UniformBuffer} from "@babylonjs/core/Materials/uniformBuffer.js";

// Private Babylon 9.23 boundary. A pass keeps its own backing buffers instead
// of borrowing slot zero from whichever camera happened to render first.
// Babylon's copy-on-write within a pass is retained: an already encoded draw
// must never observe a later draw's parameters from the same submission.
export class PassUniformBuffer extends UniformBuffer {
  constructor(engine, name) {
    super(engine, undefined, false, name, false, true);
    this.passStates = new Map();
    this.activePass = undefined;
    // Entries have exactly the same lifetime as the owned pass buffers.
    // Explicit retirement avoids thousands of ephemeral weak-key relations.
    this.uploaded = new Map();
  }

  savePass() {
    if (this.activePass === undefined) return;
    const state = this.passStates.get(this.activePass);
    // Fixed slots keep the hot pass switch monomorphic instead of using
    // dynamic property lookups for each field of the saved state.
    state._buffer = this._buffer;
    state._bufferData = this._bufferData;
    state.words = this.words;
    state._buffers = this._buffers;
    state._bufferIndex = this._bufferIndex;
    state._valueCache = this._valueCache;
    state._needSync = this._needSync;
    state._currentFrameId = this._currentFrameId;
    state._bufferUpdatedLastFrame = this._bufferUpdatedLastFrame;
    state._createBufferOnWrite = this._createBufferOnWrite;
  }

  copyLayout(template) {
    // Layout is sealed before a chunk receives it. Share the name/offset tables,
    // but keep values, upload snapshots and pass resources exclusively owned.
    for (const field of ["_uniformLocations", "_uniformSizes", "_uniformArraySizes", "_uniformLocationPointer"]) this[field] = template[field];
    this._data = template._data.slice();
    this.create();
  }

  invalidateBindingCaches() {
    this.savePass();
    for (const state of this.passStates.values()) {
      state._valueCache = {};
      state._needSync = true;
    }
    this._valueCache = this.passStates.get(this.activePass)?._valueCache ?? {};
    this._needSync = true;
  }

  _checkNewFrame() {
    const pass = this._engine.currentRenderPassId;
    if (pass === this.activePass && this._currentFrameId === this._engine.frameId) return;
    if (pass !== this.activePass && this._bufferData) {
      this.savePass();
      let state = this.passStates.get(pass);
      if (state) {
        this._buffer = state._buffer;
        this._bufferData = state._bufferData;
        this.words = state.words;
        this._buffers = state._buffers;
        this._bufferIndex = state._bufferIndex;
        this._valueCache = state._valueCache;
        this._needSync = state._needSync;
        this._currentFrameId = state._currentFrameId;
        this._bufferUpdatedLastFrame = state._bufferUpdatedLastFrame;
        this._createBufferOnWrite = state._createBufferOnWrite;
      } else {
        if (this.activePass !== undefined) {
          this._bufferData = this._bufferData.slice();
          this._buffers = [];
          this._valueCache = {};
          this._currentFrameId = this._engine.frameId;
          this._bufferUpdatedLastFrame = false;
          this._needSync = true;
          this._rebuild();
        }
        state = {};
        this.passStates.set(pass, state);
      }
      this.activePass = pass;
    }
    super._checkNewFrame();
  }

  bindUniformBuffer() {
    // WebGPU owns bindings per draw context. Contents may change in place while
    // the buffer identity stays valid; new passes, COW slots, restored devices
    // and reset draw contexts must still travel through the normal binding path.
    if (this._engine.isWebGPU && this._buffer && this._currentEffect
      && this._engine._currentDrawContext?.buffers?.[this._currentEffectName] === this._buffer) return;
    super.bindUniformBuffer();
  }

  _rebuild() {
    super._rebuild();
    if (this._buffer && this.uploaded) {
      this.words = new Uint32Array(this._bufferData.buffer, this._bufferData.byteOffset, this._bufferData.length);
      this.uploaded.set(this._buffer, this.words.slice());
    }
  }

  update() {
    this._checkNewFrame();
    if (!this._buffer) this.create();
    this.bindUniformBuffer();
    if (this._needSync) {
      const data = this._bufferData;
      const words = this.words;
      let previous = this.uploaded.get(this._buffer);
      if (!previous) this.uploaded.set(this._buffer, previous = new Uint32Array(words.length));
      let first = 0, end = words.length;
      while (first < end && words[first] === previous[first]) first++;
      while (end > first && words[end - 1] === previous[end - 1]) end--;
      if (first < end) {
        // One contiguous dirty span, not one queue operation per field. Integer
        // uniforms are compared as bits, including values encoding float NaNs.
        this._engine.updateUniformBuffer(this._buffer, data.subarray(first, end), first * 4, (end - first) * 4);
        previous.set(words.subarray(first, end), first);
      }
      this._bufferUpdatedLastFrame = true;
      this._needSync = false;
    }
    this._createBufferOnWrite = true;
  }

  releasePass(pass) {
    this.savePass();
    const state = this.passStates.get(pass);
    if (!state) return;
    for (const [buffer] of state._buffers) {
      this.uploaded.delete(buffer);
      this._engine._releaseBuffer(buffer);
    }
    this.passStates.delete(pass);
    if (this.activePass === pass) {
      this.activePass = undefined;
      this._buffers = [];
      this._buffer = null;
      this._bufferIndex = -1;
      this._valueCache = {};
      this._createBufferOnWrite = false;
      this._needSync = true;
    }
  }

  _rebuildAfterContextLost() {
    this.passStates.clear();
    this.activePass = undefined;
    this.uploaded.clear();
    super._rebuildAfterContextLost();
  }

  dispose() {
    this.savePass();
    for (const [pass, state] of this.passStates) {
      if (pass !== this.activePass) for (const [buffer] of state._buffers) this._engine._releaseBuffer(buffer);
    }
    this.passStates.clear();
    this.uploaded.clear();
    this.activePass = undefined;
    super.dispose();
  }
}
