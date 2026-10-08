import {ShaderMaterial} from "@babylonjs/core/Materials/shaderMaterial.js";
import {Mesh} from "@babylonjs/core/Meshes/mesh.js";
import {MeshBuilder} from "@babylonjs/core/Meshes/meshBuilder.js";
import {directionalSkyShader} from "./sky-colors.mjs";

export function createSky(scene, diameter) {
  const material = new ShaderMaterial("openvoxel-sky-material", scene, {
    vertexSource: `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 ovSkyDirection;
void main(void) {
  ovSkyDirection = position;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`,
    fragmentSource: `
precision highp float;
varying vec3 ovSkyDirection;
uniform vec3 ovSkyTop;
uniform vec3 ovHorizon;
uniform vec3 ovGround;
uniform float ovFlash;
uniform vec4 ovAtmosphereSun;
uniform vec3 ovAtmosphereSunColor;
${directionalSkyShader}
void main(void) {
  vec3 direction = normalize(ovSkyDirection);
  vec3 color = ovDirectionalSky(direction, ovSkyTop, ovHorizon, ovGround, ovFlash, ovAtmosphereSun, ovAtmosphereSunColor);
  gl_FragColor = vec4(color, 1.0);
}`,
  }, {
    attributes: ["position"],
    uniforms: ["worldViewProjection", "ovSkyTop", "ovHorizon", "ovGround", "ovFlash", "ovAtmosphereSun", "ovAtmosphereSunColor"],
  });
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.fogEnabled = false;
  const mesh = MeshBuilder.CreateSphere("openvoxel-sky", {
    diameter,
    segments: 20,
    sideOrientation: Mesh.BACKSIDE,
  }, scene);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.applyFog = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.renderingGroupId = 0;
  return {mesh, material};
}
