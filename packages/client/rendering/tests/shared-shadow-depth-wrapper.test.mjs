import assert from "node:assert/strict";
import test from "node:test";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Scene} from "@babylonjs/core/scene.js";
import {PBRMaterial} from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import {Mesh} from "@babylonjs/core/Meshes/mesh.js";
import {SubMesh} from "@babylonjs/core/Meshes/subMesh.js";
import {SharedShadowDepthWrapper} from "../src/native/babylon/shared-shadow-depth-wrapper.mjs";

function harness() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new PBRMaterial("shadow-test", scene);
  // Test native cache/refcount behavior independently of PBR shader generation;
  // the browser cutout oracle exercises Babylon's actual injection path.
  const wrapper = new SharedShadowDepthWrapper(material, scene, {doNotInjectCode: true});
  const generator = {};
  const originals = [];
  const shadowEffects = new Set();
  const shadowTokens = new Set();
  const createEffect = engine.createEffect.bind(engine);
  engine.createEffect = (source, ...options) => {
    const effect = createEffect(source, ...options);
    if (source.vertexToken?.startsWith("openvoxel-shadow:")) {
      shadowEffects.add(effect);
      shadowTokens.add(source.vertexToken);
    }
    return effect;
  };
  function original(label) {
    const effect = engine.createEffect({
      vertexSource: "attribute vec3 position; void main(void) { gl_Position = vec4(position, 1.0); }",
      fragmentSource: "precision highp float; void main(void) { gl_FragColor = vec4(1.0); }",
      vertexToken: label,
      fragmentToken: label,
    }, {attributes: ["position"], uniformsNames: [], samplers: [], defines: ""}, engine);
    originals.push(effect);
    return effect;
  }
  function add(effect, defines = ["#define SHADOW_TEST"], pass = 0) {
    const mesh = new Mesh("shadow-test-mesh", scene);
    mesh.subMeshes = [];
    const subMesh = new SubMesh(0, 0, 0, 0, 0, mesh);
    material.onEffectCreatedObservable.notifyObservers({subMesh, effect});
    assert.equal(wrapper.isReadyForSubMesh(subMesh, defines, generator, false, pass), true);
    return {mesh, subMesh, effect: wrapper.getEffect(subMesh, generator, pass).effect};
  }
  function dispose() {
    wrapper.dispose();
    for (const effect of originals) effect.dispose();
    scene.dispose();
    engine.dispose();
  }
  return {engine, scene, material, wrapper, generator, shadowEffects, shadowTokens, original, add, dispose};
}

test("homogeneous Chunk cutouts share one native Effect and release each cache reference once", () => {
  const state = harness();
  try {
    const original = state.original("shared-base");
    const entries = Array.from({length: 32}, () => state.add(original));
    assert.equal(state.shadowEffects.size, 1);
    assert.equal(state.shadowTokens.size, 1);
    const effect = entries[0].effect;
    assert.equal(effect._refCount, 32);
    // Render passes need their own draw state but must not acquire or release
    // another program reference merely because their DrawWrapper differs.
    for (const entry of entries) {
      assert.equal(state.wrapper.getEffect(entry.subMesh, state.generator, 7).effect, effect);
    }
    assert.equal(effect._refCount, 32);
    for (const [index, entry] of entries.entries()) {
      entry.mesh.dispose(false, false);
      const remaining = entries.length - index - 1;
      assert.equal(state.wrapper._meshes.size, remaining);
      assert.equal(state.wrapper._subMeshToEffect.size, remaining);
      assert.equal(state.wrapper._subMeshToDepthWrapper.mm.size, remaining);
      assert.equal(state.wrapper.meshCleanupObservers.size, remaining);
      assert.equal(effect._refCount, remaining);
      if (remaining > 0) assert.equal(effect.isReady(), true);
    }
    assert.equal(effect._isDisposed, true);
    assert.equal(state.engine._compiledEffects[effect.key], undefined);
  } finally {
    state.dispose();
  }
});

test("original Effect identity and shadow defines keep incompatible variants separate", () => {
  const state = harness();
  try {
    const first = state.add(state.original("first-base"));
    const second = state.add(state.original("second-base"));
    assert.notEqual(first.effect, second.effect);
    assert.equal(state.shadowTokens.size, 2);
    assert.equal(state.wrapper.isReadyForSubMesh(first.subMesh, ["#define SECOND_SHADOW_VARIANT"], state.generator, false, 0), true);
    const replacement = state.wrapper.getEffect(first.subMesh, state.generator, 0).effect;
    assert.notEqual(replacement, first.effect);
    assert.equal(first.effect._refCount, 0);
    assert.equal(second.effect.isReady(), true);
    assert.equal(state.shadowEffects.size, 3);
    assert.equal(state.shadowTokens.size, 2, "defines specialize an existing original-Effect token");
  } finally {
    state.dispose();
  }
});

test("wrapper disposal releases live entries, removes observers, and is idempotent", () => {
  const state = harness();
  try {
    const original = state.original("dispose-base");
    const first = state.add(original);
    const second = state.add(original);
    state.wrapper.dispose();
    state.wrapper.dispose();
    assert.equal(state.wrapper._meshes.size, 0);
    assert.equal(state.wrapper._subMeshToEffect.size, 0);
    assert.equal(state.wrapper._subMeshToDepthWrapper.mm.size, 0);
    assert.equal(state.wrapper.meshCleanupObservers.size, 0);
    assert.equal(first.effect._refCount, 0);
    assert.equal(first.effect._isDisposed, true);
    // Late material notifications and Mesh disposal must not repopulate maps
    // or double-release the shared Effect after owner teardown.
    state.material.onEffectCreatedObservable.notifyObservers({subMesh: first.subMesh, effect: original});
    first.mesh.dispose(false, false);
    second.mesh.dispose(false, false);
    assert.equal(state.wrapper._meshes.size, 0);
    assert.equal(state.wrapper._subMeshToEffect.size, 0);
    assert.equal(first.effect._refCount, 0);
  } finally {
    state.dispose();
  }
});
