import {precipitationColumnOffsets, precipitationViewHalfHeight} from "./weather-columns.mjs";

const shaftSlots = 4;
const fieldCapacity = precipitationColumnOffsets().length * shaftSlots;
const profiles = Object.freeze({
  rain: Object.freeze({capacity: fieldCapacity, slotsPerColumn: shaftSlots, halfWidth: 0.02, halfHeight: 0.15, minSpeed: 8, maxSpeed: 12}),
  snow: Object.freeze({capacity: fieldCapacity, slotsPerColumn: shaftSlots, halfSize: 0.07, minSpeed: 0.5, maxSpeed: 3, textureSlots: 16}),
  splash: Object.freeze({capacity: 150}),
  snowSplash: Object.freeze({capacity: 100}),
});
const windResponse = Object.freeze({
  rain: Object.freeze({scale: 0.08, maximumSpeed: 2}),
  snow: Object.freeze({scale: 0.025, maximumSpeed: 0.75}),
});

export function precipitationParticleProfiles() {
  return profiles;
}

export function precipitationSkyLight(skyIntensity) {
  return 0.15 + 0.85 * Math.max(0, Math.min(1, skyIntensity));
}

export function precipitationTopFade(particleY, viewY) {
  return Math.max(0, Math.min(1, 0.6 * (viewY + precipitationViewHalfHeight - particleY)));
}

function between(random, minimum, maximum) {
  return minimum + random() * (maximum - minimum);
}

export function precipitationWindVelocity(kind, windX, windZ) {
  const response = windResponse[kind];
  if (response === undefined) throw new TypeError("Precipitation wind kind must be rain or snow");
  if (typeof windX !== "number" || !Number.isFinite(windX) || typeof windZ !== "number" || !Number.isFinite(windZ)) {
    throw new TypeError("Precipitation wind must be finite");
  }
  const magnitude = Math.hypot(windX, windZ);
  if (magnitude === 0) return {x: 0, z: 0};
  const scale = Math.min(response.scale, response.maximumSpeed / magnitude);
  return {x: windX * scale, z: windZ * scale};
}

function wrapColumnCoordinate(value, column) {
  const local = value - column;
  return column + local - Math.floor(local);
}

function emptySplash() {
  return {active: false, kind: "", x: 0, y: 0, z: 0, velocityY: 0, gravity: 0, halfSize: 0, startSize: 0, endSize: 0,
    duration: 0, remaining: 0, fadeFactor: 0, horizontal: false, slot: 0};
}

/** Surface-specific splash profiles share the falling flake's immutable slot. */
export function initializeWeatherSplash(particle, kind, contact, random = Math.random) {
  const water = contact.surface === "water";
  particle.active = true;
  particle.kind = kind;
  particle.x = contact.x;
  particle.y = contact.y + (kind === "rain" && water ? 0.05 : 0);
  particle.z = contact.z;
  particle.slot = contact.slot;
  particle.horizontal = kind === "snow" || water;
  particle.flipX = false;
  particle.flipY = false;
  particle.velocityY = kind === "rain" && !water ? between(random, 0.7, 0.9) : 0;
  particle.gravity = kind === "rain" && !water ? -10 : 0;
  if (kind === "snow") {
    particle.startSize = 0.07;
    particle.endSize = 0.07;
    particle.duration = water ? between(random, 0.2, 0.3) : between(random, 0.8, 1.2);
    particle.fadeFactor = 1;
  } else {
    particle.startSize = water ? 0.02 : 0.03;
    particle.endSize = water ? 0.09 : 0.08;
    particle.duration = water ? between(random, 0.3, 0.5) : between(random, 0.25, 0.3);
    particle.fadeFactor = water ? 1.6 : 2.8;
  }
  particle.halfSize = particle.startSize;
  particle.remaining = particle.duration;
  return particle;
}

export function advanceWeatherSplash(particle, seconds) {
  const dt = Math.max(0, Math.min(0.1, seconds));
  particle.y += particle.velocityY * dt;
  particle.velocityY = (particle.velocityY + particle.gravity * dt) * Math.pow(0.0005, dt);
  particle.remaining = Math.max(0, particle.remaining - dt);
  const progress = 1 - particle.remaining / particle.duration;
  particle.halfSize = particle.startSize + (particle.endSize - particle.startSize) * progress;
  particle.active = particle.remaining > 0;
  return particle;
}

