const clamp = value => Math.max(0, Math.min(1, value));

// The same slow front and smaller gusts drive foliage, airborne particles,
// water and sound. Coordinates are continuous across chunk boundaries.
export function windGust(seconds, x = 0, z = 0) {
  const front = seconds * 0.7 - x * 0.045 - z * 0.031;
  return 0.78 + 0.28 * Math.sin(front) + 0.12 * Math.sin(front * 2.17 + 1.3);
}

export const windGustShader = `
float ovWindGust(float seconds, vec2 p) {
  float front = seconds * 0.7 - dot(p, vec2(0.045, 0.031));
  return 0.78 + 0.28 * sin(front) + 0.12 * sin(front * 2.17 + 1.3);
}`;

/** Continuous profiles; named levels are diagnostics, never hard visual steps. */
export function weatherProfile(kind, intensity, windSpeed = 0) {
  const strength = kind === "none" ? 0 : clamp(intensity);
  const storm = clamp((strength - 0.65) / 0.35) * clamp(windSpeed / 10);
  return {
    level: strength <= 0 ? "none" : strength < 0.25 ? "light" : strength < 0.6 ? "moderate" : strength < 0.85 ? "heavy" : "storm",
    strength,
    storm,
    rainWidth: 0.005 + strength * 0.005,
    rainLength: 0.07 + strength * 0.11,
    rainSpeed: 0.72 + strength * 0.28,
    opacity: kind === "rain" ? 0.28 + strength * 0.3 : 0.68 + strength * 0.17,
    snowSize: 0.028 + strength * 0.027,
    snowFlutter: 0.12 + storm * 0.3,
  };
}

export function weatherAudioLevels(sample, position = {x: 0, z: 0}) {
  const wind = Math.hypot(sample?.windX ?? 0, sample?.windZ ?? 0);
  const kind = sample?.precipitation ?? "none";
  const strength = weatherProfile(kind, sample?.precipitationIntensity ?? 0, wind).strength;
  const gust = windGust((sample?.worldMilliseconds ?? 0) / 1000, position.x, position.z);
  const snow = kind === "snow" ? strength : 0;
  return {
    rain: kind === "rain" ? 0.35 * Math.pow(strength, 0.85) : 0,
    wind: Math.min(0.22, Math.pow(clamp(wind / 16), 1.6) * 0.16 * gust + snow * 0.014),
    windCutoff: 450 + clamp(wind / 16) * 1600 + snow * 260,
    // Snow absorbs the sharper part of outdoor ambience. Footsteps still use
    // the original snow recordings; calm snowfall itself stays very quiet.
    water: 1 - snow * 0.32,
  };
}
