import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {minimapViewport, minimapTextureSize, minimapRefreshMilliseconds, minimapCompositeFragment} from "../src/backends/babylon/native/minimap.mjs";
import {TerrainFogPlugin} from "../src/backends/babylon/native/terrain-fog.mjs";

test("minimap viewport uses the mounted HUD bounds and the bottom-left GPU origin", () => {
  const result = minimapViewport({left: 0, top: 0, width: 1000, height: 800}, {left: 780, top: 20, width: 200, height: 200});
  assert.deepEqual([result.x, result.y, result.width, result.height], [0.78, 0.725, 0.2, 0.25]);
  assert.equal(minimapViewport({width: 0, height: 0}, {width: 200, height: 200}), null);
  assert.equal(minimapTextureSize, 256);
  assert.equal(minimapRefreshMilliseconds, 200);
  assert.match(minimapCompositeFragment, /distance\(vUV, vec2\(0\.5\)\).*discard/u);
});

test("top-down camera bypasses terrain fog without changing the player camera policy", () => {
  const values = new Map();
  const buffer = {updateFloat3() {}, updateFloat: (key, value) => values.set(key, value)};
  const color = {r: 0, g: 0, b: 0};
  const owner = {atmosphere: {skyTop: color, horizon: color, ground: color, flash: 0}, scene: {activeCamera: {metadata: {openVoxelMinimap: true}}}};
  TerrainFogPlugin.prototype.bindForSubMesh.call(owner, buffer);
  assert.equal(values.get("ovTerrainFogEnabled"), 0);
  owner.scene.activeCamera = {};
  TerrainFogPlugin.prototype.bindForSubMesh.call(owner, buffer);
  assert.equal(values.get("ovTerrainFogEnabled"), 1);
});

test("minimap shares terrain geometry and restores GPU state while owning all disposable resources", async () => {
  const source = await readFile(new URL("../src/backends/babylon/native/minimap.mjs", import.meta.url), "utf8");
  assert.match(source, /this\.target\.renderList = Array\.from\(this\.meshes\)/u);
  assert.match(source, /this\.target\.activeCamera = this\.camera/u);
  assert.match(source, /this\.camera\.upVector = new Vector3\(0, 0, -1\)/u);
  assert.match(source, /this\.camera\.mode = Camera\.ORTHOGRAPHIC_CAMERA/u);
  assert.doesNotMatch(source, /readPixels\(|new Engine\(|worldGenerator\(/u);
  for (const resource of ["target", "camera", "composite", "renderer"]) assert.ok(source.includes(`this.${resource}.dispose()`));
  assert.ok(source.includes("engine.setDepthWrite(previousDepthWrite)"));
  assert.ok(source.includes("engine.setAlphaMode(previousAlpha)"));
});
