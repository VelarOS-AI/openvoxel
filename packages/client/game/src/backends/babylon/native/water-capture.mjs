import {MirrorTexture} from "@babylonjs/core/Materials/Textures/mirrorTexture.js";
import {RenderTargetTexture} from "@babylonjs/core/Materials/Textures/renderTargetTexture.js";
import {Matrix} from "@babylonjs/core/Maths/math.vector.js";
import {Plane} from "@babylonjs/core/Maths/math.plane.js";
import {Frustum} from "@babylonjs/core/Maths/math.frustum.js";
import {Color4} from "@babylonjs/core/Maths/math.color.js";

/** One shared pair of bounded targets, regardless of the number of water chunks.
 * Only the nearest visible water level needs a planar capture. Other levels keep
 * the analytic/IBL surface. Targets contain no fluids, weather or sun sprites. */
export class WaterCapture {
  constructor(scene, camera, runtime, columns, environment, edge) {
    Object.assign(this, {scene, camera, runtime, columns, environment, edge});
    // Keep CLIPPLANE in the shader recipe before the first frame. Water passes
    // change only its uniform instead of synchronously compiling all terrain
    // materials when the first reflection/refraction becomes visible.
    this.previousClipPlane = scene.clipPlane;
    this.idleClipPlane = scene.clipPlane ?? new Plane(0, 0, 0, -1);
    scene.clipPlane = this.idleClipPlane;
    this.water = new Map();
    this.reflectionMatrix = Matrix.Identity();
    this.refractionMatrix = Matrix.Identity();
    this.level = 0;
    this.active = false;
    this.rendering = false;
    this.reflectionReady = false;
    this.refractionReady = false;
    this.blend = 0;
    this.age = 250;
    this.captureAge = Infinity;
    this.dirty = true;
    this.capturedView = Matrix.Identity();
    this.capturedProjection = Matrix.Identity();
    this.visibilityMatrix = Matrix.Identity();
    this.visibilityPlanes = Frustum.GetPlanes(this.visibilityMatrix);
    this.levelMeshes = [];
    this.scheduledCaptures = 0;
    this.nextReflection = true;
    this.wasVisible = false;
    // Runs after camera inputs have been applied, before camera render targets.
    this.beforeRender = scene.onBeforeRenderObservable.add(() => this.scheduleCaptures());
    this.restored = scene.getEngine().onContextRestoredObservable.add(() => {
      this.reflectionReady = this.refractionReady = false;
      this.dirty = true;
    });
    this.runtime.capture = this;
  }

  register(mesh) {
    this.dirty = true;
    this.age = 250;
    if (mesh.precipitationSurface !== "water") return;
    const positions = mesh.getVerticesData("position"), normals = mesh.getVerticesData("normal");
    const levels = new Map();
    for (let i = 0; i < positions.length; i += 12) {
      if (normals[i + 1] < 0.9) continue;
      const y = positions[i + 1] + mesh.position.y;
      levels.set(y, (levels.get(y) ?? 0) + 1);
    }
    if (levels.size > 0) this.water.set(mesh, levels);
    this.age = 250;
  }

  remove(mesh) { this.water.delete(mesh); this.age = 250; this.dirty = true; }

  createTargets() {
    if (this.reflection) return;
    const engine = this.scene.getEngine();
    const size = {width: Math.min(768, Math.max(256, Math.round(engine.getRenderWidth() / 2))),
      height: Math.min(512, Math.max(192, Math.round(engine.getRenderHeight() / 2)))};
    this.reflection = new MirrorTexture("openvoxel-water-reflection", size, this.scene, false);
    this.refraction = new RenderTargetTexture("openvoxel-water-refraction", size, this.scene, false);
    for (const target of [this.reflection, this.refraction]) {
      target.activeCamera = this.camera;
      target.refreshRate = 0;
      target.renderParticles = false;
      target.useCameraPostProcesses = false;
      target.renderList = [];
      target.ignoreCameraViewport = true;
      target.clearColor = new Color4(0.04, 0.12, 0.13, 1);
      for (let group = 1; group <= 4; group += 1) target.setRenderingAutoClearDepthStencil(group, false, false, false);
    }
    this.reflection.onBeforeRenderObservable.add(() => {
      this.rendering = true;
      this.reflectionMatrix.copyFrom(this.scene.getTransformMatrix());
    });
    this.reflection.onAfterRenderObservable.add(() => { this.rendering = false; this.reflectionReady = true; });
    this.refraction.onBeforeRenderObservable.add(() => {
      this.rendering = true;
      this.savedClip = this.scene.clipPlane;
      this.scene.clipPlane = new Plane(0, 1, 0, -this.level - 0.04);
      this.refractionMatrix.copyFrom(this.scene.getTransformMatrix());
    });
    this.refraction.onAfterRenderObservable.add(() => {
      this.scene.clipPlane = this.savedClip;
      this.rendering = false;
      this.refractionReady = true;
    });
  }

