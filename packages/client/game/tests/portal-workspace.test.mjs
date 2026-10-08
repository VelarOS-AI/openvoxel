import assert from "node:assert/strict";
import test from "node:test";
import {createPortalVisibilityWorkspace} from "../src/runtime/native/portal-visibility.mjs";

const key = p => `${p.x}:${p.y}:${p.z}`;
const directions = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
const solid = {empty: false, fullyOccluding: true, openFaces: 0, connectedFaces: 0};

test("demand revisions follow visible membership and topology, not every portal mask update", () => {
  const workspace = createPortalVisibilityWorkspace();
  const positions = Array.from({length: 5}, (_, z) => ({x: 0, y: 0, z}));
  const walls = new Map();
  workspace.rebuild(positions, positions[0]);
  assert.equal(workspace.visibleChunkKeys(walls).size, 5);
  const openRevision = workspace.revision();
  walls.set(key(positions[4]), solid);
  assert.equal(workspace.visibleChunkKeys(walls).size, 5);
  assert.equal(workspace.revision(), openRevision, "terminal wall changes no demanded chunk");
  walls.set(key(positions[2]), solid);
  assert.deepEqual([...workspace.visibleChunkKeys(walls)], positions.slice(0, 3).map(key));
  assert.ok(workspace.revision() > openRevision);
  const closedRevision = workspace.revision();
  workspace.visibleChunkKeys(walls);
  assert.equal(workspace.revision(), closedRevision);
  walls.delete(key(positions[2]));
  assert.equal(workspace.visibleChunkKeys(walls).size, 5);
  assert.ok(workspace.revision() > closedRevision);
  const restoredRevision = workspace.revision();
  workspace.rebuild(positions, positions[4]);
  assert.ok(workspace.revision() > restoredRevision, "camera/topology changes must revisit cache policy");
});
function reference(positions, center, walls) {
  const cells = new Map(positions.map(p => [key(p), p]));
  if (!cells.has(key(center))) return new Set(cells.keys());
  const flood = stopAtWalls => {
    const visited = new Set([key(center)]), queue = [center];
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      if (stopAtWalls && walls.has(key(p))) continue;
      for (const [x, y, z] of directions) {
        const next = cells.get(key({x: p.x + x, y: p.y + y, z: p.z + z}));
        if (next && !visited.has(key(next))) { visited.add(key(next)); queue.push(next); }
      }
    }
    return visited;
  };
  const connected = flood(false), visible = flood(true);
  for (const k of cells.keys()) if (!connected.has(k)) visible.add(k);
  return visible;
}

test("reused dense and sparse adjacency matches a coordinate flood through holes, walls and duplicates", () => {
  const workspace = createPortalVisibilityWorkspace();
  let seed = 93;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let run = 0; run < 80; run++) {
    const positions = [], walls = new Map(), radius = 1 + run % 6;
    for (let x = -radius; x <= radius; x++) for (let y = -2; y <= 2; y++) for (let z = -radius; z <= radius; z++) {
      if (random() < .2) continue;
      const p = {x: x - 100, y, z: z + 100}; positions.push(p);
      if (random() < .25) walls.set(key(p), solid);
      if (random() < .1) positions.push(p);
    }
    if (run % 2) positions.push({x: 33_000_000, y: -33_000_000, z: 33_000_000});
    const center = run % 7 ? positions[0] : {x: 0, y: 0, z: 0};
    workspace.rebuild(positions, center);
    assert.deepEqual(workspace.visibleChunkKeys(walls), reference(positions, center, walls));
    workspace.rebuild([], center);
    assert.equal(workspace.visibleChunkKeys(walls).size, 0);
  }
});
