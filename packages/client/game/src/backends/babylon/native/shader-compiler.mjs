export class ShaderCompiler {
  constructor(url, WorkerClass = globalThis.Worker) {
    this.worker = new WorkerClass(url, {name: "openvoxel-shader-compiler"});
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.worker.onmessage = ({data}) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      data.error ? request.reject(new Error(data.error)) : request.resolve(data);
    };
    this.worker.onerror = event => this.dispose(new Error(event.message || "WebGPU shader compiler failed"));
    this.worker.onmessageerror = () => this.dispose(new Error("WebGPU shader compiler response could not be read"));
  }
  request(value) {
    if (this.closed) return Promise.reject(new Error("WebGPU shader compiler is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      try { this.worker.postMessage({...value, id}); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  dispose(error = new Error("WebGPU shader compiler is closed")) {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
