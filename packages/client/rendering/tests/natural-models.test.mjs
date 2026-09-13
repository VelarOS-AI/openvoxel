import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {loadModelGeometry} from "../tools/model-geometry.mjs";

const dataRoot = fileURLToPath(new URL("../data/", import.meta.url));
test("owned natural models retain their original mesh topology and tile-local UVs", async () => {
  for (const [name, count] of [["cactus", 12], ["pumpkin", 58], ["starfish", 10], ["sea-urchin", 37]]) {
    const model = await loadModelGeometry(dataRoot, `models/vegetation/${name}.json`);
    assert.equal(model.triangles.length, count, name);
    for (const {vertices: v} of model.triangles) {
      const a = [v[8] - v[0], v[9] - v[1], v[10] - v[2]];
      const b = [v[16] - v[0], v[17] - v[1], v[18] - v[2]];
      const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      assert.ok(cross[0] * v[3] + cross[1] * v[4] + cross[2] * v[5] > 0, `${name} winding opposes its normal`);
    }
    if (name === "cactus") assert.equal(model.triangles.filter(t => t.face === "top").length, 4);
    if (name === "pumpkin") assert.ok(model.triangles.some(t => t.vertices[4] > 0 && t.vertices[4] < 0.95), "pumpkin retains its curved normals");
  }
});
