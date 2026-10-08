import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {
  minimapViewport, minimapTextureSize, minimapRefreshMilliseconds, minimapCaptureScale,
  minimapUvOffset, minimapVisibleMeshes, minimapCompositeFragment,
  WorldMinimapRenderer,
} from "../src/backends/babylon/native/minimap.mjs";
import {TerrainFogPlugin} from "../src/backends/babylon/native/terrain-fog.mjs";

test("minimap viewport uses the mounted HUD bounds and the bottom-left GPU origin", () => {
  const result = minimapViewport({left: 0, top: 0, width: 1000, height: 800}, {left: 780, top: 20, width: 200, height: 200});
  assert.deepEqual([result.x, result.y, result.width, result.height], [0.78, 0.725, 0.2, 0.25]);
  assert.equal(minimapViewport({width: 0, height: 0}, {width: 200, height: 200}), null);
  assert.equal(minimapTextureSize, 256);
  assert.equal(minimapRefreshMilliseconds, 500);
  assert.equal(minimapCaptureScale, 1.5);
  assert.match(minimapCompositeFragment, /distance\(vUV, vec2\(0\.5\)\).*discard/u);
  assert.match(minimapCompositeFragment, /ovMapScale.*ovMapOffset/u);
});

test("cached map pans continuously while capture remains centered", () => {
  const center = {x: 32, z: -16};
  const origin = minimapUvOffset({x: 32, z: -16}, center, 96);
  assert.equal(origin.x, 0);
  assert.equal(Math.abs(origin.y), 0);
  assert.deepEqual(minimapUvOffset({x: 40, z: -10}, center, 96), {x: 8 / 96, y: -6 / 96});
  const meshes = [
    {position: {x: -32, z: -32}},
    {position: {x: 0, z: 0}},
    {position: {x: 48, z: 48}},
    {position: {x: 96, z: 96}},
  ];
  const columns = new Map(meshes.map(mesh => [`${mesh.position.x / 16}:${mesh.position.z / 16}`, new Set([mesh])]));
  assert.deepEqual(minimapVisibleMeshes(columns, {x: 0, z: 0}, 96, 16),
    meshes.slice(0, 2), "capture keeps intersecting chunk edges and rejects distant meshes");
});

test("minimap queries only intersecting horizontal columns regardless of resident world size", () => {
  const queried = [];
  const visible = {};
  const columns = {get(key) {queried.push(key); return key === "-4:-3" ? new Set([visible]) : undefined;}};
  assert.deepEqual(minimapVisibleMeshes(columns, {x: -16, z: 0}, 96, 16), [visible]);
  assert.equal(queried.length, 36);
  assert.ok(queried.includes("-4:-3") && queried.includes("1:2"));
  assert.ok(!queried.includes("2:0"), "an exactly touching boundary is outside the capture");
});

test("minimap mesh lists invalidate on visible Chunk changes and retain the cache for distant changes", () => {
  const map = {center: {x: 0, z: 0}, captureSpan: 96, edge: 16, meshesDirty: false};
  WorldMinimapRenderer.prototype.invalidateColumn.call(map, 3, 0);
  assert.equal(map.meshesDirty, false);
  WorldMinimapRenderer.prototype.invalidateColumn.call(map, -3, 0);
  assert.equal(map.meshesDirty, true);
});

test("compass labels draw once, unchanged headings skip repaint and turns redraw only the arrow", () => {
  const calls = [];
  const context = new Proxy({}, {get: (_target, key) => (...args) => calls.push([key, ...args])});
  let forward = {x: 0, z: -1};
  const map = {context, compassHeading: null, player: {getForwardRay: () => ({direction: forward})}};
  const draw = () => WorldMinimapRenderer.prototype.drawCompass.call(map);
  draw();
  assert.equal(calls.filter(([name]) => name === "fillText").length, 4);
  calls.length = 0;
  for (let frame = 0; frame < 120; frame += 1) draw();
  assert.equal(calls.length, 0);
  forward = {x: 1, z: 0};
  draw();
  assert.deepEqual(calls.find(([name]) => name === "clearRect"), ["clearRect", 92, 92, 24, 24]);
  assert.equal(calls.filter(([name]) => name === "fillText").length, 0);
  assert.ok(calls.some(([name]) => name === "rotate"));
});

test("top-down camera bypasses terrain fog without changing the player camera policy", () => {
  const values = new Map();
  const buffer = {updateFloat4() {}, updateFloat3() {}, updateFloat: (key, value) => values.set(key, value)};
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
  assert.match(source, /this\.target\.renderList = minimapVisibleMeshes\(this\.columns/u);
  assert.match(source, /this\.target\.activeCamera = this\.camera/u);
  assert.match(source, /this\.camera\.upVector = new Vector3\(0, 0, -1\)/u);
  assert.match(source, /this\.camera\.mode = Camera\.ORTHOGRAPHIC_CAMERA/u);
  assert.doesNotMatch(source, /readPixels\(|new Engine\(|worldGenerator\(/u);
  for (const resource of ["target", "camera", "composite", "renderer"]) assert.ok(source.includes(`this.${resource}.dispose()`));
  assert.ok(source.includes("engine.setDepthWrite(previousDepthWrite)"));
  assert.ok(source.includes("engine.setAlphaMode(previousAlpha)"));
});
