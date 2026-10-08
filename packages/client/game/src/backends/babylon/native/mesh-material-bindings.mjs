import {PassUniformBuffer} from "./pass-uniform-buffer.mjs";

// One immutable PBR recipe/plugin graph serves a pipeline. Only the small
// binding owner varies per mesh; identities remain stable for render bundles.
export class MeshMaterialBindings {
  constructor(material, budget) {
    this.material = material;
    this.engine = material.getScene().getEngine();
    this.template = material._uniformBuffer;
    this.templateContext = material._materialContext;
    this.budget = budget;
    this.owners = new Map();
    this.retired = [];
  }

  attach(mesh) {
    if (this.owners.has(mesh)) return;
    const entry = {buffer: null, context: null, observer: null};
    entry.observer = mesh.onDisposeObservable.addOnce(() => this.release(mesh));
    this.owners.set(mesh, entry);
  }

  select(mesh) {
    let entry = this.owners.get(mesh);
    if (!entry) { this.attach(mesh); entry = this.owners.get(mesh); }
    const material = this.material;
    if (!material._uniformBufferLayoutBuilt) {
      material._uniformBuffer = this.template;
      material.buildUniformLayout();
    }
    if (!entry.buffer) {
      const recycled = this.retired.pop();
      if (recycled) {
        this.budget.count--;
        entry.buffer = recycled.buffer;
        entry.context = recycled.context;
      } else {
        entry.buffer = new PassUniformBuffer(this.engine, material.name + ":chunk");
        entry.buffer.copyLayout(this.template);
        entry.context = this.engine.createMaterialContext();
      }
    }
    material._uniformBuffer = entry.buffer;
    material._materialContext = entry.context;
    return entry;
  }

  release(mesh) {
    const entry = this.owners.get(mesh);
    if (!entry) return;
    this.owners.delete(mesh);
    mesh.onDisposeObservable.remove(entry.observer);
    if (!entry.buffer) return;
    if (this.material._uniformBuffer === entry.buffer) {
      this.material._uniformBuffer = this.template;
      this.material._materialContext = this.templateContext;
    }
    entry.context?.reset();
    entry.buffer.invalidateBindingCaches();
    if (this.retired.length < 32 && this.budget.count < 128) {
      this.retired.push({buffer: entry.buffer, context: entry.context});
      this.budget.count++;
    } else entry.buffer.dispose();
  }

  forEachDraw(callback) {
    for (const mesh of this.owners.keys()) for (const subMesh of mesh.subMeshes ?? []) {
      if (subMesh.getMaterial() !== this.material) continue;
      for (const wrapper of subMesh._drawWrappers) if (wrapper) callback(wrapper);
    }
  }

  dispose() {
    for (const [mesh, entry] of this.owners) {
      mesh.onDisposeObservable.remove(entry.observer);
      entry.buffer?.dispose();
    }
    for (const entry of this.retired) entry.buffer.dispose();
    this.budget.count -= this.retired.length;
    this.retired.length = 0;
    this.owners.clear();
    this.material._uniformBuffer = this.template;
    this.material._materialContext = this.templateContext;
  }
}