  update(deltaMs) {
    if (this.enabled === false) { this.setActive(false); return; }
    this.captureAge += deltaMs;
    if (this.active) this.blend = Math.min(1, this.blend + deltaMs / 250);
    this.age += deltaMs;
    if (this.age < 200) return;
    this.age = 0;
    const eye = this.camera.globalPosition;
    let best = Infinity, level = null;
    for (const [mesh, levels] of this.water) {
      // Select a nearby water level by world position. Visibility may change
      // while strafing/turning and must not reset its appearance or blend.
      if (!mesh.isEnabled() || !mesh.isVisible) continue;
      const box = mesh.getBoundingInfo().boundingBox;
      const dx = Math.max(box.minimumWorld.x - eye.x, 0, eye.x - box.maximumWorld.x);
      const dz = Math.max(box.minimumWorld.z - eye.z, 0, eye.z - box.maximumWorld.z);
      for (const y of levels.keys()) {
        if (eye.y < y + 0.1) continue;
        const distance = dx * dx + dz * dz + (eye.y - y) ** 2 * 0.15;
        const score = distance - (this.active && y === this.level ? 100 : 0);
        if (score < best && distance < 96 ** 2) { best = score; level = y; }
      }
    }
    if (level === null) { this.setActive(false); return; }
    this.createTargets();
    const engine = this.scene.getEngine();
    const width = Math.min(768, Math.max(256, Math.round(engine.getRenderWidth() / 2)));
    const height = Math.min(512, Math.max(192, Math.round(engine.getRenderHeight() / 2)));
    if (this.reflection.getSize().width !== width || this.reflection.getSize().height !== height) {
      this.reflection.resize({width, height});
      this.refraction.resize({width, height});
      this.reflectionReady = false;
      this.refractionReady = false;
    }
    if (this.level !== level) { this.reflectionReady = false; this.refractionReady = false; this.blend = 0; }
    this.level = level;
    this.levelMeshes = [...this.water].filter(([mesh, levels]) => mesh.isEnabled() && mesh.isVisible && levels.has(level)).map(([mesh]) => mesh);
    this.reflection.mirrorPlane = new Plane(0, -1, 0, level);
    const terrain = [];
    const cx = Math.floor(eye.x / this.edge), cz = Math.floor(eye.z / this.edge);
    const radius = Math.ceil(96 / this.edge);
    for (let x = cx - radius; x <= cx + radius; x += 1) for (let z = cz - radius; z <= cz + radius; z += 1) {
      for (const mesh of this.columns.get(`${x}:${z}`) ?? []) {
        if (mesh.renderingGroupId === 0) terrain.push(mesh);
      }
    }
    this.refraction.renderList = terrain.filter(mesh => mesh.getBoundingInfo().boundingBox.minimumWorld.y <= level + 0.04);
    this.reflection.renderList = [this.environment.sky.mesh, this.environment.clouds.mesh,
      ...terrain.filter(mesh => mesh.getBoundingInfo().boundingBox.maximumWorld.y >= level - 0.04)];
    this.setActive(true);
  }

  scheduleCaptures() {
    if (!this.active) return;
    const view = this.camera.getViewMatrix(), projection = this.camera.getProjectionMatrix();
    // Camera inputs have now run. Use this view's frustum, independent of the
    // previous frame, minimap or mirror passes. Keep cached captures offscreen.
    view.multiplyToRef(projection, this.visibilityMatrix);
    Frustum.GetPlanesToRef(this.visibilityMatrix, this.visibilityPlanes);
    if (!this.levelMeshes.some(mesh => mesh.isInFrustum(this.visibilityPlanes))) { this.wasVisible = false; return; }
    const returning = !this.wasVisible;
    this.wasVisible = true;
    const moved = !view.equals(this.capturedView) || !projection.equals(this.capturedProjection);
    // Each target owns its captured projection. During motion, alternate them
    // instead of adding two complete terrain passes to every displayed frame.
    // Initial visibility, stationary edits and returning water refresh the pair together.
    if (!returning && !moved && !this.dirty && this.reflectionReady && this.refractionReady && this.captureAge < 1000 / 15) return;
    this.capturedView.copyFrom(view);
    this.capturedProjection.copyFrom(projection);
    if (moved && !returning && this.reflectionReady && this.refractionReady) {
      (this.nextReflection ? this.reflection : this.refraction).resetRefreshCounter();
      this.nextReflection = !this.nextReflection;
    } else {
      this.reflection.resetRefreshCounter();
      this.refraction.resetRefreshCounter();
    }
    this.captureAge = 0;
    this.dirty = false;
    this.scheduledCaptures++;
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    if (active) this.dirty = true;
    if (!active) this.blend = 0;
    for (const target of [this.reflection, this.refraction]) {
      if (!target) continue;
      // Babylon renders camera targets after light shadow maps. Scene targets
      // run before them and sample the old depth map with the new light matrix
      // on every shadow refresh, producing intermittent dark/bright water.
      if (active) this.camera.customRenderTargets.push(target);
      else {
        const index = this.camera.customRenderTargets.indexOf(target);
        if (index !== -1) this.camera.customRenderTargets.splice(index, 1);
      }
    }
  }

  usable(scene) {
    return this.active && this.reflectionReady && this.refractionReady && !this.rendering && scene.activeCamera === this.camera;
  }

  dispose() {
    this.scene.onBeforeRenderObservable.remove(this.beforeRender);
    this.scene.getEngine().onContextRestoredObservable.remove(this.restored);
    this.setActive(false);
    this.reflection?.dispose();
    this.refraction?.dispose();
    if (this.scene.clipPlane === this.idleClipPlane) this.scene.clipPlane = this.previousClipPlane;
    this.runtime.capture = null;
    this.water.clear();
    this.levelMeshes.length = 0;
  }
}
