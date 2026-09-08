// One surface owns its engine, scene, adapters and browser registrations. Each
// acquisition registers cleanup immediately, so failed construction and normal
// release unwind the same ownership stack, including when one cleanup fails.
export class SurfaceLifetime {
  constructor() {
    this.cleanups = [];
    this.disposed = false;
  }

  defer(cleanup) {
    if (this.disposed) throw new Error("Voxel surface lifetime is disposed");
    this.cleanups.push(cleanup);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const failures = [];
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Voxel surface cleanup failed");
  }
}
