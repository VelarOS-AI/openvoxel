import {Engine} from "@babylonjs/core/Engines/engine.js";
import {Scene} from "@babylonjs/core/scene.js";
import {FreeCamera} from "@babylonjs/core/Cameras/freeCamera.js";
import {MeshBuilder} from "@babylonjs/core/Meshes/meshBuilder.js";
import {RawTexture} from "@babylonjs/core/Materials/Textures/rawTexture.js";
import {Texture} from "@babylonjs/core/Materials/Textures/texture.js";
import {Vector3, Vector4} from "@babylonjs/core/Maths/math.vector.js";
import {Color4} from "@babylonjs/core/Maths/math.color.js";
import {createEnvironmentSpriteMaterial} from "../../src/native/babylon/environment-sprite-material.mjs";
import {createWeatherParticleBatch} from "../../src/native/babylon/weather-particle-batch.mjs";

/** Read actual GPU blend results for a known premultiplied texel. These are
 * production materials, not a duplicate test implementation of the shaders.
 */
export async function probeEnvironmentTextureBlending() {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const engine = new Engine(canvas, false, {preserveDrawingBuffer: true});
  const scene = new Scene(engine);
  const results = {};
  try {
    const camera = new FreeCamera("texture-probe-camera", new Vector3(0, 0, -2), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    scene.clearColor = new Color4(0.2, 0.4, 0.6, 1);
    const texture = RawTexture.CreateRGBATexture(new Uint8Array([64, 32, 0, 128]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    const plane = MeshBuilder.CreatePlane("texture-probe-quad", {size: 2}, scene);
    for (const additive of [false, true]) {
      const material = createEnvironmentSpriteMaterial(scene, "texture-probe-material", texture, {additive});
      plane.material = material;
      await material.forceCompilationAsync(plane);
      for (const fade of [1, 0.5, 0]) {
        material.setVector4("ovTint", new Vector4(fade, fade, fade, fade));
        scene.render();
        results[`${additive ? "additive" : "premultiplied"}:${fade}`] = Array.from(await engine.readPixels(16, 16, 1, 1));
      }
      material.dispose(false, false);
    }
    plane.dispose(false, false);
    const batch = createWeatherParticleBatch(scene, texture, "rainSplash", 1);
    batch.append({x: 0, y: 0, z: 0, halfSize: 1, horizontal: false}, {
      right: {x: 1, y: 0, z: 0}, up: {x: 0, y: 1, z: 0},
    }, 1, 1);
    batch.upload();
    await batch.mesh.material.forceCompilationAsync(batch.mesh);
    scene.render();
    results.weather = Array.from(await engine.readPixels(16, 16, 1, 1));
    batch.dispose();
    return results;
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
