import assert from "node:assert/strict";
import test from "node:test";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Matrix, Vector3} from "@babylonjs/core/Maths/math.vector.js";
import {Mesh} from "@babylonjs/core/Meshes/mesh.js";
import {VertexData} from "@babylonjs/core/Meshes/mesh.vertexData.js";
import "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import {Scene} from "@babylonjs/core/scene.js";
import {TranslucentMeshSorter} from "../src/backends/babylon/native/translucent-sort.mjs";

function fixture(position) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mesh = new Mesh("translucent", scene);
  const data = VertexData.CreateBox({size: 1});
  for (const [x, y, z] of [[0, 2, 0], [3, 0, -2], [-4, 1, 5]]) {
    const box = VertexData.CreateBox({size: 2});
    box.transform(Matrix.Translation(x, y, z));
    data.merge(box);
  }
  data.indices = new Uint32Array(data.indices);
  data.applyToMesh(mesh, true);
  mesh.position.copyFrom(position);
  mesh.freezeWorldMatrix();
  return {engine, scene, mesh, positions: mesh.getVerticesData("position"), indices: mesh.getIndices()};
}

test("cached translucent sorting matches Babylon triangle order through strafing, turns and translated Chunks", () => {
  for (const origin of [Vector3.Zero(), new Vector3(-32, 64, 48), new Vector3(2_000_000, 128, -2_000_000)]) {
    const {engine, scene, mesh, positions, indices} = fixture(origin);
    try {
      const originalIndices = indices.slice();
      const normals = mesh.getVerticesData("normal").slice();
      const sorter = new TranslucentMeshSorter(mesh, positions, indices);
      let legacyIndices;
      const updateIndices = mesh.updateIndices.bind(mesh);
      mesh.updateIndices = (values, offset, gpuOnly) => {
        legacyIndices = values.slice();
        return updateIndices(values, offset, gpuOnly);
      };
      mesh.mustDepthSortFacets = true;
      for (let step = 0; step < 36; step += 1) {
        const camera = origin.add(new Vector3(Math.cos(step / 3) * 12, step % 3 === 0 ? -2 : 8, Math.sin(step / 3) * 12));
        mesh.facetDepthSortFrom = camera;
        mesh.updateFacetData();
        const expected = legacyIndices;
        sorter.sort(camera);
        assert.deepEqual(sorter.sortedIndices, expected, `triangle order at step ${step}, Chunk ${origin}`);
      }
      assert.deepEqual(mesh.getIndices(), originalIndices, "picking retains the original CPU triangle order");
      assert.deepEqual(mesh.getVerticesData("normal"), normals, "sorting preserves authored normals");
    } finally {
      scene.dispose();
      engine.dispose();
    }
  }
});

test("unchanged transparency order skips GPU uploads and context restoration reinstates the sorted buffer", () => {
  const {engine, scene, mesh, positions, indices} = fixture(new Vector3(-16, 32, 16));
  try {
    const sorter = new TranslucentMeshSorter(mesh, positions, indices);
    let uploads = 0;
    const updateIndices = mesh.updateIndices.bind(mesh);
    mesh.updateIndices = (values, offset, gpuOnly) => {
      uploads += 1;
      assert.equal(gpuOnly, true);
      return updateIndices(values, offset, gpuOnly);
    };
    const camera = new Vector3(-24, 48, 5);
    assert.equal(sorter.sort(camera), true);
    assert.equal(uploads, 1);
    for (let frame = 0; frame < 120; frame += 1) assert.equal(sorter.sort(camera), false);
    assert.equal(uploads, 1, "the same ordering should keep the existing GPU buffer");
    const order = sorter.sortedIndices.slice();
    sorter.restore();
    assert.equal(uploads, 2);
    assert.deepEqual(sorter.sortedIndices, order);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
