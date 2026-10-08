// Presentation waits for the authoritative light field, then enables the
// complete chunk at once. Retention/hysteresis belongs to the stream owner.
export class ChunkPresentation {
  constructor(ready = () => true) {
    this.ready = ready;
    this.waiting = new Map();
  }
  show(key, meshes) {
    this.waiting.delete(key);
    const ready = this.ready(key);
    for (const mesh of meshes) mesh.setEnabled(ready);
    if (!ready && meshes.length) this.waiting.set(key, meshes);
  }
  remove(key) { this.waiting.delete(key); }
  update() {
    let shadowsChanged = false;
    for (const [key, meshes] of this.waiting) {
      if (!this.ready(key)) continue;
      this.waiting.delete(key);
      for (const mesh of meshes) {
        mesh.setEnabled(true);
        shadowsChanged ||= !!mesh.castsVoxelShadow;
      }
    }
    return shadowsChanged;
  }
  clear() { this.waiting.clear(); }
}
