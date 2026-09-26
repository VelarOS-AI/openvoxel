import {performance} from "node:perf_hooks";
import {createVoxelLightField} from "../src/native/voxel-lighting.mjs";
const states = [
  {runtimeId: 0, opacity: 0, emission: 0, passesSkylight: true},
  {runtimeId: 1, opacity: 15, emission: 0, passesSkylight: false},
  {runtimeId: 2, opacity: 0, emission: 14, passesSkylight: true},
  {runtimeId: 3, opacity: 0, emission: 0, passesSkylight: true},
];
const chunks = [];
for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = -1; y <= 2; y++) {
  const blocks = new Uint32Array(4096);
  if (y === -1) blocks.fill(1);
  if (y === 0) for (let j = 0; j < 16; j++) for (let k = 0; k < 16; k++) {
    const height = 2 + ((x * 7 + z * 3 + j + k + 128) % 4);
    for (let h = 0; h <= height; h++) blocks[j + 16 * (k + 16 * h)] = 1;
  }
  chunks.push({position: {x, y, z}, blocks});
}
const field = createVoxelLightField(16, states);
function measure(label, inputs) {
  const start = performance.now(), result = field.solve(inputs, []);
  console.log(JSON.stringify({label, milliseconds: +(performance.now() - start).toFixed(2), residentChunks: chunks.length, uploadedChunks: result.chunks.length}));
}
measure("initial", chunks);
const center = chunks.find(c => c.position.x === 0 && c.position.y === 0 && c.position.z === 0);
for (let i = 0; i < 4; i++) {
  center.blocks[8 + 16 * (8 + 16 * 8)] = i % 2 === 0 ? 2 : 0;
  measure(i % 2 === 0 ? "place-source" : "remove-source", [center]);
}
center.blocks[8 + 16 * (8 + 16 * 8)] = 3;
measure("cosmetic-crop-change", [center]);
measure("idle", []);
