import assert from "node:assert/strict";
import test from "node:test";
import {ShaderCompiler} from "../src/backends/babylon/native/shader-compiler.mjs";

class WorkerStub {
  messages = [];
  terminations = 0;
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminations++; }
  answer(id, result) { this.onmessage({data: {id, ...result}}); }
}

test("shader conversion matches asynchronous replies and reports compile errors", async () => {
  const compiler = new ShaderCompiler("local-compiler.js", WorkerStub);
  const first = compiler.request({vertex: "a"});
  const second = compiler.request({vertex: "b"});
  compiler.worker.answer(2, {vertex: "wgsl-b"});
  assert.equal((await second).vertex, "wgsl-b");
  compiler.worker.answer(1, {error: "invalid shader"});
  await assert.rejects(first, /invalid shader/);
  assert.equal(compiler.pending.size, 0);
  compiler.dispose();
});

test("worker failure and world exit settle every pending request and terminate once", async () => {
  for (const failure of [false, true]) {
    const compiler = new ShaderCompiler("local-compiler.js", WorkerStub);
    const pending = Promise.allSettled([compiler.request({}), compiler.request({})]);
    if (failure) compiler.worker.onerror({message: "worker crashed"});
    else compiler.dispose();
    compiler.dispose();
    assert.ok((await pending).every(value => value.status === "rejected"));
    assert.equal(compiler.pending.size, 0);
    assert.equal(compiler.worker.terminations, 1);
    await assert.rejects(compiler.request({}), /closed/);
  }
});
