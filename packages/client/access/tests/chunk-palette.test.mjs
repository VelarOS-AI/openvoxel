import assert from "node:assert/strict";
import test from "node:test";
import {expandChunkPalette} from "../src/native/chunk-palette.mjs";

test("palette expansion preserves UInt32 values and isolates cold data from edits", () => {
  const palette = Object.freeze([0, 3, 0xffffffff, 0x80000000]);
  for (const edge of [4, 16, 64]) {
    const indices = Uint16Array.from({length: edge ** 3}, (_, i) => (i * 7) % palette.length);
    const target = new Uint32Array(indices.length);
    expandChunkPalette(target, palette, indices);
    assert.deepEqual(target, Uint32Array.from(indices, index => palette[index]));
    target[0] = 9;
    assert.equal(indices[0], 0);
    assert.equal(palette[0], 0);
  }
});

test("palette expansion rejects bad ids, dimensions and indices without numeric truncation", () => {
  const target = new Uint32Array(4).fill(7);
  for (const invalid of [-1, 2 ** 32, 1.5, NaN, Infinity]) {
    assert.throws(() => expandChunkPalette(target, [0, invalid], new Uint16Array(4)), RangeError);
    assert.deepEqual(target, new Uint32Array(4).fill(7));
  }
  assert.throws(() => expandChunkPalette(target, [], new Uint16Array(4)), RangeError);
  assert.throws(() => expandChunkPalette(target, [0, 1], new Uint16Array(3)), RangeError);
  assert.throws(() => expandChunkPalette(target, [0, 1], new Uint16Array([0, 1, 2, 0])), RangeError);
});
