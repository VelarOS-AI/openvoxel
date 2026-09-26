import {configurePointClampTexture} from "./weather-particles.mjs";
import {createWeatherParticleBatch} from "./weather-particle-batch.mjs";
import {precipitationSkyLight} from "./weather-simulation.mjs";
import {createLeafSimulation, leafParticleCapacity} from "./leaf-simulation.mjs";

export function createLeafParticles(scene, texture, edge, climateAt, groundAt) {
  const simulation = createLeafSimulation(edge, climateAt, groundAt);
  const batch = createWeatherParticleBatch(scene, configurePointClampTexture(texture), "leaf", leafParticleCapacity);
  const axes = {right: {x: 1, y: 0, z: 0}, up: {x: 0, y: 1, z: 0}};
  return {
    register: simulation.register,
    remove: simulation.remove,
    stats: simulation.stats,
    update(deltaMs, center, frame) {
      simulation.update(deltaMs, center, frame);
      batch.reset();
      const light = precipitationSkyLight(frame.daylightIntensity);
      for (const particle of simulation.particles) {
        if (!particle.active) continue;
        const tilt = 0.3 + Math.sin(particle.age * 4 + particle.phase) * 0.9;
        const cos = Math.cos(particle.angle), sin = Math.sin(particle.angle);
        Object.assign(axes.right, {x: cos, y: 0, z: sin});
        Object.assign(axes.up, {x: -sin * Math.cos(tilt), y: Math.sin(tilt), z: cos * Math.cos(tilt)});
        batch.append(particle, axes, light, particle.fade);
      }
      batch.upload();
    },
    dispose() { simulation.clear(); batch.dispose(); },
  };
}
