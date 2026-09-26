import {
  chunkCoordinate, creativeFlightMovement, requireDirection, requirePosition, survivalWalkMovement,
} from "./navigation-contract.mjs";

const viewDirectionCosineThreshold = 0.9914448613738104;

export function createNavigationView({
  canvas, edge, movementMode, movement, readViewPosition, readViewForward, viewChanged, aimChanged,
}) {
  function viewPosition() {
    return requirePosition(readViewPosition(), "Voxel navigation view position");
  }

  function viewForward() {
    return requireDirection(readViewForward());
  }

  const initial = viewPosition();
  let centerX = chunkCoordinate(initial.x, edge);
  let centerY = chunkCoordinate(initial.y, edge);
  let centerZ = chunkCoordinate(initial.z, edge);
  let lastForward = viewForward();

  function writeViewChunkAttributes() {
    canvas.setAttribute("data-view-chunk-x", String(centerX));
    canvas.setAttribute("data-view-chunk-y", String(centerY));
    canvas.setAttribute("data-view-chunk-z", String(centerZ));
  }

  function writePlayerStateAttributes(position) {
    canvas.setAttribute("data-view-y", position.y.toFixed(6));
    canvas.setAttribute("data-player-grounded", String(movementMode === survivalWalkMovement && movement.grounded));
    canvas.setAttribute("data-player-crouching", String(movementMode === survivalWalkMovement && movement.crouching));
  }

  writePlayerStateAttributes(initial);
  writeViewChunkAttributes();

  return {
    viewPosition,
    viewForward,
    update() {
      const position = viewPosition();
      if (movementMode === creativeFlightMovement) aimChanged(position, viewForward());
      writePlayerStateAttributes(position);
      const nextX = chunkCoordinate(position.x, edge);
      const nextY = chunkCoordinate(position.y, edge);
      const nextZ = chunkCoordinate(position.z, edge);
      const centerChanged = nextX !== centerX || nextY !== centerY || nextZ !== centerZ;
      const forward = viewForward();
      const directionChanged = forward.x * lastForward.x + forward.y * lastForward.y + forward.z * lastForward.z
        <= viewDirectionCosineThreshold;
      if (!centerChanged && !directionChanged) return;
      if (centerChanged) {
        centerX = nextX;
        centerY = nextY;
        centerZ = nextZ;
        writeViewChunkAttributes();
      }
      lastForward = forward;
      viewChanged(centerX, centerY, centerZ, forward.x, forward.y, forward.z);
    },
    stats() {
      const position = viewPosition();
      return {
        viewX: position.x, viewY: position.y, viewZ: position.z,
        viewChunkX: centerX, viewChunkY: centerY, viewChunkZ: centerZ,
        forwardX: lastForward.x, forwardY: lastForward.y, forwardZ: lastForward.z,
      };
    },
  };
}
