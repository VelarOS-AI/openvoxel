import {gameSettings, subscribeGameSettings} from "../../settings/preferences.mjs";
import {creativeFlightMovement, firstPersonMode} from "./navigation-contract.mjs";

const observedShortcutModifierCodes = new Set(["AltLeft", "AltRight", "MetaLeft", "MetaRight"]);

function isModifiedC(event) {
  return event.code === "KeyC" && (event.ctrlKey === true || event.metaKey === true || event.altKey === true);
}

export function createNavigationKeyboard({canvas, mode, movementMode, active, ownsCanvas, clearMotion, creativeSlot}) {
  const document = canvas.ownerDocument;
  const window = document.defaultView;
  const keys = new Set();
  let released = false;
  const canonical = {forwardKey: "KeyW", backwardKey: "KeyS", leftKey: "KeyA", rightKey: "KeyD", jumpKey: "Space", sprintKey: "ShiftLeft", crouchKey: "KeyC", descendKey: "ControlLeft"};
  function mappedCode(code) {
    const settings = gameSettings();
    for (const [key, original] of Object.entries(canonical)) if (settings[key] === code) return original;
    if (code === "ShiftRight" && settings.sprintKey === "ShiftLeft") return "ShiftRight";
    if (code === "ControlRight" && settings.descendKey === "ControlLeft") return "ControlRight";
    return observedShortcutModifierCodes.has(code) ? code : null;
  }
  const settingsSubscription = subscribeGameSettings(() => clearMotion());

  function press(event) {
    if (movementMode === creativeFlightMovement && !released && ownsCanvas() && active()
      && /^Digit[1-9]$/u.test(event.code) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      creativeSlot(Number(event.code.slice(5)) - 1);
      return;
    }
    if (released || !ownsCanvas() || !active()
      || mappedCode(event.code) === null) return;
    if (observedShortcutModifierCodes.has(event.code)) {
      keys.add(event.code);
      return;
    }
    if (isModifiedC(event)) return;
    event.preventDefault();
    keys.add(mappedCode(event.code));
  }

  function releaseKey(event) {
    if (mappedCode(event.code) === null) return;
    if (observedShortcutModifierCodes.has(event.code)) {
      keys.delete(event.code);
      return;
    }
    if (ownsCanvas() && active() && !isModifiedC(event)) event.preventDefault();
    keys.delete(mappedCode(event.code));
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
      settingsSubscription.close();
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
