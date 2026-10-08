import assert from "node:assert/strict";
import test from "node:test";
import {uploadTextureMipLevels, VoxelTextureArrayPlugin} from "../src/backends/babylon/native/texture-bank.mjs";
import {ClimateTintField} from "../src/backends/babylon/native/climate-tint.mjs";

const levels = [4, 2, 1].map(width => ({width, height: width, data: new Uint8Array(width * width * 3 * 4)}));

test("immutable bank bindings are reused per WebGPU context and rebound after restoration", () => {
  let internal = {}, calls = 0;
  const texture = {getInternalTexture: () => internal}, context = {textures: {}};
  const buffer = {setTexture(name) { calls++; context.textures[name] = {texture: internal}; }};
  const bind = target => VoxelTextureArrayPlugin.prototype.bindBankTexture.call(null, buffer, target, "albedo", texture);
  bind(context); bind(context);
  assert.equal(calls, 1);
  internal = {};
  bind(context); assert.equal(calls, 2);
  context.textures = {};
  bind(context); assert.equal(calls, 3);
  bind(null); bind(null); assert.equal(calls, 5, "WebGL retains its immediate binding path");
});

test("climate binding cache follows pass data, incremental seasons and pooled mesh ownership", () => {
  const climateField = new ClimateTintField(16, time => ({temperatureCelsius: time / 1000, humidity: 0.6, yearProgress: 0.4}));
  climateField.setTime(0);
  const plugin = {neutralSurface: false, animationLayerOffset: 0, climateField};
  let data = new Float32Array(36), uploads = 0;
  const buffer = {_valueCache: {}, getData: () => data, updateFloat() {}, updateFloat4() { uploads++; }};
  let mesh = {uniqueId: 1, position: {x: 0, y: 0, z: 0}, hasClimateTint: true};
  const bind = () => VoxelTextureArrayPlugin.prototype.hardBindForSubMesh.call(plugin, buffer, null, null, {getRenderingMesh: () => mesh});
  bind(); bind();
  assert.equal(uploads, 9);
  data = new Float32Array(36);
  buffer._valueCache = {};
  bind();
  assert.equal(uploads, 18, "another pass initializes its own buffer");
  climateField.setTime(15_000);
  climateField.update(1, 1, () => 0);
  bind(); bind();
  assert.equal(uploads, 27, "incremental season refresh invalidates bound corners");
  mesh = {uniqueId: 2, position: {x: 16, y: 0, z: 0}, hasClimateTint: true};
  bind();
  assert.equal(uploads, 36, "retired materials must bind the next chunk's climate");
  climateField.clear();
});

test("WebGPU uploads each authored array mip through its level-aware API", () => {
  const uploaded = [], views = [], internal = {_hardwareTexture: {format: "rgba8unorm", createView: value => views.push(value)}};
  const engine = {isWebGPU: true, updateTextureSamplingMode() {}};
  Object.defineProperty(engine, "_gl", {get() { throw new Error("WebGPU must not access WebGL"); }});
  uploadTextureMipLevels({getEngine: () => engine}, {
    depth: 3, getInternalTexture: () => internal, updateMipLevel: (data, level) => uploaded.push([data, level]),
  }, levels, "test");
  assert.deepEqual(uploaded, levels.map((level, i) => [level.data, i]));
  assert.equal(internal.mipLevelCount, 3);
  assert.equal(internal.generateMipMaps, false);
  assert.deepEqual(views, [{label: "test:authored-mips", format: "rgba8unorm", dimension: "2d-array",
    baseMipLevel: 0, mipLevelCount: 3, baseArrayLayer: 0, arrayLayerCount: 3, aspect: "all"}]);
});

test("WebGL explicitly allocates every array mip and always releases the binding", () => {
  const uploaded = [], bound = [], internal = {};
  const gl = {TEXTURE_2D_ARRAY: 1, RGBA8: 2, RGBA: 3, UNSIGNED_BYTE: 4,
    UNPACK_FLIP_Y_WEBGL: 5, UNPACK_ALIGNMENT: 6, pixelStorei() {},
    texImage3D: (...args) => uploaded.push(args)};
  const engine = {_gl: gl, _bindTextureDirectly: (_target, value) => bound.push(value), updateTextureSamplingMode() {}};
  const texture = {depth: 3, getInternalTexture: () => internal,
    updateMipLevel() { throw new Error("Pinned WebGL updater ignores the mip level"); }};
  uploadTextureMipLevels({getEngine: () => engine}, texture, levels, "test");
  assert.deepEqual(uploaded.map(args => [args[1], args[3], args[4], args[5]]), [[0, 4, 4, 3], [1, 2, 2, 3], [2, 1, 1, 3]]);
  assert.deepEqual(bound, [internal, null]);
  gl.texImage3D = () => { throw new Error("upload failed"); };
  assert.throws(() => uploadTextureMipLevels({getEngine: () => engine}, texture, levels, "test"), /upload failed/u);
  assert.equal(bound.at(-1), null);
});
