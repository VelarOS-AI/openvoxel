import assert from "node:assert/strict";
import test from "node:test";
import {createCarouselWheelInput} from "../src/native/carousel-input.mjs";

test("the first intentional wheel gesture is never swallowed by the cooldown", () => {
  let prevented = 0;
  const input = createCarouselWheelInput(() => 12);
  assert.equal(input({deltaX: 0, deltaY: 80, preventDefault: () => prevented += 1}, 2), 1);
  assert.equal(prevented, 1);
});

test("wheel gestures choose their dominant axis and consume only accepted changes", () => {
  let now = 1_000;
  let prevented = 0;
  const event = (deltaX, deltaY) => ({
    deltaX,
    deltaY,
    preventDefault: () => prevented += 1,
  });
  const input = createCarouselWheelInput(() => now);

  assert.equal(input(event(-40, 12), 2), -1);
  assert.equal(prevented, 1);
  now += 100;
  assert.equal(input(event(-40, 12), 2), 0);
  assert.equal(prevented, 1);
  now += 320;
  assert.equal(input(event(2, 3), 2), 0);
  assert.equal(prevented, 1);
  assert.equal(input(event(4, 16), 2), 1);
  assert.equal(prevented, 2);
});

test("zoom, inert, and non-switchable wheel events retain browser defaults", () => {
  let prevented = 0;
  const input = createCarouselWheelInput(() => 1_000);
  const event = (overrides = {}) => ({
    ctrlKey: false,
    deltaX: 0,
    deltaY: 80,
    metaKey: false,
    preventDefault: () => prevented += 1,
    ...overrides,
  });

  assert.equal(input(event(), 0), 0);
  assert.equal(input(event(), 1), 0);
  assert.equal(input(event({ctrlKey: true}), 2), 0);
  assert.equal(input(event({metaKey: true}), 2), 0);
  assert.equal(input(event({deltaY: 0}), 2), 0);
  assert.equal(input(event({deltaY: Number.NaN}), 2), 0);
  assert.equal(prevented, 0);
});
