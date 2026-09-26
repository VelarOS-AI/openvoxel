import {windGust} from "../../../environment/weather-dynamics.mjs";
import {climateTintColor, leafDropIntensity} from "./climate-tint.mjs";

export const leafParticleCapacity = 96;
const radius = 24;
const isDeciduous = role => role === 2 || role === 8 || role === 9;
const distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

// Only exposed undersides emit, so leaves start outside the crown. Called once
// at mesh upload; neither terrain scanning nor emitter allocation occurs per frame.
export function collectLeafEmitters(positions, normals, roles, origin) {
  const candidates = [];
  for (let vertex = 0; vertex < roles.length; vertex += 4) {
    if (!isDeciduous(roles[vertex]) || normals[vertex * 3 + 1] > -0.5) continue;
    const xs = [], zs = [];
    for (let corner = 0; corner < 4; corner += 1) {
      xs.push(positions[(vertex + corner) * 3]);
      zs.push(positions[(vertex + corner) * 3 + 2]);
    }
    const lowX = Math.min(...xs), highX = Math.max(...xs);
    const lowZ = Math.min(...zs), highZ = Math.max(...zs);
    candidates.push({x: origin.x + (lowX + highX) / 2, y: origin.y + positions[vertex * 3 + 1] - 0.04,
      z: origin.z + (lowZ + highZ) / 2, width: highX - lowX, depth: highZ - lowZ, role: roles[vertex]});
  }
  // Even sampling retains several crowns without favouring a mesh's first rows.
  if (candidates.length <= 32) return candidates;
  return Array.from({length: 32}, (_, index) => candidates[Math.floor(index * candidates.length / 32)]);
}