/** Four fixed particles per shaft, with bounded recycled impact pools. */
export function createWeatherSimulation({random = Math.random} = {}) {
  const shafts = new Map();
  const rainSplashes = Array.from({length: profiles.splash.capacity}, emptySplash);
  const snowSplashes = Array.from({length: profiles.snowSplash.capacity}, emptySplash);
  let nextRainSplash = 0;
  let nextSnowSplash = 0;
  let rainSplashContacts = 0;
  let snowSplashContacts = 0;

  function addSplash(kind, particle, column) {
    if (kind === "rain" && random() >= 0.5) return;
    const pool = kind === "rain" ? rainSplashes : snowSplashes;
    const start = kind === "rain" ? nextRainSplash : nextSnowSplash;
    for (let offset = 0; offset < pool.length; offset += 1) {
      const index = (start + offset) % pool.length;
      if (pool[index].active) continue;
      initializeWeatherSplash(pool[index], kind, {
        x: particle.x,
        y: column.groundY + (kind === "snow" ? 0.03 : 0),
        z: particle.z,
        slot: particle.slot,
        surface: column.surface,
      }, random);
      if (kind === "rain") {
        nextRainSplash = (index + 1) % pool.length;
        rainSplashContacts += 1;
      } else {
        nextSnowSplash = (index + 1) % pool.length;
        snowSplashContacts += 1;
      }
      return;
    }
  }

  function createShaft(column, kind) {
    const profile = profiles[kind];
    return {
      kind,
      remainder: random(),
      lastViewY: null,
      particles: Array.from({length: shaftSlots}, () => ({
        active: false,
        x: column.x,
        y: 0,
        z: column.z,
        speed: between(random, profile.minSpeed, profile.maxSpeed),
        slot: Math.min(15, Math.floor(random() * 16)),
        halfSize: 0.07,
        horizontal: false,
      })),
    };
  }

  function place(particle, column, minimumY, maximumY, groundOffset) {
    particle.x = column.x + random();
    particle.y = between(random, minimumY, maximumY);
    particle.z = column.z + random();
    particle.active = particle.y >= column.groundY + groundOffset;
  }

  return {
    shafts,
    rainSplashes,
    snowSplashes,
    stats: () => ({rainSplashContacts, snowSplashContacts}),
    invalidateChunkColumn(chunkX, chunkZ, chunkEdge) {
      for (const [key, shaft] of shafts) {
        const particle = shaft.particles[0];
        if (Math.floor(particle.x / chunkEdge) === chunkX && Math.floor(particle.z / chunkEdge) === chunkZ) shafts.delete(key);
      }
      for (const pool of [rainSplashes, snowSplashes]) {
        for (const particle of pool) {
          if (Math.floor(particle.x / chunkEdge) === chunkX && Math.floor(particle.z / chunkEdge) === chunkZ) particle.active = false;
        }
      }
    },
    update(deltaMs, center, columns, kind, intensity, windX = 0, windZ = 0) {
      const dt = Math.max(0, Math.min(0.1, deltaMs / 1_000));
      const desired = new Set();
      const bottom = center.y - precipitationViewHalfHeight;
      const top = center.y + precipitationViewHalfHeight;
      for (const pool of [rainSplashes, snowSplashes]) {
        for (const particle of pool) {
          if (!particle.active) continue;
          advanceWeatherSplash(particle, dt);
          if (particle.kind === "rain") {
            particle.flipX = random() < 0.5;
            particle.flipY = random() < 0.5;
          }
        }
      }
      for (const column of columns) {
        const key = column.x + ":" + column.z;
        desired.add(key);
        let shaft = shafts.get(key);
        if (kind !== "none" && (shaft === undefined || shaft.kind !== kind)) {
          shaft = createShaft(column, kind);
          shafts.set(key, shaft);
        }
        if (shaft === undefined) continue;
        if (shaft.lastViewY !== null && Math.abs(center.y - shaft.lastViewY) >= precipitationViewHalfHeight * 2) {
          // Disjoint view-height windows have no live particles to carry over.
          // Retain the fixed slots, but release them before allocating the
          // newly visible density so teleporting does not starve the shaft.
          for (const particle of shaft.particles) particle.active = false;
          shaft.lastViewY = null;
        }
        const profile = profiles[shaft.kind];
        const wind = precipitationWindVelocity(shaft.kind, windX, windZ);
        const averageSpeed = (profile.minSpeed + profile.maxSpeed) / 2;
        const density = kind === shaft.kind ? intensity : 0;
        const groundOffset = shaft.kind === "snow" ? 0.03 : 0;
        const newlyVisibleBottom = shaft.lastViewY === null || center.y < shaft.lastViewY ? bottom : Math.min(top, shaft.lastViewY + precipitationViewHalfHeight);
        const newlyVisibleTop = shaft.lastViewY === null || center.y >= shaft.lastViewY ? top : Math.max(bottom, shaft.lastViewY - precipitationViewHalfHeight);
        const initialCount = Math.max(0, newlyVisibleTop - newlyVisibleBottom) / (precipitationViewHalfHeight * 2) * shaftSlots * density;
        let toInitialize = Math.floor(initialCount) + (random() < initialCount % 1 ? 1 : 0);
        shaft.lastViewY = center.y;
        shaft.remainder += shaftSlots * density / (precipitationViewHalfHeight * 2) * averageSpeed * dt;
        for (const particle of shaft.particles) {
          if (particle.active) {
            particle.x = wrapColumnCoordinate(particle.x + wind.x * dt, column.x);
            particle.y -= particle.speed * dt;
            particle.z = wrapColumnCoordinate(particle.z + wind.z * dt, column.z);
            if (particle.y <= column.groundY + groundOffset) {
              addSplash(shaft.kind, particle, column);
              particle.active = false;
            } else if (particle.y < bottom || particle.y > top) {
              particle.active = false;
            }
          } else if (toInitialize > 0) {
            place(particle, column, newlyVisibleBottom, newlyVisibleTop, groundOffset);
            toInitialize -= 1;
          } else if (shaft.remainder >= 1) {
            place(particle, column, top - averageSpeed * dt, top, groundOffset);
            shaft.remainder -= 1;
          }
        }
        shaft.remainder %= 1;
        if (density === 0 && shaft.particles.every((particle) => !particle.active)) shafts.delete(key);
      }
      for (const key of shafts.keys()) {
        if (!desired.has(key)) shafts.delete(key);
      }
    },
    reset() {
      shafts.clear();
      rainSplashContacts = 0;
      snowSplashContacts = 0;
      for (const pool of [rainSplashes, snowSplashes]) {
        for (const particle of pool) particle.active = false;
      }
    },
  };
}
