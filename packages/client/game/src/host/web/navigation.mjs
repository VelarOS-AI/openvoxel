import {
  firstPersonMode, requireBounds, requireFinite, requireFlightState,
  requireFunction, requireMode, requireMovementMode, requireRecord, requireSurvivalState,
} from "./navigation-contract.mjs";
import {createNavigationKeyboard} from "./navigation-keyboard.mjs";
import {createNavigationMovement} from "./navigation-movement.mjs";
import {createNavigationPointerLock} from "./navigation-pointer-lock.mjs";
import {createNavigationView} from "./navigation-view.mjs";

export function createNavigationAdapter(options) {
  options = requireRecord(options, "Voxel navigation options");
  const canvas = options.canvas;
  if (!(canvas instanceof globalThis.HTMLCanvasElement)) {
    throw new TypeError("Voxel navigation requires a canvas element");
  }
  const mode = requireMode(options.mode);
  const movementMode = requireMovementMode(options.movementMode);
  const edge = requireFinite(options.edge, "Voxel navigation Chunk edge");
  if (!Number.isSafeInteger(edge) || edge < 1) {
    throw new RangeError("Voxel navigation Chunk edge must be a positive integer");
  }
  const bounds = requireBounds(options.bounds);
  const initialFlightState = requireFlightState(options.initialFlightState);
  const initialWalkState = requireSurvivalState(options.initialWalkState);
  const stepFlight = requireFunction(options.stepFlight, "Voxel navigation creative flight step");
  const stepWalk = requireFunction(options.stepWalk, "Voxel navigation survival walk step");
  const collisionAt = requireFunction(options.collisionAt, "Voxel navigation collision query");
  const readViewPosition = requireFunction(options.readViewPosition, "Voxel navigation view position reader");
  const readViewForward = requireFunction(options.readViewForward, "Voxel navigation view direction reader");
  const readHorizontalBasis = requireFunction(options.readHorizontalBasis, "Voxel navigation basis reader");
  const applyFlightState = requireFunction(options.applyFlightState, "Voxel navigation flight state writer");
  const applyWalkState = requireFunction(options.applyWalkState, "Voxel navigation survival state writer");
  const rotateView = requireFunction(options.rotateView, "Voxel navigation view rotation writer");
  const releaseView = requireFunction(options.releaseView, "Voxel navigation view release");
  const viewChanged = requireFunction(options.viewChanged, "Voxel navigation viewChanged");
  const aimChanged = options.aimChanged == null ? () => null : requireFunction(options.aimChanged, "Voxel navigation aimChanged");
  const creativeAction = options.creativeAction == null ? () => null : requireFunction(options.creativeAction, "Voxel navigation creativeAction");
  const creativeSlot = options.creativeSlot == null ? () => null : requireFunction(options.creativeSlot, "Voxel navigation creativeSlot");
  const walkSound = options.walkSound == null ? () => null : requireFunction(options.walkSound, "Voxel navigation walkSound");
  if (canvas.ownerDocument.defaultView === null) {
    throw new Error("Voxel navigation canvas is not attached to a browser Window");
  }

  const movement = createNavigationMovement({
    mode, movementMode, initialFlightState, initialWalkState, stepFlight, stepWalk,
    readHorizontalBasis, applyFlightState, applyWalkState, bounds, collisionAt, walkSound,
  });
  canvas.setAttribute("data-navigation-mode", mode);
  canvas.setAttribute("data-movement-mode", movementMode);
  canvas.setAttribute("data-pointer-locked", "false");
  const view = createNavigationView({
    canvas, edge, movementMode, movement, readViewPosition, readViewForward, viewChanged, aimChanged,
  });
  let pointer;
  let released = false;
  const clearMotion = () => {
    keyboard.clear();
    movement.clearMotion();
  };
  const keyboard = createNavigationKeyboard({
    canvas, mode, movementMode,
    active: () => pointer.active(),
    ownsCanvas: () => pointer.ownsCanvas(),
    clearMotion, creativeSlot,
  });
  pointer = createNavigationPointerLock({
    canvas, mode, movementMode, clearMotion, rotateView,
    viewPosition: view.viewPosition, viewForward: view.viewForward, creativeAction,
  });

  return {
    update(deltaMilliseconds) {
      if (released || !pointer.ownsCanvas()) return;
      if (mode === firstPersonMode) movement.update(keyboard.keys, deltaMilliseconds);
      view.update();
    },
    viewPosition: view.viewPosition,
    stats() {
      return {
        navigationMode: mode,
        movementMode,
        ...view.stats(),
        pointerLocked: pointer.pointerLocked,
      };
    },
    release() {
      if (released) return;
      released = true;
      clearMotion();
      keyboard.release();
      pointer.release();
      releaseView();
    },
  };
}
