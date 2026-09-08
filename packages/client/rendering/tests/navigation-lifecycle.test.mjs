import assert from "node:assert/strict";
import test from "node:test";
import {createNavigationAdapter} from "../src/native/babylon/navigation.mjs";

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

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
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
    this.requests = 0;
    this.resolvePointerLock = null;
    this.pointerLockReturnsVoid = false;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  requestPointerLock() {
    this.requests += 1;
    if (this.pointerLockReturnsVoid) return undefined;
    return new Promise((resolve) => {
      this.resolvePointerLock = resolve;
    });
  }
}

function navigationForCanvas(canvas, released, demand = null) {
  let releasedViews = 0;
  const navigation = createNavigationAdapter({
    canvas,
    mode: "first-person",
    movementMode: "creative-flight",
    edge: 16,
    bounds: {minimumY: -64, maximumY: 320},
    initialState: {x: 0, y: 10, z: 0, velocityX: 0, velocityY: 0, velocityZ: 0},
    initialSurvivalState: {x: 0, y: 10, z: 0, velocityX: 0, velocityY: 0, velocityZ: 0, grounded: false},
    stepCreativeFlight: (state) => state,
    stepSurvivalWalk: (state) => state,
    collisionAt: () => [],
    readViewPosition: () => demand?.position ?? {x: 0, y: 10, z: 0},
    readViewForward: () => demand?.forward ?? {x: 0, y: 0, z: -1},
    readHorizontalBasis: () => ({forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0}),
    applyFlightState: () => null,
    applySurvivalState: () => null,
    rotateView: () => null,
    releaseView: () => {
      releasedViews += 1;
      released?.();
    },
    viewChanged: (...change) => {
      demand?.changes.push(change);
      return null;
    },
  });
  return {navigation, releasedViews: () => releasedViews};
}

function navigationFixture(demand = null) {
  const window = new FakeEventTarget();
  const document = new FakeEventTarget();
  document.defaultView = window;
  document.visibilityState = "visible";
  document.pointerLockElement = null;
  document.activeElement = null;
  document.exitCalls = 0;
  document.exitPointerLock = () => {
    document.exitCalls += 1;
    document.pointerLockElement = null;
    document.emit("pointerlockchange");
  };
  const canvas = new FakeCanvas(document);
  const created = navigationForCanvas(canvas, null, demand);
  const navigation = created.navigation;
  const releasedViews = created.releasedViews;
  return {canvas, document, navigation, releasedViews};
}

async function settlePromiseCallbacks() {
  await Promise.resolve();
  await Promise.resolve();
}

test("a pointer-lock request that resolves after release immediately exits its canvas lock", async () => {
  const previousCanvas = globalThis.HTMLCanvasElement;
  globalThis.HTMLCanvasElement = FakeCanvas;
  try {
    const fixture = navigationFixture();
    fixture.canvas.emit("pointerdown", {button: 0});
    fixture.canvas.emit("pointerdown", {button: 0});
    assert.equal(fixture.canvas.requests, 1, "one adapter must own at most one pending lock request");

    fixture.navigation.release();
    fixture.document.pointerLockElement = fixture.canvas;
    fixture.canvas.resolvePointerLock();
    await settlePromiseCallbacks();

    assert.equal(fixture.document.exitCalls, 1);
    assert.equal(fixture.document.pointerLockElement, null);
    assert.equal(fixture.canvas.attributes.get("data-pointer-locked"), "false");
    assert.equal(fixture.releasedViews(), 1);
  } finally {
    globalThis.HTMLCanvasElement = previousCanvas;
  }
});

test("the current pointer-lock request keeps ownership after successful completion", async () => {
  const previousCanvas = globalThis.HTMLCanvasElement;
  globalThis.HTMLCanvasElement = FakeCanvas;
  try {
    const fixture = navigationFixture();
    fixture.canvas.emit("pointerdown", {button: 0});
    fixture.document.pointerLockElement = fixture.canvas;
    fixture.document.emit("pointerlockchange");
    fixture.canvas.resolvePointerLock();
    await settlePromiseCallbacks();

    assert.equal(fixture.navigation.stats().pointerLocked, true);
    assert.equal(fixture.document.exitCalls, 0);
    fixture.navigation.release();
    assert.equal(fixture.document.exitCalls, 1);
  } finally {
    globalThis.HTMLCanvasElement = previousCanvas;
  }
});

test("a stale adapter completion cannot release a successor lock on the same canvas", async () => {
  const previousCanvas = globalThis.HTMLCanvasElement;
  globalThis.HTMLCanvasElement = FakeCanvas;
  try {
    const fixture = navigationFixture();
    fixture.canvas.emit("pointerdown", {button: 0});
    const resolveStaleLock = fixture.canvas.resolvePointerLock;
    fixture.navigation.release();

    const successor = navigationForCanvas(fixture.canvas).navigation;
    fixture.canvas.emit("pointerdown", {button: 0});
    const resolveSuccessorLock = fixture.canvas.resolvePointerLock;
    fixture.document.pointerLockElement = fixture.canvas;
    fixture.document.emit("pointerlockchange");
    resolveSuccessorLock();
    await settlePromiseCallbacks();

    assert.equal(successor.stats().pointerLocked, true);
    assert.equal(fixture.document.exitCalls, 0);
    resolveStaleLock();
    await settlePromiseCallbacks();

    assert.equal(successor.stats().pointerLocked, true);
    assert.equal(fixture.document.pointerLockElement, fixture.canvas);
    assert.equal(fixture.document.exitCalls, 0);
    successor.release();
    assert.equal(fixture.document.exitCalls, 1);
  } finally {
    globalThis.HTMLCanvasElement = previousCanvas;
  }
});

