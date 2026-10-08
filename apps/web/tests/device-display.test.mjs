import assert from 'node:assert/strict';
import test from 'node:test';

async function fixture(scenario) {
  const saved = new Map(['document', 'screen', 'matchMedia'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls = [];
  let resolveFullscreen;
  const element = {requestFullscreen() { calls.push('fullscreen'); return new Promise(resolve => { resolveFullscreen = () => { document.fullscreenElement = element; resolve(); }; }); }};
  const document = {documentElement: element, fullscreenElement: null, exitFullscreen() { calls.push('exit'); document.fullscreenElement = null; return Promise.resolve(); }};
  const orientation = {lock(value) { calls.push(value); return Promise.resolve(); }, unlock() { calls.push('unlock'); }};
  Object.defineProperties(globalThis, {
    document: {value: document, configurable: true}, screen: {value: {orientation}, configurable: true},
    matchMedia: {value: () => ({matches: true}), configurable: true},
  });
  try {
    const api = await import(`../src/native/device-display.mjs?test=${scenario}`);
    await scenario({api, calls, document, orientation, complete: async () => { resolveFullscreen(); await new Promise(resolve => setImmediate(resolve)); }});
  } finally {
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}

test('landscape requests coalesce and late fullscreen completion is cleaned up after leaving', () => fixture(async ({api, calls, complete}) => {
  api.requestGameLandscape(); api.requestGameLandscape(); api.releaseGameLandscape();
  await complete();
  assert.deepEqual(calls, ['fullscreen', 'exit']);
}));

test('game unlocks its orientation and exits only fullscreen it opened', () => fixture(async ({api, calls, complete}) => {
  api.requestGameLandscape(); await complete(); api.releaseGameLandscape();
  assert.deepEqual(calls, ['fullscreen', 'landscape', 'unlock', 'exit']);
}));

test('pre-existing fullscreen is retained while our orientation lock is released', () => fixture(async ({api, calls, document}) => {
  document.fullscreenElement = document.documentElement;
  api.requestGameLandscape(); await new Promise(resolve => setImmediate(resolve)); api.releaseGameLandscape();
  assert.deepEqual(calls, ['landscape', 'unlock']);
}));
