// Count completed game renders, not a second animation loop or a clamped
// simulation delta. Publish only four times a second to keep HUD work bounded.
export class FrameStatistics {
  constructor(publish = () => {}) {
    this.publish = publish;
    this.previous = null;
    this.elapsed = 0;
    this.frames = 0;
  }

  sample(now, visible = true) {
    const previous = this.previous;
    this.previous = visible ? now : null;
    if (!visible || previous === null) {
      this.elapsed = 0;
      this.frames = 0;
      return;
    }
    this.elapsed += Math.max(0, now - previous);
    this.frames++;
    if (this.elapsed < 250) return;
    this.publish(Math.round(this.frames * 1000 / this.elapsed), Math.round(this.elapsed / this.frames * 10) / 10);
    this.elapsed = 0;
    this.frames = 0;
  }
}