test("a stale request revokes its late grant after the successor has also released", async () => {
  const previousCanvas = globalThis.HTMLCanvasElement;
  globalThis.HTMLCanvasElement = FakeCanvas;
  try {
    const fixture = navigationFixture();
    fixture.canvas.emit("pointerdown", {button: 0});
    const resolveStaleLock = fixture.canvas.resolvePointerLock;
    fixture.navigation.release();

    const successor = navigationForCanvas(fixture.canvas).navigation;
    successor.release();
    fixture.document.pointerLockElement = fixture.canvas;
    resolveStaleLock();
    await settlePromiseCallbacks();

    assert.equal(fixture.document.exitCalls, 1);
    assert.equal(fixture.document.pointerLockElement, null);
    assert.equal(fixture.document.listenerCount("pointerlockchange"), 0);
    assert.equal(fixture.document.listenerCount("pointerlockerror"), 0);
  } finally {
    globalThis.HTMLCanvasElement = previousCanvas;
  }
});

test("a released adapter retains a void pointer-lock request until its late grant is revoked", () => {
  const previousCanvas = globalThis.HTMLCanvasElement;
  globalThis.HTMLCanvasElement = FakeCanvas;
  try {
    const fixture = navigationFixture();
    fixture.canvas.pointerLockReturnsVoid = true;
    fixture.canvas.emit("pointerdown", {button: 0});
    fixture.document.emit("pointerlockchange");
    fixture.canvas.emit("pointerdown", {button: 0});
    assert.equal(fixture.canvas.requests, 1, "an unrelated unlocked change must preserve the pending request");

    fixture.navigation.release();

    fixture.document.emit("pointerlockchange");
    assert.equal(fixture.document.exitCalls, 0, "an unrelated unlocked change must not settle the pending request");
    assert.equal(fixture.document.listenerCount("pointerlockchange"), 1);

    fixture.document.pointerLockElement = fixture.canvas;
    fixture.document.emit("pointerlockchange");
    assert.equal(fixture.document.exitCalls, 1);
    assert.equal(fixture.document.pointerLockElement, null);
    assert.equal(fixture.document.listenerCount("pointerlockchange"), 0);
    assert.equal(fixture.document.listenerCount("pointerlockerror"), 0);
  } finally {
    globalThis.HTMLCanvasElement = previousCanvas;
  }
});

test("a successor synchronizes an existing lock and the replaced adapter cannot release it", () => {
  const previousCanvas = globalThis.HTMLCanvasElement;
  globalThis.HTMLCanvasElement = FakeCanvas;
  try {
    const fixture = navigationFixture();
    fixture.document.pointerLockElement = fixture.canvas;
    fixture.document.emit("pointerlockchange");
    assert.equal(fixture.navigation.stats().pointerLocked, true);

    const successor = navigationForCanvas(fixture.canvas).navigation;
    assert.equal(successor.stats().pointerLocked, true);
    assert.equal(fixture.canvas.attributes.get("data-pointer-locked"), "true");

    fixture.navigation.release();
    assert.equal(fixture.document.exitCalls, 0);
    assert.equal(fixture.canvas.attributes.get("data-pointer-locked"), "true");
    assert.equal(successor.stats().pointerLocked, true);

    successor.release();
    assert.equal(fixture.document.exitCalls, 1);
  } finally {
    globalThis.HTMLCanvasElement = previousCanvas;
  }
});

test("view demand reports meaningful look changes without restarting the Chunk window", () => {
  const previousCanvas = globalThis.HTMLCanvasElement;
  globalThis.HTMLCanvasElement = FakeCanvas;
  try {
    const demand = {
      position: {x: 0, y: 10, z: 0},
      forward: {x: 0, y: 0, z: -1},
      changes: [],
    };
    const fixture = navigationFixture(demand);
    const smallAngle = Math.PI / 45;
    demand.forward = {x: Math.sin(smallAngle), y: 0, z: -Math.cos(smallAngle)};
    fixture.navigation.update(16);
    assert.deepEqual(demand.changes, [], "sub-threshold look jitter must not publish demand");

    const visibleAngle = Math.PI / 18;
    demand.forward = {x: Math.sin(visibleAngle), y: 0, z: -Math.cos(visibleAngle)};
    fixture.navigation.update(16);
    assert.equal(demand.changes.length, 1);
    assert.deepEqual(demand.changes[0].slice(0, 3), [0, 0, 0]);

    demand.position = {x: 16.1, y: 10, z: 0};
    fixture.navigation.update(16);
    assert.equal(demand.changes.length, 2);
    assert.deepEqual(demand.changes[1].slice(0, 3), [1, 0, 0]);
    fixture.navigation.release();
  } finally {
    globalThis.HTMLCanvasElement = previousCanvas;
  }
});
