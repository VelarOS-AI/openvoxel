import {PointLight} from "@babylonjs/core/Lights/pointLight.js";
import {Light} from "@babylonjs/core/Lights/light.js";
import {ShadowGenerator} from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";
import {Color3} from "@babylonjs/core/Maths/math.color.js";

const sourceKey = source => `${source.x}:${source.y}:${source.z}`;

/** Only the nearest two sources use PBR point lights and shadow cubes. All
 * emitters still contribute to the cached, occluded voxel light field. */
export class LocalLights {
  constructor(scene, field, terrainColumns, edge) {
    Object.assign(this, {scene, field, terrainColumns, edge});
    this.slots = [];
    this.age = Infinity;
    this.time = 0;
    this.dirty = true;
  }
  invalidate() { this.dirty = true; }
  slot(index) {
    if (this.slots[index]) return this.slots[index];
    const light = new PointLight(`openvoxel-local-light:${index}`, Vector3.Zero(), this.scene);
    light.diffuse = new Color3(1, 0.66, 0.32);
    light.specular = new Color3(1, 0.76, 0.47);
    light.falloffType = Light.FALLOFF_GLTF;
    light.radius = 0.15;
    light.shadowMinZ = 0.1;
    const shadow = new ShadowGenerator(256, light);
    shadow.bias = 0.002;
    shadow.normalBias = 0.035;
    shadow.usePoissonSampling = true;
    shadow.transparencyShadow = true;
    shadow.getShadowMap().refreshRate = 0;
    const slot = {light, shadow, source: null, animated: false};
    this.slots[index] = slot;
    return slot;
  }
  update(deltaMs, eye) {
    this.time += deltaMs / 1000;
    this.age += deltaMs;
    if (this.dirty || this.age >= 200) {
      this.age = 0;
      const nearest = this.field.sources.map(source => ({source, distance: (source.x - eye.x) ** 2 + (source.y - eye.y) ** 2 + (source.z - eye.z) ** 2}))
        .filter(item => item.distance < 24 ** 2).sort((a, b) => a.distance - b.distance).slice(0, 2);
      for (let i = 0; i < Math.max(nearest.length, this.slots.length); i++) {
        const source = nearest[i]?.source, slot = this.slot(i);
        if (!source) { slot.light.setEnabled(false); slot.source = null; continue; }
        const changed = slot.source === null || sourceKey(slot.source) !== sourceKey(source);
        slot.source = source;
        slot.light.setEnabled(true);
        slot.light.position.set(source.x, source.y, source.z);
        slot.light.range = source.level;
        slot.light.shadowMaxZ = source.level;
        if (changed || this.dirty) {
          const meshes = [];
          const cx = Math.floor(source.x / this.edge), cz = Math.floor(source.z / this.edge);
          for (let x = cx - 1; x <= cx + 1; x++) for (let z = cz - 1; z <= cz + 1; z++) {
            for (const mesh of this.terrainColumns.get(`${x}:${z}`) ?? []) {
              const box = mesh.getBoundingInfo().boundingBox;
              if (box.minimumWorld.y > source.y + source.level || box.maximumWorld.y < source.y - source.level) continue;
              meshes.push(mesh);
            }
          }
          slot.light.includedOnlyMeshes = meshes;
          slot.shadow.getShadowMap().renderList = meshes.filter(mesh => mesh.castsVoxelShadow);
          slot.animated = meshes.some(mesh => mesh.hasFoliage);
        }
        if (changed || this.dirty || slot.animated) slot.shadow.getShadowMap().resetRefreshCounter();
      }
      this.dirty = false;
    }
    for (const [i, slot] of this.slots.entries()) if (slot.source) {
      slot.light.intensity = 18 * (slot.source.level / 15) * (0.98 + 0.02 * Math.sin(this.time * 7.3 + i * 2.1));
    }
  }
  dispose() {
    for (const slot of this.slots) { slot.shadow.dispose(); slot.light.dispose(); }
    this.slots.length = 0;
  }
}
