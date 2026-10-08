import assert from "node:assert/strict";
import test from "node:test";
import {MaterialDefines} from "@babylonjs/core/Materials/materialDefines.js";
import {PBRMaterialDefines} from "@babylonjs/core/Materials/PBR/pbrBaseMaterial.js";
import {MaterialDefineStrings} from "../src/backends/babylon/native/material-define-strings.mjs";

const original = MaterialDefines.prototype.toString;
function check(defines) { assert.equal(defines.toString(), original.call(defines)); }

test("PBR variants share text while live light, texture and clip defines always reach the shader", () => {
  const cache = new MaterialDefineStrings();
  const first = new PBRMaterialDefines({VOXEL_TEXTURE_ARRAY: {type: "boolean", default: true}});
  const second = new PBRMaterialDefines({VOXEL_TEXTURE_ARRAY: {type: "boolean", default: true}});
  cache.attach(first); cache.attach(second);
  check(first); check(second);
  assert.equal(cache.entries.length, 1);
  const baseline = first.toString();
  for (const [key, value] of [["SHADOW0", true], ["NUM_SAMPLES", "16"], ["CLIPPLANE", true], ["ALBEDO", true], ["VOXEL_TEXTURE_ARRAY", false]]) {
    second[key] = value;
    second.rebuild();
    second.markAsProcessed(); // Correctness does not rely on dirty notifications.
    check(second);
    assert.notEqual(second.toString(), baseline);
    assert.equal(first.toString(), baseline, "one mesh must not mutate another mesh's variant");
  }
  assert.equal(MaterialDefines.prototype.toString, original);
});

test("macro order, renamed plugin keys, value types, reset and rebuild preserve exact serialization", () => {
  const cache = new MaterialDefineStrings();
  const defines = new MaterialDefines();
  Object.assign(defines, {FLAG: true, COUNT: 0, MODE: "one", EMPTY: "", OFF: false});
  defines.rebuild(); cache.attach(defines); check(defines);
  const baseline = defines.toString();
  defines._keys.reverse(); check(defines);
  assert.notEqual(defines.toString(), baseline);
  defines._keys[defines._keys.indexOf("MODE")] = "RENAMED";
  defines.RENAMED = "one"; check(defines);
  for (const value of [false, 0, "0", true, null, undefined, -2.5, "two"]) {
    defines.COUNT = value; check(defines);
  }
  defines.reset(); check(defines);
  defines.rebuild(); check(defines);
  assert.ok(!defines._keys.includes("toString"));
});

test("variant retention stays bounded and eviction, clearing and custom serializers remain correct", () => {
  const cache = new MaterialDefineStrings(), defines = new MaterialDefines();
  defines.COUNT = 0; defines.rebuild(); cache.attach(defines);
  const first = defines.toString();
  for (let index = 1; index <= 80; index++) { defines.COUNT = index; check(defines); }
  assert.equal(cache.entries.length, 32);
  defines.COUNT = 0; assert.equal(defines.toString(), first);
  cache.clear(); assert.equal(cache.entries.length, 0); assert.equal(cache.last, null);
  check(defines);
  const custom = new MaterialDefines();
  custom.toString = () => "custom shader macros";
  cache.attach(custom); assert.equal(custom.toString(), "custom shader macros");
});
