import {MaterialPluginBase} from "@babylonjs/core/Materials/materialPluginBase.js";
import {RawTexture3D} from "@babylonjs/core/Materials/Textures/rawTexture3D.js";
import {Texture} from "@babylonjs/core/Materials/Textures/texture.js";
import {Constants} from "@babylonjs/core/Engines/constants.js";

const keyOf = p => `${p.x}:${p.y}:${p.z}`;

export class VoxelLightingTextures {
  constructor(scene, edge) {
    this.scene = scene;
    this.edge = edge;
    this.enabled = false;
    this.chunks = new Map();
    this.users = new Map();
    this.sources = [];
    this.dark = null;
    this.open = null;
  }

  texture(data, size, key) {
    const texture = new RawTexture3D(data, size, size, size, Constants.TEXTUREFORMAT_RGBA,
      this.scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
    texture.name = `openvoxel-light-field:${key}`;
    texture.wrapU = texture.wrapV = texture.wrapR = Texture.CLAMP_ADDRESSMODE;
    texture.gammaSpace = false;
    return texture;
  }

  apply(update) {
    this.enabled = true;
    for (const position of update.removed) {
      const key = keyOf(position);
      const entry = this.chunks.get(key);
      if (entry) entry.retired = true;
      this.collect(key);
    }
    for (const chunk of update.chunks) {
      const size = this.edge + 2;
      if (chunk.edge !== this.edge || !(chunk.data instanceof Uint8Array) || chunk.data.length !== size ** 3 * 4) throw new Error("Voxel light texture has the wrong volume");
      const key = keyOf(chunk.position), old = this.chunks.get(key);
      if (old) {
        old.retired = false;
        old.data = chunk.data;
        old.texture?.update(chunk.data);
      } else this.chunks.set(key, {data: chunk.data, texture: null});
    }
    this.sources = update.sources;
  }

  collect(key) {
    const entry = this.chunks.get(key);
    if (entry?.retired && !this.users.has(key)) {
      entry.texture?.dispose();
      this.chunks.delete(key);
    }
  }

  attach(mesh, key) {
    mesh.voxelChunkKey = key;
    this.users.set(key, (this.users.get(key) ?? 0) + 1);
    mesh.onDisposeObservable.addOnce(() => {
      const remaining = (this.users.get(key) ?? 1) - 1;
      if (remaining) this.users.set(key, remaining);
      else this.users.delete(key);
      this.collect(key);
    });
  }

  forMesh(mesh) {
    const entry = this.chunks.get(mesh.voxelChunkKey);
    if (!entry) return this.enabled
      ? (this.dark ??= this.texture(new Uint8Array([0, 0, 0, 255]), 1, "unresolved"))
      : (this.open ??= this.texture(new Uint8Array([255, 255, 0, 0]), 1, "open-sky"));
    entry.texture ??= this.texture(entry.data, this.edge + 2, mesh.voxelChunkKey);
    return entry.texture;
  }

  dispose() {
    for (const entry of this.chunks.values()) entry.texture?.dispose();
    this.chunks.clear(); this.users.clear(); this.sources = [];
    this.dark?.dispose(); this.open?.dispose();
  }
}

/** Visibility scales outdoor light before PBR composition. Emission/local light
 * stays independent, so a torch can illuminate a sealed cave without daylight. */
export class VoxelLightingPlugin extends MaterialPluginBase {
  constructor(material, field = null) {
    super(material, "OpenVoxelLighting", 230, {}, true, false, true);
    this.field = field;
    this.registerForExtraEvents = true;
    this._enable(true);
  }
  getClassName() { return "VoxelLightingPlugin"; }
  isCompatible(language) { return language === 0; }
  getSamplers(samplers) { if (this.field) samplers.push("ovVoxelLightSampler"); }
  getUniforms() { return this.field ? {ubo: [{name: "ovVoxelLightBounds", size: 4, type: "vec4"}]} : {}; }
  hardBindForSubMesh(buffer, _scene, _engine, subMesh) {
    if (!this.field) return;
    const mesh = subMesh.getRenderingMesh(), p = mesh.position;
    buffer.setTexture("ovVoxelLightSampler", this.field.forMesh(mesh));
    buffer.updateFloat4("ovVoxelLightBounds", p.x - 1, p.y - 1, p.z - 1, this.field.edge + 2);
  }
  getCustomCode(stage) {
    if (stage === "vertex") return {
      CUSTOM_VERTEX_DEFINITIONS: `
varying vec3 ovVoxelLight;
${this.field ? "precision highp sampler3D;\nuniform highp sampler3D ovVoxelLightSampler;\nuniform vec4 ovVoxelLightBounds;" : ""}`,
      CUSTOM_VERTEX_MAIN_END: this.field ? `
vec3 ovLightPosition = (world * vec4(positionUpdated, 1.0)).xyz + normalize(mat3(world) * normalUpdated) * 0.501;
vec3 ovLightUv = clamp((ovLightPosition - ovVoxelLightBounds.xyz) / ovVoxelLightBounds.w, 0.5 / ovVoxelLightBounds.w, 1.0 - 0.5 / ovVoxelLightBounds.w);
ovVoxelLight = texture(ovVoxelLightSampler, ovLightUv).rgb;` : "ovVoxelLight = vec3(1.0, 1.0, 0.0);",
    };
    if (stage !== "fragment") return null;
    const code = {
      CUSTOM_FRAGMENT_DEFINITIONS: "varying vec3 ovVoxelLight;\nfloat ovDirectVisibility;\nfloat ovSkyVisibility;\nfloat ovActiveLightVisibility;",
      CUSTOM_FRAGMENT_MAIN_BEGIN: `
ovDirectVisibility = pow(ovVoxelLight.r, 1.35);
ovSkyVisibility = pow(ovVoxelLight.g, 1.7);
ovActiveLightVisibility = 1.0;`,
      "!specularBase\\+=info\\.specular\\*shadow;": "specularBase+=info.specular*shadow*ovActiveLightVisibility;",
      "!diffuseBase\\+=info\\.diffuse\\*shadow;": "diffuseBase+=info.diffuse*shadow*ovActiveLightVisibility;",
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
finalAmbient *= ovSkyVisibility;
#ifdef REFLECTION
finalIrradiance *= ovSkyVisibility;
finalRadianceScaled *= ovSkyVisibility;
#endif
finalEmissive += surfaceAlbedo * vec3(1.0, 0.50, 0.17) * pow(ovVoxelLight.b, 2.0) * 0.42;`,
    };
    for (let i = 0; i < 5; i++) code[`CUSTOM_LIGHT${i}_COLOR`] = `
#if defined(HEMILIGHT${i})
ovActiveLightVisibility = ovSkyVisibility;
#elif defined(DIRLIGHT${i})
ovActiveLightVisibility = ovDirectVisibility;
#else
ovActiveLightVisibility = 1.0;
#endif`;
    return code;
  }
}
