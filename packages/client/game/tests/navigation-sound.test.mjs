import assert from "node:assert/strict";
import test from "node:test";
import {createNavigationMovement} from "../src/host/web/navigation-movement.mjs";

test("ground travel produces spaced footsteps and landing produces one impact", () => {
  const sounds = [];
  let frame = 0;
  const initial = {
    x: 0, y: 10, z: 0,
    velocityX: 0, velocityY: 0, velocityZ: 0,
    grounded: true, crouching: false,
  };
  const movement = createNavigationMovement({
    mode: "first-person", movementMode: "survival-walk",
    initialFlightState: {x: 0, y: 10, z: 0, velocityX: 0, velocityY: 0, velocityZ: 0},
    initialWalkState: initial,
    stepFlight: () => { throw new Error("flight should not run"); },
    stepWalk: (state) => {
      frame += 1;
      if (frame === 23) return {...state, x: state.x + 0.1, grounded: false, velocityY: -3};
      if (frame === 24) return {...state, grounded: true, velocityY: 0};
      return {...state, x: state.x + 0.1};
    },
    readHorizontalBasis: () => ({forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0}),
    applyFlightState: () => null,
    applyWalkState: () => null,
    bounds: {minimumY: -64, maximumY: 320},
    collisionAt: () => [],
    walkSound: (position, crouching, landed) => sounds.push({x: position.x, crouching, landed}),
  });
  const keys = new Set(["KeyW"]);
  for (let index = 0; index < 20; index += 1) movement.update(keys, 16);
  assert.equal(sounds.length, 0, "travel shorter than the player stride stays quiet");
  movement.update(keys, 16);
  assert.deepEqual(sounds.map(({landed}) => landed), [false]);
  movement.update(keys, 16);
  movement.update(keys, 16);
  movement.update(keys, 16);
  assert.deepEqual(sounds.map(({landed}) => landed), [false, true]);
  assert.ok(Math.abs(sounds[0].x - 2.1) < 0.000001);
  assert.ok(Math.abs(sounds[1].x - 2.3) < 0.000001);
  movement.clearMotion();
  movement.update(new Set(), 16);
  assert.equal(sounds.length, 2);
});
