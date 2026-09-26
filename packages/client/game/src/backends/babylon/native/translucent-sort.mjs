import {Matrix, Vector3} from "@babylonjs/core/Maths/math.vector.js";

function farthestFirst(left, right) {
  return right.distanceSquared - left.distanceSquared || left.offset - right.offset;
}

// Chunk geometry and its world matrix stay fixed until the mesh is replaced.
// Cache triangle centers once; camera movement only changes their distances.
// Keep the original CPU indices for picking and only reorder the GPU buffer.
export class TranslucentMeshSorter {
  constructor(mesh, positions, indices) {
    this.mesh = mesh;
    this.indices = indices;
    this.sortedIndices = indices.slice();
    this.inverseWorld = Matrix.Invert(mesh.getWorldMatrix());
    this.localCamera = Vector3.Zero();
    this.lastX = Number.NaN;
    this.lastY = Number.NaN;
    this.lastZ = Number.NaN;
    this.triangles = [];
    for (let offset = 0; offset < indices.length; offset += 3) {
      const a = indices[offset] * 3;
      const b = indices[offset + 1] * 3;
      const c = indices[offset + 2] * 3;
      this.triangles.push({
        offset,
        x: (positions[a] + positions[b] + positions[c]) / 3,
        y: (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3,
        z: (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3,
        distanceSquared: 0,
      });
    }
  }

  sort(cameraPosition) {
    Vector3.TransformCoordinatesToRef(cameraPosition, this.inverseWorld, this.localCamera);
    const {x, y, z} = this.localCamera;
    if (x === this.lastX && y === this.lastY && z === this.lastZ) return false;
    this.lastX = x;
    this.lastY = y;
    this.lastZ = z;
    for (const triangle of this.triangles) {
      const dx = triangle.x - x;
      const dy = triangle.y - y;
      const dz = triangle.z - z;
      triangle.distanceSquared = dx * dx + dy * dy + dz * dz;
    }
    this.triangles.sort(farthestFirst);
    let changed = false;
    for (let index = 0; index < this.triangles.length; index += 1) {
      const source = this.triangles[index].offset;
      const target = index * 3;
      const a = this.indices[source];
      const b = this.indices[source + 1];
      const c = this.indices[source + 2];
      if (this.sortedIndices[target] === a && this.sortedIndices[target + 1] === b && this.sortedIndices[target + 2] === c) continue;
      changed = true;
      this.sortedIndices[target] = a;
      this.sortedIndices[target + 1] = b;
      this.sortedIndices[target + 2] = c;
    }
    if (changed) this.restore();
    return changed;
  }

  restore() {
    // Context restoration rebuilds the buffer from the original CPU indices.
    this.mesh.updateIndices(this.sortedIndices, undefined, true);
  }
}
