import assert from "node:assert/strict";
import test from "node:test";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Scene} from "@babylonjs/core/scene.js";
import {Mesh} from "@babylonjs/core/Meshes/mesh.js";
import {installChunkGeometry} from "../src/backends/babylon/native/packed-geometry.mjs";

test("terrain attributes share one allocation and retain picking data, bounds, index updates and device restoration", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mesh = new Mesh("packed", scene);
  const batch = {batch: {layer: "translucent"},
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]), colors: new Float32Array(12).fill(1),
    textureLayers: new Float32Array([3, 3, 3]), tintRoles: new Float32Array([2, 2, 2]), indices: new Uint32Array([0, 1, 2]),
  };
  installChunkGeometry(mesh, batch);
  assert.equal(mesh.getTotalVertices(), 3);
  assert.deepEqual([...mesh.getVerticesData("position")], [...batch.positions]);
  assert.deepEqual([...mesh.getVerticesData("tintRole")], [2, 2, 2]);
  assert.deepEqual(mesh.getBoundingInfo().boundingBox.maximum.asArray(), [2, 3, 0]);
  const buffers = Object.values(mesh.geometry.getVertexBuffers());
  assert.equal(new Set(buffers.map(buffer => buffer.getBuffer())).size, 1);
  const first = buffers[0].getBuffer();
  mesh.geometry._rebuild();
  assert.notEqual(buffers[0].getBuffer(), first);
  assert.equal(new Set(buffers.map(buffer => buffer.getBuffer())).size, 1);
  mesh.updateIndices(new Uint32Array([2, 1, 0]));
  assert.deepEqual([...mesh.getIndices()], [2, 1, 0]);
  assert.deepEqual([...mesh.getVerticesData("uv")], [...batch.uvs]);
  mesh.dispose();
  engine.dispose();
});
