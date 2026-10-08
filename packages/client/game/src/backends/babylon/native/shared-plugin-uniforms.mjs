import {PassUniformBuffer} from "./pass-uniform-buffer.mjs";
import {UniformBuffer} from "@babylonjs/core/Materials/uniformBuffer.js";

// Frame-wide values live outside the large per-mesh PBR block. Each pipeline
// shares the small block, with stable identities for main, water, map and shadow
// passes. Texture bindings still belong to the material/draw context.
export class SharedPluginUniforms {
  constructor(scene) {
    this.scene = scene;
    this.blocks = new Map();
  }

  attach(plugin, key) {
    const engine = this.scene.getEngine();
    if (!engine.supportsUniformBuffers) return plugin;
    const uniforms = plugin.getUniforms().ubo;
    const name = plugin.name + "Frame";
    let block = this.blocks.get(key);
    if (!block) {
      const buffer = engine.isWebGPU ? new PassUniformBuffer(engine, name) : new UniformBuffer(engine, undefined, false, name);
      for (const uniform of uniforms) buffer.addUniform(uniform.name, uniform.size, uniform.arraySize ?? 0);
      buffer.create();
      const textures = new Map();
      buffer.setTexture = (sampler, texture) => textures.set(sampler, texture);
      this.blocks.set(key, block = {buffer, textures, renderId: -1, pass: -1});
    }
    const declaration = `\nuniform ${name} {\n${uniforms.map(u => `${u.type} ${u.name}${u.arraySize ? `[${u.arraySize}]` : ""};`).join("\n")}\n};\n`;
    const customCode = plugin.getCustomCode.bind(plugin);
    plugin.getCustomCode = stage => {
      const code = customCode(stage);
      if (!code) return code;
      const point = stage === "vertex" ? "CUSTOM_VERTEX_DEFINITIONS" : "CUSTOM_FRAGMENT_DEFINITIONS";
      return {...code, [point]: declaration + (code[point] ?? "")};
    };
    plugin.getUniforms = () => ({});
    plugin.getUniformBuffersNames = names => names.push(name);
    const bind = plugin.bindForSubMesh.bind(plugin);
    // The original binder also assigns textures; separate those from the once
    // per-render parameter update without changing material ownership.
    plugin.bindForSubMesh = (materialBuffer, scene, engine, subMesh) => {
      const renderId = this.scene.getRenderId();
      const pass = this.scene.getEngine().currentRenderPassId;
      const buffer = block.buffer;
      buffer.bindToEffect(materialBuffer.currentEffect, name);
      if (block.renderId !== renderId || block.pass !== pass) {
        bind(buffer, scene, engine, subMesh);
        block.renderId = renderId;
        block.pass = pass;
        buffer.update();
      } else buffer.bindUniformBuffer();
      for (const [sampler, texture] of block.textures) materialBuffer.setTexture(sampler, texture);
    };
    return plugin;
  }

  dispose() {
    for (const {buffer} of this.blocks.values()) buffer.dispose();
    this.blocks.clear();
  }
}
