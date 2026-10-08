import {Buffer, VertexBuffer} from "@babylonjs/core/Buffers/buffer.js";

const attributes = [["position", "positions", 3], ["normal", "normals", 3], ["uv", "uvs", 2], ["color", "colors", 4], ["textureLayer", "textureLayers", 1], ["tintRole", "tintRoles", 1]];

export function installChunkGeometry(mesh, batch) {
  // Contiguous attribute planes permit typed-array views for CPU picking and
  // collisions while reducing six GPU allocations/uploads to one per mesh.
  const data = new Float32Array(attributes.reduce((size, [, field]) => size + batch[field].length, 0));
  let offset = 0;
  for (const [, field] of attributes) {
    data.set(batch[field], offset);
    offset += batch[field].length;
  }
  const buffer = new Buffer(mesh.getEngine(), data, false, 0, false, false, false, undefined, "ChunkVertices");
  try {
    offset = 0;
    for (const [kind, field, size] of attributes) {
      mesh.setVerticesBuffer(new VertexBuffer(mesh.getEngine(), buffer, kind, {
        stride: size, offset, size, takeBufferOwnership: kind === "position",
      }), true, batch.positions.length / 3);
      offset += batch[field].length;
    }
    // The position view owns the allocation; other views don't release it
    // six times. Babylon rebuilds shared wrapper buffers once after device loss.
    mesh.setIndices(batch.indices, null, batch.batch.layer === "translucent");
  } catch (error) {
    buffer.dispose();
    throw error;
  }
}
