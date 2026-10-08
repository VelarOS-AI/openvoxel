import assert from "node:assert/strict";
import {performance} from "node:perf_hooks";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";
import {Mesh} from "@babylonjs/core/Meshes/mesh.js";
import {VertexData} from "@babylonjs/core/Meshes/mesh.vertexData.js";
import "@babylonjs/core/Meshes/Builders/groundBuilder.js";
import {Scene} from "@babylonjs/core/scene.js";
import {TranslucentMeshSorter} from "../src/backends/babylon/native/translucent-sort.mjs";

// Compare backend CPU sorting work on identical geometry and camera paths. NullEngine
// deliberately excludes real GPU upload time; this is not a frame-rate test.
const engine = new NullEngine();
const scene = new Scene(engine);
const cameras = Array.from({length: 120}, (_, index) => new Vector3(
  -32 + Math.cos(index / 30) * 20, 72, 48 + Math.sin(index / 30) * 20,
));

function measure(run) {
  for (const camera of cameras) run(camera);
  const samples = [];
  for (let pass = 0; pass < 5; pass += 1) {
    const start = performance.now();
    for (const camera of cameras) run(camera);
    samples.push(performance.now() - start);
  }
  return samples.sort((a, b) => a - b)[2];
}

try {
  for (const subdivisions of [16, 64]) {
    const mesh = new Mesh("sort-benchmark", scene);
    const data = VertexData.CreateGround({width: 16, height: 16, subdivisions});
    data.indices = new Uint32Array(data.indices);
    data.applyToMesh(mesh, true);
    mesh.position.set(-32, 64, 48);
    mesh.freezeWorldMatrix();
    const sorter = new TranslucentMeshSorter(mesh, mesh.getVerticesData("position"), mesh.getIndices());
    mesh.mustDepthSortFacets = true;
    let uploaded;
    const updateIndices = mesh.updateIndices.bind(mesh);
    mesh.updateIndices = (indices, offset, gpuOnly) => {
      uploaded = indices;
      return updateIndices(indices, offset, gpuOnly);
    };
    const legacyMs = measure(camera => {
      mesh.facetDepthSortFrom = camera;
      mesh.updateFacetData();
    });
    const expected = uploaded.slice();
    const cachedMs = measure(camera => sorter.sort(camera));
    assert.deepEqual(sorter.sortedIndices, expected, "the final transparency order must match");
    console.log(JSON.stringify({
      triangles: data.indices.length / 3, cameraUpdates: cameras.length, runs: 5,
      legacyMedianMs: +legacyMs.toFixed(3), cachedMedianMs: +cachedMs.toFixed(3),
      speedup: +(legacyMs / cachedMs).toFixed(2),
    }));
    mesh.dispose();
  }
} finally {
  scene.dispose();
  engine.dispose();
}
