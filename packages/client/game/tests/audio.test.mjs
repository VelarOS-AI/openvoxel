import assert from "node:assert/strict";
import test from "node:test";
import {createAudioAdapter} from "../src/host/web/audio.mjs";

class EventTarget {
  listeners = new Map();
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name) { for (const listener of this.listeners.get(name) ?? []) listener(); }
}

class FakeParam {
  value = 0;
  setTargetAtTime(value) { this.value = value; }
}

class FakeNode {
  connect(node) { return node; }
  start(when) { this.started = true; this.when = when; }
  disconnect() { this.disconnected = true; }
  stop() { this.stopped = true; }
}

class FakeContext {
  static instances = [];
  currentTime = 5;
  state = "running";
  destination = new FakeNode();
  sources = [];
  gains = [];
  decoded = 0;
  constructor() { FakeContext.instances.push(this); }
  async decodeAudioData(bytes) {
    assert.equal(bytes.byteLength, 8);
    this.decoded += 1;
    return {decoded: this.decoded};
  }
  createBuffer(channels, length) { return {getChannelData: () => new Float32Array(length)}; }
  createBiquadFilter() { return Object.assign(new FakeNode(), {frequency: new FakeParam(), Q: new FakeParam()}); }
  createBufferSource() {
    const node = Object.assign(new FakeNode(), {playbackRate: new FakeParam()});
    this.sources.push(node);
    return node;
  }
  createGain() {
    const node = Object.assign(new FakeNode(), {gain: new FakeParam()});
    this.gains.push(node);
    return node;
  }
  async resume() { this.state = "running"; }
  async suspend() { this.state = "suspended"; }
  async close() { this.state = "closed"; }
}

class FakeCanvas extends EventTarget {
  constructor(document) {
    super();
    this.ownerDocument = document;
  }
}

function weather(overrides = {}) {
  return {precipitation: "rain", precipitationIntensity: 0.8, lightning: null, ...overrides};
}

async function settleAudio() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

test("original sound files follow weather, material groups, and lifecycle", async () => {
  FakeContext.instances.length = 0;
  const requests = [];
  const document = new EventTarget();
  document.visibilityState = "visible";
  document.defaultView = {
    AudioContext: FakeContext,
    HTMLCanvasElement: FakeCanvas,
    async fetch(path) {
      requests.push(path);
      return {ok: true, arrayBuffer: async () => new ArrayBuffer(8)};
    },
  };
  const canvas = new FakeCanvas(document);
  const audio = createAudioAdapter(canvas);
  audio.setListenerPosition({x: 0, y: 0, z: 0});
  audio.setEnvironment(weather());
  audio.setAmbient(1, 0);
  assert.equal(FakeContext.instances.length, 0, "audio unlocks only after a user gesture");

  canvas.emit("pointerdown");
  await settleAudio();
  const context = FakeContext.instances[0];
  assert.deepEqual(requests.slice(0, 3), [
    "/generated/audio/Rain.flac",
    "/generated/audio/Water.flac",
    "/generated/audio/Magma.flac",
  ]);
  assert.equal(context.sources.length, 4, "environmental recordings loop");
  assert.ok(context.gains[1].gain.value > 0, "rain intensity reaches the ambient channel");
  assert.ok(context.gains[2].gain.value > 0, "nearby water reaches the ambient channel");
  assert.equal(context.gains[3].gain.value, 0, "distant magma is silent");
  audio.setAmbient(0.4, 0.8);
  assert.equal(context.gains[2].gain.value, 0.1, "water flow fades with distance");
  assert.equal(context.gains[3].gain.value, 0.2, "magma has an independent ambient level");
  audio.setAmbient(0, 0);
  assert.equal(context.gains[2].gain.value, 0, "water stops when the listener moves away");

  audio.play("step", "openvoxel:sound/stone");
  audio.play("break", "openvoxel:sound/glass");
  audio.play("place", "openvoxel:sound/wood");
  audio.play("break", "openvoxel:sound/none");
  await settleAudio();
  assert.equal(context.sources.length, 7);
  assert.ok(requests.some(path => /^\/generated\/audio\/Footsteps\/Stone\/FootstepStone[12]\.flac$/u.test(path)));
  assert.ok(requests.some(path => /^\/generated\/audio\/Impacts\/Glass\/ImpactGlass[123]\.flac$/u.test(path)));
  assert.ok(requests.includes("/generated/audio/BlockPlaced.flac"));

  const lightning = {sequence: 17, position: {x: 2, y: 0, z: 0}, intensity: 0.8};
  audio.setEnvironment(weather({lightning}));
  audio.setEnvironment(weather({lightning}));
  await settleAudio();
  assert.equal(context.sources.length, 8, "one thunder recording plays per lightning event");
  assert.ok(requests.some(path => /^\/generated\/audio\/ThunderNear\/ThunderNear[12]\.flac$/u.test(path)));
  audio.setEnvironment(weather({lightning: {sequence: 18, position: {x: 100, y: 0, z: 0}, intensity: 0.8}}));
  audio.setEnvironment(weather({lightning: {sequence: 19, position: {x: 250, y: 0, z: 0}, intensity: 0.8}}));
  await settleAudio();
  assert.equal(context.sources.length, 9, "distant lightning outside hearing range stays silent");
  assert.ok(requests.some(path => /^\/generated\/audio\/ThunderFar\/ThunderFar[12]\.flac$/u.test(path)));

  assert.ok(Math.abs(context.sources.at(-1).when - (context.currentTime + 100 / 343)) < 0.001, "thunder follows sound travel time");
  audio.setEnvironment(weather({precipitation: "snow", windX: 12, windZ: 0}));
  assert.equal(context.gains[1].gain.value, 0, "snow does not play the rain recording");
  assert.ok(context.gains[0].gain.value > 0, "snow storm has its own soft wind bed");
  audio.setEnvironment(weather({precipitation: "none", windX: 0, windZ: 0}));
  assert.equal(context.gains[0].gain.value, 0, "calm air silences wind");

  document.visibilityState = "hidden";
  document.emit("visibilitychange");
  assert.equal(context.state, "suspended");
  assert.equal(context.gains[1].gain.value, 0);
  audio.play("place", "openvoxel:sound/wood");
  await settleAudio();
  assert.equal(context.sources.length, 9);

  await audio.close();
  assert.equal(context.state, "closed");
  assert.ok(context.sources.every(source => source.stopped));
  assert.equal(canvas.listeners.get("pointerdown").size, 0);
  assert.equal(document.listeners.get("visibilitychange").size, 0);
  canvas.emit("pointerdown");
  assert.equal(FakeContext.instances.length, 1);
});
