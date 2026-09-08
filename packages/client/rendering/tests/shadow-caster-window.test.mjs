import assert from "node:assert/strict";
import test from "node:test";
import {
  ShadowCasterWindow,
  ShadowRefreshScheduler,
  shadowLightPosition,
} from "../src/native/babylon/shadow-caster-window.mjs";

function mesh(x, y, z) {
  return {position: {x, y, z}};
}

test("shadow casters are activated only inside the camera-local three-dimensional window", () => {
  const activated = [];
  const deactivated = [];
  const window = new ShadowCasterWindow({
    edge: 16,
    radius: 40,
    activate: (candidate) => activated.push(candidate),
    deactivate: (candidate) => deactivated.push(candidate),
  });
  const near = mesh(0, 0, 0);
  const verticallyFar = mesh(0, 64, 0);
  const horizontallyFar = mesh(64, 0, 0);
  window.add(near);
  window.add(verticallyFar);
  window.add(horizontallyFar);

  assert.equal(window.update({x: 8, y: 8, z: 8}), true);
  assert.deepEqual(activated, [near]);
  assert.equal(window.totalSize, 3);
  assert.equal(window.activeSize, 1);

  assert.equal(window.update({x: 72, y: 8, z: 8}), true);
  assert.deepEqual(deactivated, [near]);
  assert.deepEqual(activated, [near, horizontallyFar]);
  assert.equal(window.activeSize, 1);
});

test("shadow selection is stable within a Chunk and refreshes after ownership changes", () => {
  let activations = 0;
  let deactivations = 0;
  const window = new ShadowCasterWindow({
    edge: 16,
    radius: 32,
    activate: () => { activations += 1; },
    deactivate: () => { deactivations += 1; },
  });
  const first = mesh(0, 0, 0);
  const second = mesh(16, 0, 0);
  window.add(first);
  window.update({x: 8, y: 8, z: 8});
  assert.equal(window.update({x: 15.9, y: 8, z: 8}), false, "sub-Chunk camera motion must not rescan caster bounds");

  window.add(second);
  assert.equal(window.update({x: 15.9, y: 8, z: 8}), true);
  assert.equal(activations, 2);
  window.delete(first);
  assert.equal(deactivations, 1);
  window.clear();
  assert.equal(deactivations, 2);
  assert.equal(window.totalSize, 0);
  assert.equal(window.activeSize, 0);
});

test("shadow texel snapping preserves fixed-world edges during tiny camera movements", () => {
  const direction = {x: 0, y: -1, z: 0};
  const initial = shadowLightPosition({x: 10, y: 20, z: -5}, direction, 128, 2_048, 120);
  const tinyMove = shadowLightPosition({x: 10.001, y: 20.001, z: -5.001}, direction, 128, 2_048, 120);
  assert.deepEqual(tinyMove, initial);
  const nextTexel = shadowLightPosition({x: 10.07, y: 20, z: -5}, direction, 128, 2_048, 120);
  assert.equal(nextTexel.x - initial.x, 128 / 2_048);
  assert.ok(Object.values(initial).every(Number.isFinite), "zenith sun must have a finite shadow projection");
});

test("removing a visible caster invalidates the next cached shadow map", () => {
  const window = new ShadowCasterWindow({edge: 16, radius: 32, activate: () => {}, deactivate: () => {}});
  const caster = mesh(0, 0, 0);
  const position = {x: 8, y: 8, z: 8};
  window.add(caster);
  window.update(position);
  assert.equal(window.update(position), false);
  window.delete(caster);
  assert.equal(window.update(position), true, "removing a caster must clear its cached shadow without moving the camera");
});

test("off-window caster ownership does not invalidate an unchanged shadow map", () => {
  const window = new ShadowCasterWindow({edge: 16, radius: 32, activate: () => {}, deactivate: () => {}});
  const position = {x: 8, y: 8, z: 8};
  window.add(mesh(0, 0, 0));
  assert.equal(window.update(position), true);

  const far = mesh(128, 0, 0);
  window.add(far);
  assert.equal(window.update(position), false, "adding an inactive caster must retain the cached map");
  window.delete(far);
  assert.equal(window.update(position), false, "removing an inactive caster must retain the cached map");
});

test("shadow refreshes coalesce repeated invalidations without delaying the first frame", () => {
  const scheduler = new ShadowRefreshScheduler(100);
  assert.equal(scheduler.advance(0), true, "the first shadow map must render immediately");
  assert.equal(scheduler.advance(500), false, "clean elapsed time must not render a shadow map");

  scheduler.invalidate();
  assert.equal(scheduler.advance(0), true, "a change after a quiet interval may render immediately");
  scheduler.invalidate();
  assert.equal(scheduler.advance(40), false);
  scheduler.invalidate();
  assert.equal(scheduler.advance(59), false);
  assert.equal(scheduler.advance(1), true, "continuous changes must be coalesced to the interval boundary");
  assert.equal(scheduler.advance(100), false);

  scheduler.invalidate(true);
  assert.equal(scheduler.advance(0), true, "context restoration must bypass the interval once");
});

test("shadow refresh scheduling rejects invalid time input", () => {
  assert.throws(() => new ShadowRefreshScheduler(0), /positive finite/u);
  const scheduler = new ShadowRefreshScheduler(100);
  assert.throws(() => scheduler.advance(-1), /non-negative finite/u);
  assert.throws(() => scheduler.invalidate("now"), /must be boolean/u);
});
