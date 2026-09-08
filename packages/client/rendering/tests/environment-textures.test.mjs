import assert from "node:assert/strict";
import test from "node:test";
import {Texture} from "@babylonjs/core/Materials/Textures/texture.js";
import {loadEnvironmentTextures} from "../src/native/babylon/environment-textures.mjs";

function fixture() {
  const requests = [];
  const resources = {
    sky: {sunDataUrl: "sun", glowDataUrl: "glow", starDataUrl: "star", moonDataUrls: Array.from({length: 8}, (_, index) => "moon" + index)},
    clouds: {textureDataUrl: "clouds"},
    precipitation: {rainDataUrl: "rain", rainSplashDataUrl: "splash", snowDataUrl: "snow"},
  };
  const factory = (_scene, url, sampling, loaded, failed) => {
    const request = {url, sampling, loaded, failed, disposed: 0};
    request.dispose = () => { request.disposed += 1; };
    requests.push(request);
    return request;
  };
  return {resources, factory, requests};
}

test("environment images keep the source sampling contract and one owner per texture", async () => {
  const {resources, factory, requests} = fixture();
  const pending = loadEnvironmentTextures(null, resources, factory);
  assert.equal(requests.length, 15);
  assert.ok(requests.slice(0, 12).every((request) => request.sampling === Texture.BILINEAR_SAMPLINGMODE));
  assert.ok(requests.slice(12).every((request) => request.sampling === Texture.NEAREST_SAMPLINGMODE));
  for (const request of requests) request.loaded();
  const textures = await pending;
  assert.equal(textures.sun.url, "sun");
  assert.equal(textures.clouds.url, "clouds");
  assert.deepEqual(textures.moons.map((texture) => texture.url), resources.sky.moonDataUrls);
  assert.equal(textures.rainSplash.url, "splash");
  textures.dispose();
  textures.dispose();
  assert.ok(requests.every((request) => request.disposed === 1));
});

test("one failed environment image releases completed and pending siblings", async () => {
  const {resources, factory, requests} = fixture();
  const pending = loadEnvironmentTextures(null, resources, factory);
  requests[0].loaded();
  requests[5].failed("moon decode failed");
  await assert.rejects(pending, /moon decode failed/);
  assert.ok(requests.every((request) => request.disposed === 1));
  for (const request of requests) request.loaded();
  await Promise.resolve();
  assert.ok(requests.every((request) => request.disposed === 1), "late callbacks cannot reacquire or release ownership twice");
});

test("texture cleanup continues after a sibling disposer fails", async () => {
  const {resources, factory, requests} = fixture();
  const pending = loadEnvironmentTextures(null, resources, factory);
  for (const request of requests) request.loaded();
  const textures = await pending;
  requests[7].dispose = () => { requests[7].disposed += 1; throw new Error("cleanup failure"); };
  assert.throws(() => textures.dispose(), AggregateError);
  assert.ok(requests.every((request) => request.disposed === 1));
  textures.dispose();
});
