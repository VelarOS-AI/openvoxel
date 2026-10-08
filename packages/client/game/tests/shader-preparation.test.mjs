import assert from "node:assert/strict";
import test from "node:test";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {ShaderPreparationQueue, createStreamingEffect} from "../src/backends/babylon/native/shader-preparation.mjs";

function fixture() {
  const frames = new Map();
  let next = 0;
  const queue = new ShaderPreparationQueue(callback => { frames.set(++next, callback); return next; }, id => frames.delete(id));
  return {queue, frames, tick() { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(); }};
}

test("new shaders prepare at most once per frame while obsolete requests do not starve live work", async () => {
  const {queue, frames, tick} = fixture();
  const completed = [];
  queue.wait(() => true).then(value => completed.push(["first", value]));
  queue.wait(() => false).then(value => completed.push(["obsolete", value]));
  queue.wait(() => true).then(value => completed.push(["second", value]));
  assert.equal(frames.size, 1);
  tick();
  await Promise.resolve();
  assert.deepEqual(completed, [["first", true]]);
  tick();
  await Promise.resolve();
  assert.deepEqual(completed, [["first", true], ["obsolete", false], ["second", true]]);
  assert.equal(frames.size, 0);
  queue.close();
});

test("closing an engine settles queued preparations without leaving frame callbacks or compile work", async () => {
  const {queue, frames} = fixture();
  const pending = [queue.wait(() => true), queue.wait(() => true)];
  queue.close();
  queue.close();
  assert.deepEqual(await Promise.all(pending), [false, false]);
  assert.equal(frames.size, 0);
  assert.equal(queue.pending.size, 0);
  assert.equal(await queue.wait(() => true), false);
});

test("the engine effect cache shares references and shutdown cancels pending shader initialization", async () => {
  const engine = new NullEngine();
  const frames = new Map();
  let next = 0, compiled = 0, failed = 0;
  engine.getHostWindow = () => ({
    requestAnimationFrame: callback => { frames.set(++next, callback); return next; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  const shader = {vertexSource: "void main(void) { gl_Position = vec4(0.0); }", fragmentSource: "void main(void) { gl_FragColor = vec4(1.0); }"};
  const options = {attributes: [], uniformsNames: [], samplers: [], defines: "",
    onCompiled: () => compiled++, onError: () => failed++};
  const effect = createStreamingEffect(engine, shader, options);
  const references = effect._refCount;
  assert.equal(createStreamingEffect(engine, shader, options), effect);
  assert.equal(effect._refCount, references + 1);
  assert.equal(frames.size, 1);
  let initialize;
  createStreamingEffect(engine, shader, {...options, defines: "#define OTHER", extraInitializationsAsync: () => new Promise(resolve => { initialize = resolve; })});
  engine.dispose();
  initialize();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.size, 0);
  assert.equal(compiled, 0);
  assert.equal(failed, 0, "shutdown is cancellation, not a late GPU compile error");
});
