import assert from "node:assert/strict";
import test from "node:test";
import {Observable} from "@babylonjs/core/Misc/observable.js";
import {VoxelLightingTextures, VoxelLightingPlugin} from "../src/backends/babylon/native/voxel-lighting.mjs";

const position = x => ({x, y: 0, z: 0});
const data = value => new Uint8Array(18 ** 3 * 4).fill(value);
const update = (field, x, value) => field.apply({removed: [], sources: [], chunks: [{position: position(x), edge: 16, data: data(value)}]});
const retire = (field, x) => field.apply({removed: [position(x)], sources: [], chunks: []});
const mesh = (field, x) => {
  const mesh = {position: position(x * 16), onDisposeObservable: new Observable()};
  field.attach(mesh, `${x}:0:0`);
  mesh.dispose = () => mesh.onDisposeObservable.notifyObservers();
  return mesh;
};

function fixture() {
  const field = new VoxelLightingTextures(null, 16), created = [];
  field.texture = (bytes, size, name) => {
    const texture = {bytes, size, name, writes: 1, disposed: false, internal: {}};
    texture.update = bytes => { assert.equal(texture.disposed, false); texture.bytes = bytes; texture.writes++; };
    texture.getInternalTexture = () => texture.internal;
    texture.dispose = () => { assert.equal(texture.disposed, false, "texture disposed twice"); texture.disposed = true; };
    created.push(texture);
    return texture;
  };
  return {field, created};
}

test("offscreen light updates coalesce and all passes see the latest data on the first draw", () => {
  const {field, created} = fixture();
  const owner = mesh(field, 0);
  update(field, 0, 10); update(field, 0, 20);
  assert.equal(created.length, 0);
  const texture = field.forMesh(owner);
  assert.equal(texture.bytes[0], 20);
  update(field, 0, 30); update(field, 0, 40);
  assert.equal(texture.writes, 1);
  assert.equal(field.forMesh(owner), texture);
  assert.equal(texture.bytes[0], 40);
  for (let i = 0; i < 5; i++) field.forMesh(owner);
  assert.equal(texture.writes, 2);
  field.dispose();
  assert.ok(created.every(texture => texture.disposed));
});

test("retired lighting belongs to every old mesh until the last owner releases it", () => {
  const {field} = fixture();
  update(field, 0, 10);
  const old = mesh(field, 0), replacement = mesh(field, 0);
  const texture = field.forMesh(old);
  retire(field, 0);
  old.dispose();
  assert.equal(field.spareTextures.length, 0);
  assert.equal(field.forMesh(replacement), texture);
  assert.equal(texture.bytes[0], 10);
  replacement.dispose();
  assert.equal(field.chunks.has("0:0:0"), false);
  assert.equal(field.spareTextures.length, 1);
  update(field, 1, 70);
  assert.equal(field.forMesh(mesh(field, 1)), texture);
  assert.equal(texture.bytes[0], 70, "reused volume must not show the previous chunk's light");
  assert.equal(field.spareTextures.length, 0);
  field.dispose();
});

test("reactivating a retired chunk cancels collection and the texture pool stays bounded", () => {
  const {field, created} = fixture();
  const owners = [];
  for (let x = 0; x < 70; x++) {
    update(field, x, x);
    const owner = mesh(field, x);
    field.forMesh(owner); owners.push(owner);
  }
  retire(field, 0); update(field, 0, 90); owners[0].dispose();
  assert.equal(field.chunks.get("0:0:0").retired, false);
  for (let x = 0; x < 70; x++) {
    retire(field, x);
    if (x > 0) owners[x].dispose();
  }
  assert.equal(field.spareTextures.length, 64);
  assert.equal(created.filter(texture => texture.disposed).length, 6);
  field.dispose(); field.dispose();
  assert.ok(created.every(texture => texture.disposed));
});

test("missing lighting is dark after activation and malformed volumes cannot upload", () => {
  const {field, created} = fixture();
  const owner = mesh(field, 0);
  assert.deepEqual([...field.forMesh(owner).bytes], [255, 255, 0, 0]);
  field.apply({removed: [], sources: [], chunks: []});
  assert.deepEqual([...field.forMesh(owner).bytes], [0, 0, 0, 255]);
  assert.throws(() => field.apply({removed: [], chunks: [{position: position(0), edge: 16, data: new Uint8Array(1)}]}), /wrong volume/);
  assert.equal(created.length, 2);
  field.dispose();
  assert.ok(created.every(texture => texture.disposed));
});

test("WebGPU retains stable texture bindings while replacements, pass caches and WebGL rebind correctly", () => {
  const {field} = fixture();
  update(field, 0, 10);
  const owner = mesh(field, 0), subMesh = {getRenderingMesh: () => owner};
  const context = {textures: {}}, engine = {isWebGPU: true, _currentMaterialContext: context};
  let binds = 0, bounds = 0;
  const buffer = {_valueCache: {},
    setTexture(name, texture) { binds++; context.textures[name] = {texture: texture.getInternalTexture()}; },
    updateFloat4() { bounds++; },
  };
  const bind = () => VoxelLightingPlugin.prototype.hardBindForSubMesh.call({field}, buffer, null, engine, subMesh);
  bind(); bind();
  update(field, 0, 30); bind();
  assert.equal(binds, 1); assert.equal(bounds, 1);
  assert.equal(field.forMesh(owner).bytes[0], 30);
  // Device restoration can replace internal resources and clears pass caches.
  field.forMesh(owner).internal = {};
  buffer._valueCache = {};
  bind();
  assert.equal(binds, 2); assert.equal(bounds, 2);
  owner.position.x++; bind(); assert.equal(bounds, 3);
  context.textures = {}; bind(); assert.equal(binds, 3);
  engine.isWebGPU = false; bind(); bind(); assert.equal(binds, 5);
  field.dispose();
});
