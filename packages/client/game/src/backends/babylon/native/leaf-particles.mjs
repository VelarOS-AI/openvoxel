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
      if (this.enabled === false) { batch.reset(); batch.upload(); return; }
      simulation.update(deltaMs, center, frame);
      batch.reset();
      const light = precipitationSkyLight(frame.daylightIntensity);
      for (const particle of simulation.particles) {
        if (!particle.active) continue;
        const tilt = 0.3 + Math.sin(particle.age * 4 + particle.phase) * 0.9;
        const cos = Math.cos(particle.angle), sin = Math.sin(particle.angle);
        const cosTilt = Math.cos(tilt);
        axes.right.x = cos; axes.right.y = 0; axes.right.z = sin;
        axes.up.x = -sin * cosTilt; axes.up.y = Math.sin(tilt); axes.up.z = cos * cosTilt;
        batch.append(particle, axes, light, particle.fade);
      }
      batch.upload();
    },
    dispose() { simulation.clear(); batch.dispose(); },
  };
}
