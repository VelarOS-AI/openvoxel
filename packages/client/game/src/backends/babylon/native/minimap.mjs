import {Camera} from "@babylonjs/core/Cameras/camera.js";
import {FreeCamera} from "@babylonjs/core/Cameras/freeCamera.js";
import {RenderTargetTexture} from "@babylonjs/core/Materials/Textures/renderTargetTexture.js";
import {EffectRenderer, EffectWrapper} from "@babylonjs/core/Materials/effectRenderer.js";
import {Color4} from "@babylonjs/core/Maths/math.color.js";
import {Vector3} from "@babylonjs/core/Maths/math.vector.js";
import {Viewport} from "@babylonjs/core/Maths/math.viewport.js";
import {terrainColumnKey} from "./terrain-ground.mjs";

export const minimapTextureSize = 256;
export const minimapRefreshMilliseconds = 500;
export const minimapCaptureScale = 1.5;

export function minimapUvOffset(position, center, captureSpan) {
  return {x: (position.x - center.x) / captureSpan, y: -(position.z - center.z) / captureSpan};
}

export function minimapVisibleMeshes(columns, center, captureSpan, edge) {
  const half = captureSpan / 2;
  const visible = [];
  for (let z = Math.floor((center.z - half) / edge); z < Math.ceil((center.z + half) / edge); z += 1) {
    for (let x = Math.floor((center.x - half) / edge); x < Math.ceil((center.x + half) / edge); x += 1) {
      const meshes = columns.get(terrainColumnKey(x, z));
      if (meshes !== undefined) for (const mesh of meshes) visible.push(mesh);
    }
  }
  return visible;
}

export function minimapViewport(surface, overlay) {
  if (surface.width <= 0 || surface.height <= 0 || overlay.width <= 0 || overlay.height <= 0) return null;
  return new Viewport(
    (overlay.left - surface.left) / surface.width,
    1 - (overlay.top - surface.top + overlay.height) / surface.height,
    overlay.width / surface.width, overlay.height / surface.height,
  );
}

