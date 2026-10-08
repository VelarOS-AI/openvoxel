import assert from "node:assert/strict";
import test from "node:test";
import {
  LatestFrameWorkQueue,
  TranslucentSortScheduler,
  WeatherColumnInvalidationScheduler,
} from "../src/backends/babylon/native/surface-work-scheduler.mjs";

test("a single-item drain commits the latest value for one queued Chunk", async () => {
  const committed = [];
  const queue = new LatestFrameWorkQueue((value) => committed.push(value));
  const first = queue.enqueue("0:0:0", "old");
  const replacement = queue.enqueue("0:0:0", "new");
  const second = queue.enqueue("1:0:0", "second");

  assert.equal(queue.size, 2);
  assert.equal(queue.drainOne(), true);
  assert.deepEqual(committed, ["new"]);
  assert.equal(queue.size, 1);
  assert.deepEqual(await Promise.all([first, replacement]), [true, true]);

  assert.equal(queue.drainOne(), true);
  assert.equal(await second, true);
  assert.deepEqual(committed, ["new", "second"]);
  assert.equal(queue.drainOne(), false);
});

test("pending Chunk uploads can be cancelled without crossing the commit boundary", async () => {
  const committed = [];
  const queue = new LatestFrameWorkQueue((value) => committed.push(value));
  const cancelled = queue.enqueue("0:0:0", "cancelled");
  const cleared = queue.enqueue("1:0:0", "cleared");

  assert.equal(queue.cancel("0:0:0"), true);
  queue.clear();
  assert.deepEqual(await Promise.all([cancelled, cleared]), [false, false]);
  assert.equal(queue.size, 0);
  assert.equal(queue.drainOne(), false);
  assert.deepEqual(committed, []);
});

test("GPU uploads recheck validity on the commit frame, keeping the previous mesh when stale", async () => {
  let visible = "existing";
  let current = true;
  const queue = new LatestFrameWorkQueue(value => { visible = value; });
  const stale = queue.enqueue("chunk", "stale", () => current);
  current = false;
  queue.drainOne();
  assert.equal(await stale, false);
  assert.equal(visible, "existing");
  const fresh = queue.enqueue("chunk", "latest", () => true);
  queue.drainOne();
  assert.equal(await fresh, true);
  assert.equal(visible, "latest");
});

test("re-enqueue after cancellation does not reuse the cancelled queue slot", async () => {
  const committed = [];
  const queue = new LatestFrameWorkQueue((value) => committed.push(value));
  const cancelled = queue.enqueue("0:0:0", "cancelled");
  assert.equal(queue.cancel("0:0:0"), true);
  const live = queue.enqueue("0:0:0", "live");

  assert.equal(queue.drainOne(), true);
  assert.deepEqual(await Promise.all([cancelled, live]), [false, true]);
  assert.deepEqual(committed, ["live"]);
});

test("weather column invalidation coalesces a vertical-section burst with a bounded flush", () => {
  const flushed = [];
  const scheduler = new WeatherColumnInvalidationScheduler(
    (x, z) => flushed.push({x, z}),
    {settleMilliseconds: 32, maximumDelayMilliseconds: 64},
  );

  scheduler.invalidate(-2, 3);
  for (let frame = 0; frame < 3; frame += 1) {
    scheduler.advance(16);
    scheduler.invalidate(-2, 3);
    assert.equal(scheduler.flushReady(), 0);
  }
  scheduler.advance(16);
  scheduler.invalidate(-2, 3);
  assert.equal(scheduler.flushReady(), 1, "continuous section arrivals must flush at the maximum delay");
  assert.deepEqual(flushed, [{x: -2, z: 3}]);
  assert.equal(scheduler.size, 0);
});

test("weather column invalidation flushes each unique column once and can discard released work", () => {
  const flushed = [];
  const scheduler = new WeatherColumnInvalidationScheduler((x, z) => flushed.push({x, z}));
  scheduler.invalidate(0, 0);
  scheduler.invalidate(0, 0);
  scheduler.invalidate(-1, 2);

  assert.equal(scheduler.flush(), 2);
  assert.deepEqual(flushed, [{x: 0, z: 0}, {x: -1, z: 2}]);
  scheduler.invalidate(8, 9);
  scheduler.clear();
  scheduler.advance(1_000);
  assert.equal(scheduler.flushReady(), 0);
  assert.equal(scheduler.size, 0);
});

test("translucent facet sorting is near-first, bounded, and keeps an unfinished pass while moving", () => {
  const near = {position: {x: 1, y: 0, z: 0}};
  const middle = {position: {x: 3, y: 0, z: 0}};
  const far = {position: {x: 20, y: 0, z: 0}};
  const scheduler = new TranslucentSortScheduler({
    positionFor: (item) => item.position,
    maximumDistance: 8,
    movementDistance: 1,
    refreshIntervalMs: 80,
  });
  scheduler.add(middle);
  scheduler.add(far);
  scheduler.add(near);

  assert.equal(scheduler.next({x: 0, y: 0, z: 0}, 80), near);
  assert.equal(scheduler.size, 1);
  // Moving far enough requests another pass, but does not throw away middle
  // from the pass that is already underway.
  assert.equal(scheduler.next({x: 18, y: 0, z: 0}, 80), middle);
  assert.equal(scheduler.size, 0);
  assert.equal(scheduler.next({x: 18, y: 0, z: 0}, 80), far);
});

test("translucent scheduler removes disposed meshes from pending work", () => {
  const mesh = {position: {x: 0, y: 0, z: 0}};
  const scheduler = new TranslucentSortScheduler({positionFor: (item) => item.position, maximumDistance: 8});
  scheduler.add(mesh);
  assert.equal(scheduler.next({x: 0, y: 0, z: 0}, 80), mesh);
  scheduler.add(mesh);
  assert.equal(scheduler.next({x: 0, y: 0, z: 0}, 80), mesh);
  scheduler.add(mesh);
  assert.equal(scheduler.delete(mesh), true);
  assert.equal(scheduler.size, 0);
  assert.equal(scheduler.next({x: 0, y: 0, z: 0}, 80), null);
});

test("frame uploads share cheap work but stop at the elapsed time or item budget", async () => {
  let clock = 0;
  const committed = [];
  const queue = new LatestFrameWorkQueue(cost => { committed.push(cost); clock += cost; });
  const jobs = [0.4, 0.4, 1.4, 5, 0.1, 0.1].map((cost, index) => queue.enqueue(String(index), cost));
  assert.equal(queue.drainFrame(2, 4, () => clock), 3);
  assert.deepEqual(committed, [0.4, 0.4, 1.4]);
  assert.equal(queue.size, 3);
  assert.equal(queue.drainFrame(2, 4, () => clock), 1, "one expensive upload still yields before the next item");
  assert.equal(queue.drainFrame(2, 1, () => clock), 1, "the count limit also bounds zero-cost work");
  assert.equal(queue.drainFrame(2, 4, () => clock), 1);
  assert.equal(queue.drainFrame(2, 4, () => clock), 0);
  assert.deepEqual(await Promise.all(jobs), [true, true, true, true, true, true]);
});
