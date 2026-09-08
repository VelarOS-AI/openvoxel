import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import sharp from "sharp";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine.js";
import {Constants} from "@babylonjs/core/Engines/constants.js";
import {Scene} from "@babylonjs/core/scene.js";
import {Vector3, Matrix} from "@babylonjs/core/Maths/math.vector.js";
import {Texture} from "@babylonjs/core/Materials/Textures/texture.js";
import {
  celestialDistance,
  celestialOrientation,
  celestialPresentation,
  createCelestialLayer,
  starCount,
  starFieldGeometry,
} from "../src/native/babylon/environment-celestial.mjs";

function frame(overrides = {}) {
  const current = {
    sunDirection: new Vector3(0, -0.8, 0.6),
    moonDirection: new Vector3(0, 0.8, -0.6),
    daylightIntensity: 1,
    precipitationIntensity: 0,
    moonPhase: 0,
    timeOfDay: 0.5,
    ...overrides,
  };
  return {starIntensity: ((1 - current.daylightIntensity) * (1 - current.precipitationIntensity)) ** 2, ...current};
}

function approximately(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} should equal ${expected}`);
}

test("celestial sprites use source angular sizes, horizon enlargement, and dual glow fades", () => {
  const day = celestialPresentation(frame());
  assert.equal(celestialDistance, 900);
  assert.equal(day.sunHalfSize, 90);
  assert.equal(day.moonHalfSize, 60);
  assert.deepEqual(day.sunTint, [1, 1, 1, 1]);
  assert.deepEqual(day.moonTint, [0, 0, 0, 0]);
  assert.deepEqual(day.sunGlowTint, [0.6, 0.6, 0.6, 0.6]);
  assert.deepEqual(day.moonGlowTint, [0.2, 0.2, 0.2, 0.2]);

  const horizon = celestialPresentation(frame({sunDirection: new Vector3(-1, 0, 0)}));
  assert.equal(horizon.sunHalfSize, 160);
  assert.equal(horizon.moonHalfSize, 80);
  approximately(horizon.sunTint[2], 160 / 255);
});

test("precipitation scales all premultiplied disc channels and stars consume the checked frame intensity", () => {
  const night = celestialPresentation(frame({daylightIntensity: 0, precipitationIntensity: 0.5}));
  assert.deepEqual(night.sunTint, [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(night.moonTint, [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(night.sunGlowTint, [0.15, 0.15, 0.15, 0.15]);
  assert.equal(night.starOpacity, 0.25);
  assert.equal(celestialPresentation(frame()).starOpacity, 0);
  const storm = celestialPresentation(frame({daylightIntensity: 0, precipitationIntensity: 1}));
  assert.deepEqual(storm.sunTint, [0, 0, 0, 0]);
  assert.deepEqual(storm.moonTint, [0, 0, 0, 0]);
  assert.equal(storm.starOpacity, 0);
  assert.equal(celestialPresentation(frame({starIntensity: 0.125})).starOpacity, 0.125);
});

test("celestial tangent orientation faces the viewer position without camera-dependent billboarding", () => {
  for (const direction of [new Vector3(0, -1, 0), new Vector3(-1, 0, 0), new Vector3(0, -0.8, 0.6)]) {
    const rotation = celestialOrientation(direction);
    const matrix = new Matrix();
    rotation.toRotationMatrix(matrix);
    const normal = Vector3.TransformNormal(Vector3.Forward(), matrix);
    approximately(Vector3.Dot(normal, direction), 1);
    approximately(rotation.length(), 1);
  }
});

test("star geometry is deterministic, full sphere, textured, and varies size and vertex alpha", () => {
  const geometry = starFieldGeometry();
  assert.deepEqual(geometry, starFieldGeometry());
  assert.equal(starCount, 250);
  assert.equal(geometry.positions.length, starCount * 4 * 3);
  assert.equal(geometry.colors.length, starCount * 4 * 4);
  assert.equal(geometry.uvs.length, starCount * 4 * 2);
  assert.equal(geometry.indices.length, starCount * 6);
  assert.deepEqual(geometry.uvs.slice(0, 8), [0, 1, 1, 1, 1, 0, 0, 0], "star UVs must compensate for top-first source image rows");
  let above = 0;
  let below = 0;
  const alphaValues = new Set();
  for (let star = 0; star < starCount; star += 1) {
    const corners = Array.from({length: 4}, (_, corner) => Vector3.FromArray(geometry.positions, star * 12 + corner * 3));
    const center = corners.reduce((sum, corner) => sum.add(corner), Vector3.Zero()).scale(0.25);
    approximately(center.length(), celestialDistance);
    if (center.y > 0) above += 1;
    else below += 1;
    const halfSize = Vector3.Distance(corners[0], corners[1]) * 0.5;
    assert.ok(halfSize >= 7.65 * 0.7 ** 3 && halfSize <= 7.65);
    const alpha = geometry.colors[star * 16 + 3];
    assert.ok(alpha >= 0.7 ** 4 && alpha <= 1);
    alphaValues.add(alpha);
  }
  assert.ok(above > 90 && below > 90, "stars must cover both hemispheres before daily rotation");
  assert.ok(alphaValues.size > 200);
});

test("moon source corners and asymmetric artwork survive the flipped WebP upload without mirroring", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const makeTexture = () => new Texture(null, scene, true, true, Texture.BILINEAR_SAMPLINGMODE);
  const textures = {sun: makeTexture(), glow: makeTexture(), star: makeTexture(), moons: Array.from({length: 8}, makeTexture)};
  try {
    const layer = createCelestialLayer(scene, textures);
    const sourceCorners = [new Vector3(-1, 0, -1), new Vector3(1, 0, -1), new Vector3(1, 0, 1), new Vector3(-1, 0, 1)];
    const tilt = Matrix.RotationX(-35 * Math.PI / 180);
    for (const angle of [0, 0.7, Math.PI]) {
      const orbit = Matrix.RotationZ(-angle);
      const rotate = (position) => Vector3.TransformCoordinates(Vector3.TransformCoordinates(position, orbit), tilt);
      const outward = rotate(Vector3.Up()).normalize();
      layer.applyFrame(frame({sunDirection: outward, moonDirection: outward.scale(-1), daylightIntensity: 0}));
      layer.update(Vector3.Zero());
      const mesh = layer.moon.mesh;
      const world = mesh.computeWorldMatrix(true);
      const positions = mesh.getVerticesData("position");
      for (let corner = 0; corner < 4; corner += 1) {
        const actual = Vector3.TransformCoordinates(Vector3.FromArray(positions, corner * 3), world);
        const expected = rotate(sourceCorners[corner].scale(mesh.scaling.x)).add(outward.scale(celestialDistance));
        assert.ok(Vector3.Distance(actual, expected) < 0.001, "celestial tangent handedness must preserve the reference corner, not hide a UV reflection");
      }
    }

    const source = fileURLToPath(new URL("../data/environment/sky/moon-02.webp", import.meta.url));
    const {data, info} = await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    const uvs = layer.moon.mesh.getVerticesData("uv");
    const interpolate = (s, t, axis) => (1 - s) * (1 - t) * uvs[axis]
      + s * (1 - t) * uvs[2 + axis] + s * t * uvs[4 + axis] + (1 - s) * t * uvs[6 + axis];
    let asymmetricChannels = 0;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const sourceU = (x + 0.5) / info.width;
        const sourceV = (y + 0.5) / info.height;
        // In QueueCelestialBody, source V runs along local X and source U
        // runs opposite local Z. The GPU image rows are flipped on upload.
        const sampleX = Math.floor(interpolate(sourceV, 1 - sourceU, 0) * info.width);
        const sampleY = Math.floor((1 - interpolate(sourceV, 1 - sourceU, 1)) * info.height);
        for (let channel = 0; channel < 4; channel += 1) {
          const expected = data[(y * info.width + x) * 4 + channel];
          const actual = data[(sampleY * info.width + sampleX) * 4 + channel];
          assert.equal(actual, expected, `moon pixel (${x}, ${y}, ${channel}) must retain its authored orientation`);
          if (Math.abs(expected - data[((info.height - y - 1) * info.width + x) * 4 + channel]) > 8) asymmetricChannels += 1;
        }
      }
    }
    assert.ok(asymmetricChannels > 1000, "the regression fixture must distinguish a vertical reflection");
    layer.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("celestial meshes share authored glow, switch eight moon textures, retain geometry, and dispose", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const makeTexture = () => new Texture(null, scene, true, true, Texture.BILINEAR_SAMPLINGMODE);
  const textures = {sun: makeTexture(), glow: makeTexture(), star: makeTexture(), moons: Array.from({length: 8}, makeTexture)};
  try {
    const layer = createCelestialLayer(scene, textures);
    layer.applyFrame(frame());
    const center = new Vector3(100, 64, -20);
    layer.update(center);
    assert.equal(layer.sun.material.alphaMode, Constants.ALPHA_PREMULTIPLIED_PORTERDUFF);
    assert.equal(layer.moon.material.alphaMode, Constants.ALPHA_PREMULTIPLIED_PORTERDUFF);
    for (const body of [layer.sunGlow, layer.moonGlow, layer.stars]) {
      assert.equal(body.material.alphaMode, Constants.ALPHA_ADD);
    }
    assert.equal(layer.sun.mesh.billboardMode, 0);
    assert.equal(layer.sun.mesh.scaling.x, 90);
    assert.equal(layer.sunGlow.mesh.scaling.x, 90 * 3.5);
    assert.equal(layer.moonGlow.mesh.scaling.x, 60 * 3.5);
    approximately(Vector3.Distance(layer.sun.mesh.position, center), celestialDistance);
    assert.equal(layer.sunGlow.material.getActiveTextures()[0], textures.glow);
    assert.equal(layer.moonGlow.material.getActiveTextures()[0], textures.glow);
    assert.equal(layer.sun.material._vectors4.ovTint.w, 1);
    assert.equal(layer.moon.material._vectors4.ovTint.w, 0, "body tint uniforms must not share a mutable vector");
    const starGeometry = layer.stars.mesh.geometry;
    const dayRotation = layer.stars.mesh.rotationQuaternion.clone();
    const night = frame({
      timeOfDay: 0,
      daylightIntensity: 0,
      sunDirection: new Vector3(0, 0.8, -0.6),
      moonDirection: new Vector3(0, -0.8, 0.6),
    });
    for (let moonPhase = 0; moonPhase < 8; moonPhase += 1) {
      layer.applyFrame({...night, moonPhase});
      assert.equal(layer.moon.material.getActiveTextures()[0], textures.moons[moonPhase]);
      assert.equal(layer.moon.material._vectors4.ovTint.w, 1, "moon phase artwork supplies phase coverage, not an extra fade");
    }
    assert.equal(layer.stars.mesh.geometry, starGeometry);
    assert.equal(dayRotation.equals(layer.stars.mesh.rotationQuaternion), false);
    assert.deepEqual(layer.stats(), {sunVisible: false, moonVisible: true, starVisibility: 1});
    layer.dispose();
    for (const body of [layer.sun, layer.moon, layer.sunGlow, layer.moonGlow, layer.stars]) {
      assert.equal(body.mesh.isDisposed(), true);
    }
    assert.ok(scene.textures.includes(textures.glow), "resource owner retains the shared authored texture");
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
