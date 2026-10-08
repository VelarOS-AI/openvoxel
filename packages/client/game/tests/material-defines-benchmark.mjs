import assert from "node:assert/strict";
import {performance} from "node:perf_hooks";
import {PBRMaterialDefines} from "@babylonjs/core/Materials/PBR/pbrBaseMaterial.js";
import {MaterialDefineStrings} from "../src/backends/babylon/native/material-define-strings.mjs";

const cache = new MaterialDefineStrings();
const variants = Array.from({length: 256}, (_, index) => {
  const defines = new PBRMaterialDefines();
  Object.assign(defines, {ALBEDO: true, NORMAL: true, UV1: true, LIGHT0: true,
    SHADOW0: index % 2 === 0, CLIPPLANE: index % 4 < 2, ALPHATEST: index % 8 < 4});
  defines.rebuild();
  return defines;
});
const expected = variants.map(defines => defines.toString());
function run(read) {
  let length = 0;
  for (let batch = 0; batch < 100; batch++) for (const defines of variants) length += read(defines).length;
  return length;
}
const readOriginal = defines => defines.toString();
const readCached = defines => cache.read(defines);
for (let warmup = 0; warmup < 4; warmup++) { run(readOriginal); run(readCached); }
const before = [], after = [];
for (let trial = 0; trial < 7; trial++) {
  for (const [read, times] of trial % 2 ? [[readCached, after], [readOriginal, before]] : [[readOriginal, before], [readCached, after]]) {
    const started = performance.now();
    assert.equal(run(read), expected.reduce((sum, text) => sum + text.length, 0) * 100);
    times.push(performance.now() - started);
  }
}
for (let index = 0; index < variants.length; index++) assert.equal(cache.read(variants[index]), expected[index]);
console.log(JSON.stringify({defines: variants[0]._keys.length, objects: variants.length, variants: cache.entries.length,
  iterations: 25600, trials: 7, beforeMedianMs: before.sort((a,b) => a-b)[3], afterMedianMs: after.sort((a,b) => a-b)[3]}));
