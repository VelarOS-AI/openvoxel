import {Constants} from "@babylonjs/core/Engines/constants.js";
import {ShaderMaterial} from "@babylonjs/core/Materials/shaderMaterial.js";
import {Vector2, Vector4} from "@babylonjs/core/Maths/math.vector.js";

/** Authored sky textures store premultiplied RGB. Sample them exactly once;
 * a StandardMaterial opacity slot or PREMULTIPLYALPHA define would multiply
 * alpha again. Vertex/uniform fades must scale all four channels together.
 */
export function createEnvironmentSpriteMaterial(scene, name, texture, {additive = false, vertexColors = false} = {}) {
  const material = new ShaderMaterial(name, scene, {
    vertexSource: `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
${vertexColors ? "attribute vec4 color;" : ""}
uniform mat4 worldViewProjection;
uniform vec2 ovUvOffset;
varying vec2 ovUv;
varying vec4 ovColor;
void main(void) {
  ovUv = uv + ovUvOffset;
  ovColor = ${vertexColors ? "color" : "vec4(1.0)"};
  gl_Position = worldViewProjection * vec4(position, 1.0);
  // Sky scale is independent of the terrain visibility/frustum range.
  // Keep its depth behind terrain without widening the terrain depth buffer.
  gl_Position.z = gl_Position.w * (1.0 - 0.000001);
}`,
    fragmentSource: `
precision highp float;
uniform sampler2D ovTexture;
uniform vec4 ovTint;
varying vec2 ovUv;
varying vec4 ovColor;
void main(void) {
  gl_FragColor = texture2D(ovTexture, ovUv) * ovColor * ovTint;
}`,
  }, {
    attributes: vertexColors ? ["position", "uv", "color"] : ["position", "uv"],
    uniforms: ["worldViewProjection", "ovUvOffset", "ovTint"],
    samplers: ["ovTexture"],
    needAlphaBlending: true,
  });
  material.setTexture("ovTexture", texture);
  material.setVector2("ovUvOffset", Vector2.Zero());
  material.setVector4("ovTint", new Vector4(1, 1, 1, 1));
  material.alphaMode = additive ? Constants.ALPHA_ADD : Constants.ALPHA_PREMULTIPLIED_PORTERDUFF;
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.fogEnabled = false;
  return material;
}