export const minimapCompositeFragment = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform float ovMapScale;
uniform vec2 ovMapOffset;
void main(void) {
  if (distance(vUV, vec2(0.5)) > 0.478) discard;
  vec2 mapUV = (vUV - 0.5) * ovMapScale + 0.5 + ovMapOffset;
  gl_FragColor = vec4(texture2D(textureSampler, mapUV).rgb, 1.0);
}`;

/// The same uploaded terrain meshes and materials are rendered by a north-up
/// orthographic camera. The cached GPU texture is composited under the HUD;
/// no pixel readback, duplicate world generation, or second WebGL engine.
export class WorldMinimapRenderer {
  constructor(scene, engine, player, surface, overlay, columns, options) {
    this.scene = scene;
    this.engine = engine;
    this.player = player;
    this.surface = surface;
    this.overlay = overlay;
    this.columns = columns;
    this.meshesDirty = true;
    this.compassHeading = null;
    this.mapX = null;
    this.mapZ = null;
    this.span = Math.min(64, options.edge * options.horizontalChunkRadius);
    this.captureSpan = this.span * minimapCaptureScale;
    this.edge = options.edge;
    this.offsetX = 0;
    this.offsetY = 0;
    this.elapsed = minimapRefreshMilliseconds;
    this.frames = 0;
    this.center = {x: options.targetX, z: options.targetZ};
    this.camera = new FreeCamera("world-minimap-camera", new Vector3(0, options.maximumWorldY + 32, 0), scene);
    this.camera.inputs.clear();
    this.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    this.camera.upVector = new Vector3(0, 0, -1);
    this.camera.minZ = 0.1;
    this.camera.maxZ = options.maximumWorldY - options.minimumWorldY + 64;
    this.camera.orthoLeft = -this.captureSpan / 2;
    this.camera.orthoRight = this.captureSpan / 2;
    this.camera.orthoTop = this.captureSpan / 2;
    this.camera.orthoBottom = -this.captureSpan / 2;
    this.camera.metadata = {openVoxelMinimap: true};
    this.target = new RenderTargetTexture("world-minimap", minimapTextureSize, scene, false);
    this.target.activeCamera = this.camera;
    this.target.renderParticles = false;
    this.target.renderSprites = false;
    this.target.clearColor = new Color4(0.035, 0.065, 0.08, 1);
    for (let group = 1; group <= 4; group += 1) this.target.setRenderingAutoClearDepthStencil(group, false);
    this.renderer = new EffectRenderer(engine);
    this.composite = new EffectWrapper({
      engine, name: "world-minimap-circle",
      vertexShader: "attribute vec2 position; varying vec2 vUV; void main(void) { vUV = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }",
      fragmentShader: minimapCompositeFragment,
      attributeNames: ["position"], samplerNames: ["textureSampler"], uniformNames: ["ovMapScale", "ovMapOffset"],
    });
    this.composite.onApplyObservable.add(() => {
      this.composite.effect.setTexture("textureSampler", this.target);
      this.composite.effect.setFloat("ovMapScale", this.span / this.captureSpan);
      this.composite.effect.setFloat2("ovMapOffset", this.offsetX, this.offsetY);
    });
    this.context = overlay.getContext("2d");
    if (!this.context) throw new Error("Minimap compass requires a 2D canvas");
    overlay.width = 416;
    overlay.height = 416;
    this.measure();
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(surface);
    this.resize.observe(overlay);
    this.restored = engine.onContextRestoredObservable.add(() => {this.elapsed = minimapRefreshMilliseconds;});
  }

  measure() {
    this.viewport = minimapViewport(this.surface.getBoundingClientRect(), this.overlay.getBoundingClientRect());
  }

  invalidateColumn(chunkX, chunkZ) {
    const half = this.captureSpan / 2;
    const x = chunkX * this.edge;
    const z = chunkZ * this.edge;
    if (x < this.center.x + half && x + this.edge > this.center.x - half
      && z < this.center.z + half && z + this.edge > this.center.z - half) this.meshesDirty = true;
  }

  update(deltaMilliseconds) {
    this.elapsed += deltaMilliseconds;
    if (!this.viewport || document.hidden || this.engine.isContextLost) return;
    if (this.elapsed >= minimapRefreshMilliseconds) {
      this.elapsed = 0;
      const {x, z} = this.player.globalPosition;
      if (Math.max(Math.abs(x - this.center.x), Math.abs(z - this.center.z)) >= this.span / 5) {
        this.center = {x, z};
        this.meshesDirty = true;
      }
      this.camera.position.x = this.center.x;
      this.camera.position.z = this.center.z;
      this.camera.setTarget(new Vector3(this.center.x, this.camera.position.y - 1, this.center.z));
      if (this.meshesDirty) {
        this.target.renderList = minimapVisibleMeshes(this.columns, this.center, this.captureSpan, this.edge);
        this.meshesDirty = false;
      }
      this.target.render(false);
      this.frames += 1;
      this.overlay.setAttribute("data-map-frames", String(this.frames));
      this.overlay.setAttribute("data-map-meshes", String(this.target.renderList.length));
    }
  }

  draw() {
    if (!this.viewport || this.frames === 0 || !this.composite.isReady()) return;
    const position = this.player.globalPosition;
    const offset = minimapUvOffset(position, this.center, this.captureSpan);
    this.offsetX = offset.x;
    this.offsetY = offset.y;
    if (this.mapX !== position.x) {
      this.mapX = position.x;
      this.overlay.setAttribute("data-map-x", String(position.x));
    }
    if (this.mapZ !== position.z) {
      this.mapZ = position.z;
      this.overlay.setAttribute("data-map-z", String(position.z));
    }
    const engine = this.engine;
    const previousAlpha = engine.getAlphaMode();
    const previousDepthWrite = engine.getDepthWrite();
    this.renderer.saveStates();
    try {
      engine.setAlphaMode(0);
      engine.setDepthWrite(false);
      this.renderer.setViewport(this.viewport);
      this.renderer.applyEffectWrapper(this.composite);
      this.renderer.draw();
    } finally {
      this.renderer.restoreStates();
      engine.setDepthWrite(previousDepthWrite);
      engine.setAlphaMode(previousAlpha);
      engine.setViewport(this.player.viewport);
    }
    this.drawCompass();
  }

  drawCompass() {
    const forward = this.player.getForwardRay().direction;
    const heading = Math.atan2(forward.x, -forward.z);
    if (heading === this.compassHeading) return;
    const ctx = this.context;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    if (this.compassHeading === null) {
      ctx.clearRect(0, 0, 208, 208);
      ctx.beginPath(); ctx.arc(104, 104, 100, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(245,245,225,0.8)"; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = "bold 13px Inter, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.lineWidth = 4; ctx.strokeStyle = "#172b30";
      for (const [label, x, y] of [["N", 104, 14], ["E", 194, 104], ["S", 104, 194], ["W", 14, 104]]) {
        ctx.fillStyle = label === "N" ? "#ffe7a3" : "#f5f3df";
        ctx.strokeText(label, x, y); ctx.fillText(label, x, y);
      }
    } else {
      // The circle and compass labels are fixed. Only the central arrow needs
      // repainting when the player turns; translation leaves this canvas alone.
      ctx.clearRect(92, 92, 24, 24);
    }
    this.compassHeading = heading;
    ctx.save();
    ctx.translate(104, 104);
    ctx.rotate(heading);
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 6); ctx.lineTo(0, 3); ctx.lineTo(-6, 6); ctx.closePath();
    ctx.fillStyle = "#fff2ba"; ctx.strokeStyle = "#102831"; ctx.lineWidth = 2;
    ctx.fill(); ctx.stroke(); ctx.restore();
  }

  dispose() {
    this.resize.disconnect();
    this.engine.onContextRestoredObservable.remove(this.restored);
    this.target.dispose();
    this.camera.dispose();
    this.composite.dispose();
    this.renderer.dispose();
    this.context.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
}
