import {
  firstPersonMode, requireBounds, requireFinite, requireFlightState,
  requireFunction, requireMode, requireMovementMode, requireRecord, requireSurvivalState,
} from "./navigation-contract.mjs";
import {createNavigationKeyboard} from "./navigation-keyboard.mjs";
import {createNavigationMovement} from "./navigation-movement.mjs";
import {createNavigationPointerLock} from "./navigation-pointer-lock.mjs";
import {createNavigationView} from "./navigation-view.mjs";
import {createNavigationTouch} from "./navigation-touch.mjs";

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
  let touch;
  const combinedKeys = new Set();
  let released = false;
  const clearMotion = () => {
    keyboard.clear();
    touch?.clear();
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
  touch = createNavigationTouch({
    canvas, mode, movementMode, ownsCanvas: pointer.ownsCanvas, rotateView, creativeSlot,
  });

  return {
    update(deltaMilliseconds) {
      if (released || !pointer.ownsCanvas()) return;
      touch.update();
      if (mode === firstPersonMode) {
        let keys = keyboard.keys;
        if (touch.keys.size > 0) {
          combinedKeys.clear();
          for (const key of keyboard.keys) combinedKeys.add(key);
          for (const key of touch.keys) combinedKeys.add(key);
          keys = combinedKeys;
        }
        movement.update(keys, deltaMilliseconds);
      }
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
      touch.release();
      pointer.release();
      releaseView();
    },
  };
}
