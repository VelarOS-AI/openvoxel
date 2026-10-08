import {gameSettings} from "../../settings/preferences.mjs";
import {creativeFlightMovement, firstPersonMode} from "./navigation-contract.mjs";

const navigationOwnerByCanvas = new WeakMap();
const mouseSensitivity = 0.0021;
const maximumPointerDelta = 500;

function clampPointerDelta(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-maximumPointerDelta, Math.min(maximumPointerDelta, value));
}

export function createNavigationPointerLock({
  canvas, mode, movementMode, clearMotion, rotateView, viewPosition, viewForward, creativeAction,
}) {
  const document = canvas.ownerDocument;
  const owner = {};
  navigationOwnerByCanvas.set(canvas, owner);
  let released = false;
  let pointerLocked = false;
  let pointerLockRequest = null;

  function ownsCanvas() {
    return navigationOwnerByCanvas.get(canvas) === owner;
  }

  function detachPointerLockLifecycle() {
    document.removeEventListener("pointerlockchange", synchronizePointerLock);
    document.removeEventListener("pointerlockerror", pointerLockError);
  }

  function finishReleasedPointerLockLifecycle() {
    if (!released) return;
    if (!ownsCanvas()) {
      detachPointerLockLifecycle();
      return;
    }
    if (pointerLockRequest !== null || document.pointerLockElement === canvas) return;
    detachPointerLockLifecycle();
    navigationOwnerByCanvas.delete(canvas);
  }

  function active() {
    return pointerLocked
      || (typeof canvas.requestPointerLock !== "function" && document.activeElement === canvas);
  }

  function exitPointerLockWhenOwned(allowUnowned) {
    const currentOwner = navigationOwnerByCanvas.get(canvas);
    if ((currentOwner === owner || (allowUnowned && currentOwner === undefined))
      && document.pointerLockElement === canvas
      && typeof document.exitPointerLock === "function") document.exitPointerLock();
  }

  function completePointerCapture(ownership) {
    const ownsRequest = pointerLockRequest === ownership;
    if (ownsRequest) pointerLockRequest = null;
    if (!ownsRequest) return;
    if (released) {
      exitPointerLockWhenOwned(true);
      finishReleasedPointerLockLifecycle();
      return;
    }
    if (ownsCanvas()) synchronizePointerLock();
  }

  function rejectPointerCapture(ownership) {
    if (pointerLockRequest !== ownership) return;
    pointerLockRequest = null;
    if (released) {
      finishReleasedPointerLockLifecycle();
      return;
    }
    if (ownsCanvas()) clearMotion();
  }

  function synchronizePointerLock() {
    if (!ownsCanvas()) {
      pointerLocked = false;
      finishReleasedPointerLockLifecycle();
      return;
    }
    const acquired = document.pointerLockElement === canvas;
    if (acquired) pointerLockRequest = null;
    pointerLocked = !released && acquired;
    canvas.setAttribute("data-pointer-locked", String(pointerLocked));
    if (!pointerLocked) clearMotion();
    if (released && acquired) exitPointerLockWhenOwned(true);
    finishReleasedPointerLockLifecycle();
  }

  function pointerLockError() {
    if (pointerLockRequest !== null) rejectPointerCapture(pointerLockRequest);
  }

  function capturePointer(event) {
    if (released || !ownsCanvas() || event.pointerType === "touch") return;
    if (movementMode === creativeFlightMovement && pointerLocked && (event.button === 0 || event.button === 2)) {
      event.preventDefault?.();
      creativeAction(event.button === 0 ? "break" : "place", viewPosition(), viewForward());
      return;
    }
    if (event.button !== 0) return;
    canvas.focus({preventScroll: true});
    if (document.pointerLockElement === canvas || pointerLockRequest !== null
      || typeof canvas.requestPointerLock !== "function") return;
    const ownership = {};
    pointerLockRequest = ownership;
    try {
      const request = canvas.requestPointerLock();
      if (request !== undefined && typeof request.then === "function") {
        Promise.resolve(request).then(
          () => completePointerCapture(ownership),
          () => rejectPointerCapture(ownership),
        );
      }
    } catch {
      rejectPointerCapture(ownership);
    }
  }

  function contextMenu(event) {
    if (movementMode === creativeFlightMovement && pointerLocked && ownsCanvas()) event.preventDefault();
  }

  function look(event) {
    if (released || !ownsCanvas() || !pointerLocked) return;
    const settings = gameSettings();
    rotateView(
      clampPointerDelta(event.movementX) * mouseSensitivity * settings.sensitivity,
      clampPointerDelta(event.movementY) * mouseSensitivity * settings.sensitivity * (settings.invertY ? -1 : 1),
    );
  }

  if (mode === firstPersonMode) {
    canvas.addEventListener("pointerdown", capturePointer);
    canvas.addEventListener("contextmenu", contextMenu);
    document.addEventListener("pointerlockchange", synchronizePointerLock);
    document.addEventListener("pointerlockerror", pointerLockError);
    document.addEventListener("mousemove", look);
    synchronizePointerLock();
  }

  return {
    ownsCanvas,
    active,
    get pointerLocked() { return pointerLocked; },
    release() {
      if (released) return;
      released = true;
      if (mode === firstPersonMode) {
        canvas.removeEventListener("pointerdown", capturePointer);
        canvas.removeEventListener("contextmenu", contextMenu);
        document.removeEventListener("mousemove", look);
        if (ownsCanvas()) canvas.setAttribute("data-pointer-locked", "false");
        exitPointerLockWhenOwned(false);
        finishReleasedPointerLockLifecycle();
      } else if (ownsCanvas()) {
        navigationOwnerByCanvas.delete(canvas);
      }
      pointerLocked = false;
    },
  };
}
