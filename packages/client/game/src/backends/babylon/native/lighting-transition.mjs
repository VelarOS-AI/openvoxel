const scalars = ["daylightIntensity", "skyIntensity", "sunIntensity", "moonIntensity"];
const colors = ["skyTop", "horizon", "ground", "fog"];

/** Smooth authoritative lighting samples without changing the world clock or
 * postponing weather/lightning events. Exponential easing is frame-rate neutral. */
export class LightingTransition {
  constructor(frame) {
    this.target = frame;
    this.frame = {...frame};
    for (const name of colors) this.frame[name] = frame[name].clone();
    this.pending = false;
  }
  apply(frame) {
    this.target = frame;
    this.pending = true;
    for (const key of Object.keys(frame)) if (!scalars.includes(key) && !colors.includes(key)) this.frame[key] = frame[key];
  }
  advance(deltaMs) {
    if (!this.pending || deltaMs <= 0) return false;
    const weight = 1 - Math.exp(-deltaMs / 180);
    let remaining = 0;
    const ease = (current, target) => {
      const next = Math.abs(current - target) < 0.00001 ? target : current + (target - current) * weight;
      remaining = Math.max(remaining, Math.abs(next - target));
      return next;
    };
    for (const key of scalars) this.frame[key] = ease(this.frame[key], this.target[key]);
    for (const key of colors) for (const channel of ["r", "g", "b"]) this.frame[key][channel] = ease(this.frame[key][channel], this.target[key][channel]);
    this.pending = remaining > 0;
    return true;
  }
}
