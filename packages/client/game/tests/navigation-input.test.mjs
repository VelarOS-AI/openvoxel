import assert from "node:assert/strict";
import test from "node:test";
import {createNavigationAdapter} from "../src/host/web/navigation.mjs";

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    let listeners = this.listeners.get(type);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeCanvas extends FakeEventTarget {
  constructor(document) {
    super();
    this.ownerDocument = document;
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

function keyboardEvent(code, modifiers = {}) {
  return {
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...modifiers,
  };
}

function navigationFixture(movementMode, {locked = true} = {}) {
  const window = new FakeEventTarget();
  const document = new FakeEventTarget();
  document.defaultView = window;
  document.visibilityState = "visible";
  document.activeElement = null;
  const canvas = new FakeCanvas(document);
  document.pointerLockElement = locked ? canvas : null;
  document.exitPointerLock = () => {
    document.pointerLockElement = null;
    document.emit("pointerlockchange");
  };
  let position = {x: 0, y: 10, z: 0};
  const flightIntents = [];
  const walkIntents = [];
  const creativeActions = [];
  const creativeSlots = [];
  const aims = [];
  const walkSounds = [];
  const navigation = createNavigationAdapter({
    canvas,
    mode: "first-person",
    movementMode,
    edge: 16,
    bounds: {minimumY: -64, maximumY: 320},
    initialFlightState: {x: 0, y: 10, z: 0, velocityX: 0, velocityY: 0, velocityZ: 0},
    initialWalkState: {
      x: 0,
      y: 10,
      z: 0,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      grounded: true,
      crouching: false,
    },
    stepFlight: (state, intent) => {
      flightIntents.push({...intent});
      return state;
    },
    stepWalk: (state, intent) => {
      walkIntents.push({...intent});
      return {...state, crouching: intent.crouching};
    },
    collisionAt: () => [],
    readViewPosition: () => position,
    readViewForward: () => ({x: 0, y: 0, z: -1}),
    readHorizontalBasis: () => ({forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0}),
    applyFlightState: (state) => {
      position = state;
    },
    applyWalkState: (state) => {
      position = state;
    },
    rotateView: () => null,
    releaseView: () => null,
    viewChanged: () => null,
    aimChanged: (origin, forward) => aims.push({origin, forward}),
    creativeAction: (action, origin, forward) => creativeActions.push({action, origin, forward}),
    creativeSlot: (slot) => creativeSlots.push(slot),
    walkSound: (position, crouching, landed) => walkSounds.push({position, crouching, landed}),
  });
  return {canvas, document, window, navigation, flightIntents, walkIntents, creativeActions, creativeSlots, aims, walkSounds};
}

function withCanvasGlobal(run) {
  const previousCanvas = globalThis.HTMLCanvasElement;
  globalThis.HTMLCanvasElement = FakeCanvas;
  try {
    run();
  } finally {
    globalThis.HTMLCanvasElement = previousCanvas;
  }
}

test("locked creative input sends aimed edits and hotbar selection while preserving capture clicks", () => {
  withCanvasGlobal(() => {
    const fixture = navigationFixture("creative-flight");
    const left = {button: 0, prevented: false, preventDefault() { this.prevented = true; }};
    const right = {button: 2, prevented: false, preventDefault() { this.prevented = true; }};
    fixture.canvas.emit("pointerdown", left);
    fixture.canvas.emit("pointerdown", right);
    fixture.navigation.update(16);
    const slot = keyboardEvent("Digit3");
    fixture.window.emit("keydown", slot);
    assert.equal(left.prevented, true);
    assert.equal(right.prevented, true);
    assert.deepEqual(fixture.creativeActions.map((entry) => entry.action), ["break", "place"]);
    assert.deepEqual(fixture.creativeActions[0].origin, {x: 0, y: 10, z: 0});
    assert.deepEqual(fixture.creativeActions[0].forward, {x: 0, y: 0, z: -1});
    assert.equal(fixture.aims.length, 1);
    assert.deepEqual(fixture.creativeSlots, [2]);
    assert.equal(slot.defaultPrevented, true);

    fixture.document.pointerLockElement = null;
    fixture.document.emit("pointerlockchange");
    fixture.canvas.emit("pointerdown", left);
    assert.equal(fixture.creativeActions.length, 2, "the click that captures the pointer must not edit");
    fixture.navigation.release();
    fixture.canvas.emit("pointerdown", right);
    assert.equal(fixture.creativeActions.length, 2, "a released surface must not edit");
  });
});

test("creative flight uses Control alone for descent and no longer maps C to vertical movement", () => {
  withCanvasGlobal(() => {
    const fixture = navigationFixture("creative-flight");
    const controlDown = keyboardEvent("ControlLeft", {ctrlKey: true});
    fixture.window.emit("keydown", controlDown);
    fixture.navigation.update(16);
    assert.equal(controlDown.defaultPrevented, true);
    assert.deepEqual(fixture.flightIntents.at(-1), {
      forward: 0,
      sideways: 0,
      vertical: -1,
      boosted: false,
    });

    const controlUp = keyboardEvent("ControlLeft");
    fixture.window.emit("keyup", controlUp);
    const cDown = keyboardEvent("KeyC");
    fixture.window.emit("keydown", cDown);
    fixture.navigation.update(16);
    assert.equal(controlUp.defaultPrevented, true);
    assert.equal(cDown.defaultPrevented, true);
    assert.equal(fixture.flightIntents.at(-1).vertical, 0);

    fixture.window.emit("keydown", keyboardEvent("Space"));
    fixture.window.emit("keydown", keyboardEvent("ShiftRight"));
    fixture.navigation.update(16);
    assert.equal(fixture.flightIntents.at(-1).vertical, 1);
    assert.equal(fixture.flightIntents.at(-1).boosted, true);

    const escape = keyboardEvent("Escape");
    fixture.window.emit("keydown", escape);
    assert.equal(escape.defaultPrevented, false, "Escape remains browser-owned so it can release Pointer Lock");
    fixture.navigation.release();
  });
});

test("survival C produces a crouch intent while Shift remains the sprint modifier", () => {
  withCanvasGlobal(() => {
    const fixture = navigationFixture("survival-walk");
    const cDown = keyboardEvent("KeyC");
    fixture.window.emit("keydown", cDown);
    fixture.window.emit("keydown", keyboardEvent("ShiftLeft"));
    fixture.navigation.update(16);
    assert.equal(cDown.defaultPrevented, true);
    assert.equal(fixture.walkIntents.at(-1).crouching, true);
    assert.equal(fixture.walkIntents.at(-1).sprinting, true);
    assert.equal(fixture.canvas.attributes.get("data-player-crouching"), "true");

    const cUp = keyboardEvent("KeyC");
    fixture.window.emit("keyup", cUp);
    fixture.navigation.update(16);
    assert.equal(cUp.defaultPrevented, true);
    assert.equal(fixture.walkIntents.at(-1).crouching, false);
    assert.equal(fixture.canvas.attributes.get("data-player-crouching"), "false");
    fixture.navigation.release();
  });
});

test("modified C shortcuts remain browser-owned without being mistaken for the crouch binding", () => {
  withCanvasGlobal(() => {
    const fixture = navigationFixture("survival-walk");
    const controlDown = keyboardEvent("ControlRight", {ctrlKey: true});
    const modifiedC = keyboardEvent("KeyC", {ctrlKey: true});
    fixture.window.emit("keydown", controlDown);
    fixture.window.emit("keydown", modifiedC);
    fixture.navigation.update(16);
    assert.equal(controlDown.defaultPrevented, true);
    assert.equal(modifiedC.defaultPrevented, false, "Ctrl+C remains available to the browser");
    assert.equal(fixture.walkIntents.at(-1).crouching, false);

    fixture.window.emit("keyup", keyboardEvent("ControlRight"));
    fixture.navigation.update(16);
    assert.equal(fixture.walkIntents.at(-1).crouching, false, "a C press ignored behind Control cannot appear after Control is released");
    fixture.window.emit("keyup", keyboardEvent("KeyC"));

    const commandC = keyboardEvent("KeyC", {metaKey: true});
    const altC = keyboardEvent("KeyC", {altKey: true});
    fixture.window.emit("keydown", commandC);
    fixture.window.emit("keydown", altC);
    fixture.navigation.update(16);
    assert.equal(commandC.defaultPrevented, false, "Cmd+C remains available to the browser");
    assert.equal(altC.defaultPrevented, false, "Alt+C remains available to the browser");
    assert.equal(fixture.walkIntents.at(-1).crouching, false);
    const commandCUp = keyboardEvent("KeyC", {metaKey: true});
    const altCUp = keyboardEvent("KeyC", {altKey: true});
    fixture.window.emit("keyup", commandCUp);
    fixture.window.emit("keyup", altCUp);
    assert.equal(commandCUp.defaultPrevented, false);
    assert.equal(altCUp.defaultPrevented, false);

    fixture.window.emit("keydown", keyboardEvent("KeyC"));
    fixture.navigation.update(16);
    assert.equal(fixture.walkIntents.at(-1).crouching, true, "an unmodified C press still crouches");

    const metaDown = keyboardEvent("MetaLeft", {metaKey: true});
    fixture.window.emit("keydown", metaDown);
    fixture.navigation.update(16);
    assert.equal(metaDown.defaultPrevented, false);
    assert.equal(fixture.walkIntents.at(-1).crouching, false, "pressing Meta after C suspends crouching");

    const metaUp = keyboardEvent("MetaLeft");
    fixture.window.emit("keyup", metaUp);
    fixture.navigation.update(16);
    assert.equal(metaUp.defaultPrevented, false);
    assert.equal(fixture.walkIntents.at(-1).crouching, true, "releasing Meta restores the still-held C binding");

    const altDown = keyboardEvent("AltRight", {altKey: true});
    fixture.window.emit("keydown", altDown);
    fixture.navigation.update(16);
    assert.equal(altDown.defaultPrevented, false);
    assert.equal(fixture.walkIntents.at(-1).crouching, false, "pressing Alt after C suspends crouching");

    const altUp = keyboardEvent("AltRight");
    fixture.window.emit("keyup", altUp);
    fixture.navigation.update(16);
    assert.equal(altUp.defaultPrevented, false);
    assert.equal(fixture.walkIntents.at(-1).crouching, true, "releasing Alt restores the still-held C binding");

    fixture.window.emit("keydown", keyboardEvent("ControlLeft", {ctrlKey: true}));
    fixture.navigation.update(16);
    assert.equal(fixture.walkIntents.at(-1).crouching, false, "pressing Control after C cancels the crouch intent while the chord is held");

    fixture.window.emit("keyup", keyboardEvent("ControlLeft"));
    fixture.navigation.update(16);
    assert.equal(fixture.walkIntents.at(-1).crouching, true, "releasing Control restores the still-held unmodified C binding");
    fixture.navigation.release();
  });
});

test("game bindings leave browser shortcuts alone when first-person input is inactive", () => {
  withCanvasGlobal(() => {
    const fixture = navigationFixture("survival-walk", {locked: false});
    const controlDown = keyboardEvent("ControlLeft", {ctrlKey: true});
    const modifiedC = keyboardEvent("KeyC", {ctrlKey: true});
    fixture.window.emit("keydown", controlDown);
    fixture.window.emit("keydown", modifiedC);
    assert.equal(controlDown.defaultPrevented, false);
    assert.equal(modifiedC.defaultPrevented, false);
    fixture.navigation.update(16);
    assert.equal(fixture.walkIntents.at(-1).crouching, false);
    fixture.navigation.release();
  });
});
