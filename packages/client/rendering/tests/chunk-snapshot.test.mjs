import assert from "node:assert/strict";
import test from "node:test";
import { copyChunkInterior } from "../src/native/chunk-snapshot.mjs";

test("bulk interior copy preserves all UInt32 values and leaves the full halo untouched", () => {
  for (const edge of [4, 5, 16, 31, 64]) {
    const padded = edge + 2;
    const source = Uint32Array.from({ length: edge ** 3 }, (_, i) => Math.imul(i, 2654435761));
    source[0] = 0xffffffff;
    const target = new Uint32Array(padded ** 3).fill(29);
    copyChunkInterior(target, source, edge);
    for (let y = 0; y < padded; y += 1) {
      for (let z = 0; z < padded; z += 1) {
        for (let x = 0; x < padded; x += 1) {
          const interior = x > 0 && x <= edge && y > 0 && y <= edge && z > 0 && z <= edge;
          assert.equal(target[x + padded * (z + padded * y)], interior
            ? source[x - 1 + edge * (z - 1 + edge * (y - 1))] : 29);
        }
      }
    }
    target[1 + padded * (1 + padded)] = 0;
    assert.equal(source[0], 0xffffffff);
  }
});

test("bulk interior copy rejects invalid dimensions before touching the destination", () => {
  const target = new Uint32Array(216).fill(29);
  for (const [source, edge] of [[new Uint32Array(63), 4], [new Uint32Array(64), 5],
    [new Uint32Array(64), 4.5], [new Uint32Array(27), 3], [new Uint32Array(65 ** 3), 65]]) {
    assert.throws(() => copyChunkInterior(target, source, edge), RangeError);
    assert.ok(target.every(value => value === 29));
  }
});
