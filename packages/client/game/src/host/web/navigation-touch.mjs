import {gameSettings} from "../../settings/preferences.mjs";
import {creativeFlightMovement, firstPersonMode} from "./navigation-contract.mjs";

// The touch surface owns canonical game intents, independent of keyboard bindings.
export function createNavigationTouch({canvas, mode, movementMode, ownsCanvas, rotateView, creativeSlot}) {
  const keys = new Set();
  const root = canvas.closest?.('[data-screen="world"]');
  if (!root || mode !== firstPersonMode) return {keys, clear() {}, update() {}, release() {}};
  const document = canvas.ownerDocument;
  const window = document.defaultView;
  const touches = new Map();
  const pressed = new Set();
  let released = false;

  function enabled() {
    return !released && ownsCanvas() && document.visibilityState === "visible"
      && root.getAttribute("data-world-ready") === "true" && !root.querySelector("dialog[open]")
      && !window.matchMedia?.("(pointer: coarse) and (orientation: portrait)").matches;
  }

  function feedback() {
    keys.clear();
    const active = new Set();
    for (const touch of touches.values()) {
      for (const key of touch.keys) keys.add(key);
    }
    for (const button of root.querySelectorAll("[data-touch-direction]")) {
      if (keys.has(button.getAttribute("data-touch-direction"))) active.add(button);
    }
    // Original move-rose gesture: hold the center and use forward/back to rise/descend.
    if (movementMode === creativeFlightMovement && keys.has("Space")) {
      keys.delete("KeyW");
      if (keys.delete("KeyS")) {
        keys.delete("Space");
        keys.add("ControlLeft");
      }
    }
    for (const element of pressed) if (!active.has(element)) element.removeAttribute("data-pressed");
    for (const element of active) if (!pressed.has(element)) element.setAttribute("data-pressed", "true");
    pressed.clear();
    for (const element of active) pressed.add(element);
  }

  function moveKeys(touch, event) {
    if (touch.jump) return ["Space"];
    const rect = touch.rect;
    const x = (event.clientX - rect.left) / rect.width * 2 - 1;
    const y = (event.clientY - rect.top) / rect.height * 2 - 1;
    const distance = Math.hypot(x, y);
    if (distance < 1 / 3.5 || distance > 1.3) return [];
    const result = [];
    if (Math.abs(y) > Math.abs(x) * .414) result.push(y < 0 ? "KeyW" : "KeyS");
    if (Math.abs(x) > Math.abs(y) * .414) result.push(x < 0 ? "KeyA" : "KeyD");
    return result;
  }

  function down(event) {
    if (event.pointerType !== "touch" || !enabled()) return;
    const target = event.target;
    const move = target.closest?.("[data-touch-move]");
    const look = target === canvas;
    const slot = target.closest?.("[data-creative-slot]");
    if (slot && movementMode === creativeFlightMovement) {
      event.preventDefault();
      creativeSlot(Number(slot.getAttribute("data-creative-slot")) - 1);
      return;
    }
    const element = move ?? (look ? canvas : null);
    if (!element) return;
    event.preventDefault();
    // A second look finger must not multiply camera movement.
    if (look && [...touches.values()].some(touch => touch.kind === "look")) return;
    const touch = {element, kind: move ? "move" : "look", keys: [], x: event.clientX, y: event.clientY};
    if (move) {
      touch.rect = move.getBoundingClientRect();
      const {left, top, width, height} = touch.rect;
      touch.jump = Math.hypot((event.clientX - left) / width * 2 - 1, (event.clientY - top) / height * 2 - 1) <= 1 / 3.5;
      touch.keys = moveKeys(touch, event);
    }
    touches.set(event.pointerId, touch);
    element.setPointerCapture(event.pointerId);
    feedback();
  }

  function move(event) {
    const touch = touches.get(event.pointerId);
    if (!touch) return;
    if (!enabled()) { clear(); return; }
    event.preventDefault();
    if (touch.kind === "look") {
      const settings = gameSettings();
      const scale = .004 * settings.sensitivity;
      rotateView(
        Math.max(-100, Math.min(100, event.clientX - touch.x)) * scale,
        Math.max(-100, Math.min(100, event.clientY - touch.y)) * scale * (settings.invertY ? -1 : 1),
      );
    } else if (touch.kind === "move") {
      touch.keys = moveKeys(touch, event);
      feedback();
    }
    touch.x = event.clientX;
    touch.y = event.clientY;
  }

  function releaseCapture(element, id) {
    if (element.hasPointerCapture?.(id)) element.releasePointerCapture(id);
  }

  function up(event) {
    const touch = touches.get(event.pointerId);
    if (!touch) return;
    touches.delete(event.pointerId);
    releaseCapture(touch.element, event.pointerId);
    feedback();
  }

  function clear() {
    const previous = [...touches];
    touches.clear();
    keys.clear();
    for (const element of pressed) element.removeAttribute("data-pressed");
    pressed.clear();
    for (const [id, touch] of previous) releaseCapture(touch.element, id);
  }

  function update() {
    if (touches.size > 0 && !enabled()) clear();
  }

  root.addEventListener("pointerdown", down);
  document.addEventListener("pointermove", move, {passive: false});
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", up);
  root.addEventListener("lostpointercapture", up);
  document.addEventListener("focusin", update);
  document.addEventListener("visibilitychange", update);
  window.addEventListener("blur", clear);
  window.addEventListener("resize", clear);

  return {
    keys, clear, update,
    release() {
      if (released) return;
      released = true;
      clear();
      root.removeEventListener("pointerdown", down);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      root.removeEventListener("lostpointercapture", up);
      document.removeEventListener("focusin", update);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("blur", clear);
      window.removeEventListener("resize", clear);
    },
  };
}
