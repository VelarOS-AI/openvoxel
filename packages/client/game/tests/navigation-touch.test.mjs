import assert from 'node:assert/strict';
import test from 'node:test';
import {createNavigationTouch} from '../src/host/web/navigation-touch.mjs';
import {walkIntent, flightIntent} from '../src/host/web/navigation-keyboard.mjs';

class Surface {
  constructor(attributes = {}) { this.attributes = new Map(Object.entries(attributes)); this.listeners = new Map(); this.captures = new Set(); }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, data = {}) { for (const callback of this.listeners.get(type) ?? []) callback(data); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  closest(selector) { return this.attributes.has(selector.slice(1, -1)) ? this : null; }
  getBoundingClientRect() { return {left: 0, top: 0, width: 200, height: 200}; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}
function fixture(movementMode = 'survival-walk') {
  const root = new Surface({'data-world-ready': 'true'});
  const document = new Surface(), window = new Surface();
  document.defaultView = window; document.visibilityState = 'visible';
  let modal = false, portrait = false;
  window.matchMedia = () => ({matches: portrait});
  const move = new Surface({'data-touch-move': ''});
  const directions = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].map(key => new Surface({'data-touch-direction': key}));
  root.querySelectorAll = () => directions;
  root.querySelector = () => modal ? {} : null;
  const canvas = new Surface(); canvas.closest = selector => selector === '[data-screen="world"]' ? root : null; canvas.ownerDocument = document;
  const rotations = [], slots = [];
  const touch = createNavigationTouch({canvas, mode: 'first-person', movementMode, ownsCanvas: () => true, rotateView: (...args) => rotations.push(args), creativeSlot: slot => slots.push(slot)});
  const pointer = (type, target, pointerId, clientX = 100, clientY = 100) => {
    const event = {target, pointerId, clientX, clientY, pointerType: 'touch', preventDefault() {}};
    (type === 'pointerdown' ? root : document).emit(type, event);
  };
  return {root, document, window, canvas, move, directions, rotations, slots, touch, pointer,
    modal(value) { modal = value; document.emit('focusin'); }, portrait(value) { portrait = value; window.emit('resize'); }};
}

test('move, jump and look work concurrently and releasing one finger preserves the others', () => {
  const f = fixture();
  try {
    f.pointer('pointerdown', f.move, 1, 100, 30);
    f.pointer('pointerdown', f.move, 2, 100, 100);
    f.pointer('pointerdown', f.canvas, 3, 100, 100);
    assert.deepEqual([...f.touch.keys].sort(), ['KeyW', 'Space']);
    assert.equal(walkIntent(f.touch.keys).jumping, true);
    f.pointer('pointermove', f.canvas, 3, 130, 115);
    assert.deepEqual(f.rotations, [[.12, .06]]);
    f.pointer('pointerup', f.move, 2);
    assert.deepEqual([...f.touch.keys], ['KeyW']);
    f.pointer('pointermove', f.move, 1, 180, 20);
    assert.equal(walkIntent(f.touch.keys).sideways, 1);
    assert.equal(walkIntent(f.touch.keys).forward, 1);
    f.pointer('pointercancel', f.move, 1);
    assert.equal(f.touch.keys.size, 0);
    assert.equal(f.canvas.captures.size, 1);
    f.pointer('pointerup', f.canvas, 3);
    assert.equal(f.canvas.captures.size, 0);
  } finally { f.touch.release(); }
});

test('modal, rotation, visibility and release clear all captured touches without stuck movement', () => {
  const f = fixture();
  const press = () => f.pointer('pointerdown', f.move, 1, 100, 30);
  press(); assert.equal(walkIntent(f.touch.keys).forward, 1);
  f.modal(true); assert.equal(f.touch.keys.size, 0); assert.equal(f.move.captures.size, 0);
  press(); assert.equal(f.touch.keys.size, 0);
  f.modal(false); press(); f.portrait(true); assert.equal(f.touch.keys.size, 0);
  press(); assert.equal(f.touch.keys.size, 0);
  f.portrait(false); press(); f.document.visibilityState = 'hidden'; f.document.emit('visibilitychange');
  assert.equal(f.touch.keys.size, 0);
  f.document.visibilityState = 'visible'; press(); f.touch.release();
  assert.equal(f.touch.keys.size, 0);
  assert.equal(f.directions[0].getAttribute('data-pressed'), null);
  for (const target of [f.root, f.document, f.window]) assert.equal([...target.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0);
  press(); assert.equal(f.touch.keys.size, 0);
});

test('creative rise, descend and hotbar selection use canonical inputs and ignore unavailable game state', () => {
  const f = fixture('creative-flight');
  try {
    f.pointer('pointerdown', f.move, 1, 100, 100);
    assert.equal(flightIntent(f.touch.keys).vertical, 1);
    f.pointer('pointerdown', f.move, 2, 100, 180);
    assert.equal(flightIntent(f.touch.keys).vertical, -1);
    assert.equal(flightIntent(f.touch.keys).forward, 0);
    f.pointer('pointerup', f.move, 1);
    assert.equal(flightIntent(f.touch.keys).forward, -1);
    assert.equal(flightIntent(f.touch.keys).vertical, 0);
    const slot = new Surface({'data-creative-slot': '3'});
    f.pointer('pointerdown', slot, 3); assert.deepEqual(f.slots, [2]);
    f.root.setAttribute('data-world-ready', 'false'); f.touch.update();
    f.pointer('pointerdown', slot, 4); assert.deepEqual(f.slots, [2]);
    assert.equal(f.touch.keys.size, 0);
  } finally { f.touch.release(); }
});
