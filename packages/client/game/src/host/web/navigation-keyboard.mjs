import {creativeFlightMovement, firstPersonMode} from "./navigation-contract.mjs";

const firstPersonControlCodes = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyC", "Space",
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
]);
const observedShortcutModifierCodes = new Set(["AltLeft", "AltRight", "MetaLeft", "MetaRight"]);

function isModifiedC(event) {
  return event.code === "KeyC" && (event.ctrlKey === true || event.metaKey === true || event.altKey === true);
}

export function createNavigationKeyboard({canvas, mode, movementMode, active, ownsCanvas, clearMotion, creativeSlot}) {
  const document = canvas.ownerDocument;
  const window = document.defaultView;
  const keys = new Set();
  let released = false;

  function press(event) {
    if (movementMode === creativeFlightMovement && !released && ownsCanvas() && active()
      && /^Digit[1-5]$/u.test(event.code) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      creativeSlot(Number(event.code.slice(5)) - 1);
      return;
    }
    if (released || !ownsCanvas() || !active()
      || (!firstPersonControlCodes.has(event.code) && !observedShortcutModifierCodes.has(event.code))) return;
    if (observedShortcutModifierCodes.has(event.code)) {
      keys.add(event.code);
      return;
    }
    if (isModifiedC(event)) return;
    event.preventDefault();
    keys.add(event.code);
  }

  function releaseKey(event) {
    if (!firstPersonControlCodes.has(event.code) && !observedShortcutModifierCodes.has(event.code)) return;
    if (observedShortcutModifierCodes.has(event.code)) {
      keys.delete(event.code);
      return;
    }
    if (ownsCanvas() && active() && !isModifiedC(event)) event.preventDefault();
    keys.delete(event.code);
  }

  function visibilityChanged() {
    if (document.visibilityState !== "visible") clearMotion();
  }

  if (mode === firstPersonMode) {
    window.addEventListener("keydown", press);
    window.addEventListener("keyup", releaseKey);
    window.addEventListener("blur", clearMotion);
    canvas.addEventListener("blur", clearMotion);
    document.addEventListener("visibilitychange", visibilityChanged);
  }

  return {
    keys,
    clear: () => keys.clear(),
    release() {
      if (released) return;
      released = true;
      if (mode !== firstPersonMode) return;
      window.removeEventListener("keydown", press);
      window.removeEventListener("keyup", releaseKey);
      window.removeEventListener("blur", clearMotion);
      canvas.removeEventListener("blur", clearMotion);
      document.removeEventListener("visibilitychange", visibilityChanged);
    },
  };
}

export function flightIntent(keys) {
  return {
    forward: (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0),
    sideways: (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0),
    vertical: (keys.has("Space") ? 1 : 0) - (keys.has("ControlLeft") || keys.has("ControlRight") ? 1 : 0),
    boosted: keys.has("ShiftLeft") || keys.has("ShiftRight"),
  };
}

export function walkIntent(keys) {
  return {
    forward: (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0),
    sideways: (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0),
    jumping: keys.has("Space"),
    sprinting: keys.has("ShiftLeft") || keys.has("ShiftRight"),
    crouching: keys.has("KeyC")
      && !keys.has("ControlLeft") && !keys.has("ControlRight")
      && !keys.has("MetaLeft") && !keys.has("MetaRight")
      && !keys.has("AltLeft") && !keys.has("AltRight"),
  };
}