export function createLeafSimulation(edge, climateAt, groundAt, random = Math.random) {
  const columns = new Map();
  const owners = new Map();
  const particles = Array.from({length: leafParticleCapacity}, () => ({active: false}));
  let nearby = [], refresh = 0, emission = 0, lastCenter = null, probeCursor = 0;
  let sampledGround = 0, timeSeconds = 0;
  let sourceWorldMilliseconds = null;
  const remove = owner => {
    const key = owners.get(owner);
    if (key === undefined) return;
    const entries = columns.get(key);
    entries.delete(owner);
    if (entries.size === 0) columns.delete(key);
    owners.delete(owner);
    nearby = nearby.filter(source => source.owner !== owner);
    for (const particle of particles) if (particle.owner === owner) particle.active = false;
    refresh = 0;
  };
  return {
    particles,
    register(owner, x, z, emitters) {
      remove(owner);
      if (emitters.length === 0) return;
      const key = `${x}:${z}`;
      if (!columns.has(key)) columns.set(key, new Map());
      columns.get(key).set(owner, emitters.map(source => ({...source, owner})));
      owners.set(owner, key);
      refresh = 0;
    },
    remove,
    update(deltaMs, center, frame) {
      const dt = Math.min(0.1, Math.max(0, deltaMs / 1000));
      sampledGround = 0;
      if (Number.isFinite(frame.worldMilliseconds) && frame.worldMilliseconds !== sourceWorldMilliseconds) {
        sourceWorldMilliseconds = frame.worldMilliseconds;
        timeSeconds = frame.worldMilliseconds / 1000;
      } else timeSeconds += dt;
      const gust = windGust(timeSeconds, center.x, center.z);
      const windSpeed = Math.hypot(frame.windX, frame.windZ) * gust;
      refresh -= dt;
      if (refresh <= 0 || lastCenter === null || distanceSquared(center, lastCenter) > 16) {
        nearby = [];
        const cx = Math.floor(center.x / edge), cz = Math.floor(center.z / edge);
        const reach = Math.ceil(radius / edge);
        for (let dz = -reach; dz <= reach; dz += 1) for (let dx = -reach; dx <= reach; dx += 1) {
          const entries = columns.get(`${cx + dx}:${cz + dz}`);
          if (entries === undefined) continue;
          for (const sources of entries.values()) for (const source of sources) {
            if (distanceSquared(center, source) <= radius ** 2) nearby.push(source);
          }
        }
        lastCenter = {...center};
        refresh = 0.5;
      }
      // A fixed attempt rate and pool cap are independent of forest/chunk size.
      emission = Math.min(1, emission + dt * Math.min(10, 3 + windSpeed * 0.5));
      if (emission >= 1 && nearby.length > 0) {
        emission -= 1;
        const source = nearby[Math.min(nearby.length - 1, Math.floor(random() * nearby.length))];
        const climate = climateAt(source);
        if (random() < leafDropIntensity(source.role, climate[2], source)) {
          const particle = particles.find(candidate => !candidate.active);
          if (particle !== undefined) Object.assign(particle, {
            active: true, owner: source.owner, x: source.x + (random() - 0.5) * source.width * 0.8,
            y: source.y, z: source.z + (random() - 0.5) * source.depth * 0.8,
            age: 0, remaining: 12, halfSize: 0.135 + random() * 0.045,
            speed: 1.5 + random() * 2, angle: random() * Math.PI * 2,
            spin: (random() - 0.5) * 5, phase: random() * Math.PI * 2,
            color: climateTintColor(source.role, climate, source), horizontal: false,
            ground: null, probeDue: 0, fade: 1,
          });
        }
      }
      for (const particle of particles) {
        if (!particle.active) continue;
        particle.remaining -= dt;
        particle.age += dt;
        if (particle.remaining <= 0 || distanceSquared(particle, center) > (radius + 8) ** 2) { particle.active = false; continue; }
        if (particle.horizontal) { particle.fade = Math.min(1, particle.remaining / 2); continue; }
        particle.angle += particle.spin * dt;
        particle.x += (Math.sin(particle.age * 4 + particle.phase) * 0.65 + frame.windX * gust * 0.16) * dt;
        particle.z += (Math.cos(particle.age * 3 + particle.phase) * 0.65 + frame.windZ * gust * 0.16) * dt;
        particle.y -= (0.8 * particle.speed + 0.25 * Math.sin(particle.age * 6 + particle.phase)) * dt;
        particle.probeDue -= dt;
        // Cell crossing invalidates the old landing height before collision.
        if (Math.floor(particle.x) !== particle.groundX || Math.floor(particle.z) !== particle.groundZ) particle.ground = null;
      }
      // Round-robin collision sampling keeps worst-case raycasts bounded.
      for (let index = 0; index < particles.length && sampledGround < 8; index += 1) {
        const particle = particles[probeCursor];
        probeCursor = (probeCursor + 1) % particles.length;
        if (!particle.active || particle.horizontal || (particle.probeDue > 0 && particle.ground !== null)) continue;
        particle.groundX = Math.floor(particle.x);
        particle.groundZ = Math.floor(particle.z);
        particle.ground = groundAt(particle.groundX, particle.groundZ, Math.ceil(particle.y + 1));
        particle.probeDue = 0.25;
        sampledGround += 1;
      }
      for (const particle of particles) {
        if (!particle.active || particle.horizontal || particle.ground === null) continue;
        if (particle.y <= particle.ground.groundY + 0.03) {
          if (particle.ground.surface === "water") particle.active = false;
          else {
            particle.y = particle.ground.groundY + 0.03;
            particle.horizontal = true;
            particle.remaining = Math.min(particle.remaining, 2);
          }
        }
      }
    },
    stats() { return {active: particles.filter(p => p.active).length, nearbyEmitters: nearby.length, ownedMeshes: owners.size, sampledGround, capacity: leafParticleCapacity}; },
    clear() {
      owners.clear(); columns.clear(); nearby = []; lastCenter = null; refresh = 0; emission = 0;
      for (const particle of particles) particle.active = false;
    },
  };
}
