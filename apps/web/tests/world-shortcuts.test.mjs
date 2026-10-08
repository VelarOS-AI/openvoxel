import assert from "node:assert/strict";
import test from "node:test";
import {createWorldShortcuts} from "../src/native/world-shortcuts.mjs";

test("inventory E is page-owned, ignores typing/modifiers/modals, and releases its listener", () => {
  let listener, modal = null, opens = 0, closes = 0;
  const window = {
    addEventListener(name, value, capture) { assert.equal(name, "keydown"); assert.equal(capture, true); listener = value; },
    removeEventListener(name, value, capture) { assert.equal(name, "keydown"); assert.equal(capture, true); assert.equal(listener, value); listener = null; },
  };
  const document = {defaultView: window, querySelector: () => modal, pointerLockElement: null};
  const canvas = {ownerDocument: document, isConnected: true};
  const dialog = {open: false};
  const controls = createWorldShortcuts(canvas, () => dialog, () => opens++, () => closes++);
  const press = (extra = {}) => {
    let prevented = false, stopped = false;
    listener({code: "KeyE", preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; }, ...extra});
    return prevented && stopped;
  };
  document.pointerLockElement = canvas;
  assert.equal(press(), true);
  assert.equal(opens, 1);
  for (const extra of [{repeat: true}, {isComposing: true}, {ctrlKey: true}, {metaKey: true}, {altKey: true}, {code: "KeyW"}, {target: {closest: () => ({})}}]) assert.equal(press(extra), false);
  modal = {};
  assert.equal(press(), false);
  modal = dialog; dialog.open = true;
  assert.equal(press(), true);
  assert.equal(closes, 1);
  assert.equal(opens, 1);
  document.pointerLockElement = {};
  assert.equal(press(), false);
  controls.dispose();
  assert.equal(listener, null);
});
