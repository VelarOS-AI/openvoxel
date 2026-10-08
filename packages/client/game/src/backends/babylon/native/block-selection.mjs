import {CreateLineSystem} from "@babylonjs/core/Meshes/Builders/linesBuilder.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";
import {Color3} from "@babylonjs/core/Maths/math.color.js";

const edges = [[0,1],[1,3],[3,2],[2,0],[4,5],[5,7],[7,6],[6,4],[0,4],[1,5],[2,6],[3,7]];

export function selectionLines(boxes) {
  return boxes.flatMap(box => {
    const points = [];
    for (let index = 0; index < 8; index += 1) points.push(new Vector3(
      index & 1 ? box.maximumX + .003 : box.minimumX - .003,
      index & 2 ? box.maximumY + .003 : box.minimumY - .003,
      index & 4 ? box.maximumZ + .003 : box.minimumZ - .003,
    ));
    return edges.map(([from, to]) => [points[from], points[to]]);
  });
}

// One reusable, depth-tested line mesh. It never enters terrain, shadow,
// reflection or minimap mesh lists, and only changes when the target changes.
export class BlockSelectionOutline {
  constructor(scene) {
    this.scene = scene;
    this.mesh = null;
    this.lineCount = 0;
  }

  set(selection) {
    if (selection == null || selection.boxes.length === 0) {
      this.mesh?.setEnabled(false);
      return;
    }
    const lines = selectionLines(selection.boxes);
    if (this.mesh && this.lineCount !== lines.length) {
      this.mesh.dispose();
      this.mesh = null;
    }
    this.mesh = CreateLineSystem("block-selection", {lines, updatable: true, instance: this.mesh ?? undefined}, this.scene);
    this.lineCount = lines.length;
    this.mesh.color = new Color3(1, 1, 1);
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = false;
    this.mesh.applyFog = false;
    this.mesh.renderingGroupId = 3;
    this.mesh.material.disableDepthWrite = true;
    this.mesh.position.set(selection.x, selection.y, selection.z);
    this.mesh.setEnabled(true);
  }

  dispose() {
    this.mesh?.dispose();
    this.mesh = null;
  }
}
