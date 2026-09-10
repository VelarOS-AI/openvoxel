import assert from "node:assert/strict";
import test from "node:test";
import {createWorldExitCoordinator} from "../src/native/world-exit-guard.mjs";

const positionField = "__openVoxelNavigationPositionV1";

function browserHost(initialHref = "https://openvoxel.test/world/meadow") {
  const listeners = new Map();
  const entries = [
    {href: "https://openvoxel.test/", state: {[positionField]: -1}},
    {href: initialHref, state: null},
    {href: "https://openvoxel.test/worlds/new", state: {[positionField]: 1}},
  ];
  let index = 1;
  const calls = {go: [], replaced: [], removed: []};
  const host = {
    location: {href: entries[index].href},
    history: {
      get state() {
        return entries[index].state;
      },
      go(delta) {
        calls.go.push(delta);
        const target = index + delta;
        if (target < 0 || target >= entries.length) return;
        index = target;
        host.location.href = entries[index].href;
        listeners.get("popstate")?.listener({
          state: entries[index].state,
          stopped: false,
          stopImmediatePropagation() {
            this.stopped = true;
          },
        });
      },
      pushState(state, _title, href) {
        entries.splice(index + 1);
        entries.push({href: new URL(href, host.location.href).href, state});
        index += 1;
        host.location.href = entries[index].href;
      },
      replaceState(state, title, href) {
        const absoluteHref = new URL(href, host.location.href).href;
        entries[index] = {href: absoluteHref, state};
        host.location.href = absoluteHref;
        calls.replaced.push({state, title, href: absoluteHref});
      },
    },
    addEventListener(name, listener, capture) {
      listeners.set(name, {listener, capture});
    },
    removeEventListener(name, listener, capture) {
      const registered = listeners.get(name);
      if (registered?.listener === listener && registered.capture === capture) listeners.delete(name);
      calls.removed.push({name, capture});
    },
  };
  return {calls, entries, host, listeners};
}

test("world exit guard requests the browser's native confirmation before a real unload", () => {
  const browser = browserHost();
  const coordinator = createWorldExitCoordinator(browser.host);
  const guard = coordinator.activate(() => {});
  const event = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    returnValue: false,
  };

  browser.listeners.get("beforeunload").listener(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.returnValue, true);

  guard.allow();
  const allowedEvent = {...event, defaultPrevented: false, returnValue: false};
  browser.listeners.get("beforeunload").listener(allowedEvent);
  assert.equal(allowedEvent.defaultPrevented, false);
  assert.equal(allowedEvent.returnValue, false);
  browser.host.history.go(-1);
  assert.deepEqual(browser.calls.go, [-1]);
  coordinator.dispose();
  assert.equal(browser.listeners.size, 0);
});

test("same-document Back or Forward is restored and asks only one confirmation at a time", () => {
  const browser = browserHost();
  let confirmations = 0;
  const coordinator = createWorldExitCoordinator(browser.host);
  const guard = coordinator.activate(() => confirmations += 1);

  browser.host.history.go(-1);
  assert.equal(browser.host.location.href, "https://openvoxel.test/world/meadow");
  assert.deepEqual(browser.calls.go, [-1, 1]);
  assert.equal(confirmations, 1);

  browser.host.history.go(1);
  assert.equal(browser.host.location.href, "https://openvoxel.test/world/meadow");
  assert.deepEqual(browser.calls.go, [-1, 1, 1, -1]);
  assert.equal(confirmations, 1);

  guard.cancelHistoryLeave();
  browser.host.history.go(-1);
  assert.equal(browser.host.location.href, "https://openvoxel.test/world/meadow");
  assert.equal(confirmations, 2);
  coordinator.dispose();
});

test("confirmed history leave is one-shot and releases the active world", () => {
  const browser = browserHost();
  const coordinator = createWorldExitCoordinator(browser.host);
  const guard = coordinator.activate(() => {});

  browser.host.history.go(-1);
  guard.confirmHistoryLeave();
  guard.confirmHistoryLeave();
  guard.dispose();

  assert.equal(browser.host.location.href, "https://openvoxel.test/");
  assert.deepEqual(browser.calls.go, [-1, 1, -1]);
  assert.equal(browser.listeners.size, 2);
  coordinator.dispose();
  assert.equal(browser.listeners.size, 0);
  assert.deepEqual(browser.calls.removed, [
    {name: "beforeunload", capture: true},
    {name: "popstate", capture: true},
  ]);
});

test("application navigation records positions while preserving framework history state", () => {
  const browser = browserHost();
  const coordinator = createWorldExitCoordinator(browser.host);
  const runtimeCalls = [];
  const runtimeNavigate = (to, options) => {
    runtimeCalls.push({to, options});
    if (options?.replace === true) {
      browser.host.history.replaceState({framework: "replace"}, "", to);
    } else {
      browser.host.history.pushState({framework: "push"}, "", to);
    }
  };

  coordinator.navigate("/worlds/open", {scroll: false}, runtimeNavigate);
  assert.equal(browser.host.location.href, "https://openvoxel.test/worlds/open");
  assert.deepEqual(browser.host.history.state, {framework: "push", [positionField]: 1});

  coordinator.navigate("/worlds/new", {replace: true}, runtimeNavigate);
  assert.equal(browser.host.location.href, "https://openvoxel.test/worlds/new");
  assert.deepEqual(browser.host.history.state, {framework: "replace", [positionField]: 1});
  assert.deepEqual(runtimeCalls, [
    {to: "/worlds/open", options: {scroll: false}},
    {to: "/worlds/new", options: {replace: true}},
  ]);
  coordinator.dispose();
});

test("disposing an untouched guard is idempotent and never traverses history", () => {
  const browser = browserHost();
  const coordinator = createWorldExitCoordinator(browser.host);
  const guard = coordinator.activate(() => {});

  guard.dispose();
  guard.dispose();

  assert.deepEqual(browser.calls.go, []);
  assert.equal(browser.listeners.size, 2);
  coordinator.dispose();
  assert.equal(browser.listeners.size, 0);
});
