import {Texture} from "@babylonjs/core/Materials/Textures/texture.js";

function createTexture(scene, dataUrl, samplingMode, loaded, failed) {
  // Source images have a top-left origin; logical resource UVs have a bottom-
  // left origin. Flip exactly once at upload and retain authored premultiplied RGB.
  return new Texture(dataUrl, scene, true, true, samplingMode, loaded, failed);
}

// The batch owns textures from acquisition, not only after Promise.all succeeds.
// A failed image therefore closes pending and completed siblings immediately.
export async function loadEnvironmentTextures(scene, resources, textureFactory = createTexture) {
  const acquired = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const failures = [];
    for (const texture of acquired.splice(0).reverse()) {
      try { texture.dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Voxel environment texture cleanup failed");
  };
  const load = (dataUrl, samplingMode) => new Promise((resolve, reject) => {
    let texture;
    texture = textureFactory(scene, dataUrl, samplingMode,
      () => queueMicrotask(() => resolve(texture)),
      (message, error) => reject(error instanceof Error ? error : new Error(message || "Voxel image texture failed to load")),
    );
    acquired.push(texture);
  });
  const skyUrls = [resources.sky.sunDataUrl, resources.sky.glowDataUrl, resources.sky.starDataUrl, ...resources.sky.moonDataUrls];
  try {
    const textures = await Promise.all([
      ...skyUrls.map((url) => load(url, Texture.BILINEAR_SAMPLINGMODE)),
      load(resources.clouds.textureDataUrl, Texture.BILINEAR_SAMPLINGMODE),
      load(resources.precipitation.rainDataUrl, Texture.NEAREST_SAMPLINGMODE),
      load(resources.precipitation.rainSplashDataUrl, Texture.NEAREST_SAMPLINGMODE),
      load(resources.precipitation.snowDataUrl, Texture.NEAREST_SAMPLINGMODE),
    ]);
    return {
      sun: textures[0], glow: textures[1], star: textures[2], moons: textures.slice(3, 11),
      clouds: textures[11], rain: textures[12], rainSplash: textures[13], snow: textures[14], dispose,
    };
  } catch (error) {
    try { dispose(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Voxel environment texture loading failed", {cause: error});
    }
    throw error;
  }
}
