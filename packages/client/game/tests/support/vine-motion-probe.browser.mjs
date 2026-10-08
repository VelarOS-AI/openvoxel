import {VegetationMotionPlugin} from "../../src/backends/babylon/native/vegetation-motion.mjs";

// Execute the production vertex motion on actual meshed vines. Transform
// feedback lets us test their shared edges, which a screenshot cannot measure.
export function probeVineMotion(scene, plugin) {
  const vertices = [];
  const joins = new Map();
  const input = [];
  for (const mesh of scene.meshes) {
    if (mesh.material?.pluginManager?.getPlugin("OpenVoxelVegetationMotion") !== plugin) continue;
    const positions = mesh.getVerticesData("position");
    const normals = mesh.getVerticesData("normal");
    const uvs = mesh.getVerticesData("uv");
    for (let i = 0; i < positions.length / 3; i++) {
      const local = Array.from(positions.slice(i * 3, i * 3 + 3));
      const normal = Array.from(normals.slice(i * 3, i * 3 + 3));
      const origin = mesh.position.asArray();
      const position = local.map((value, axis) => value + origin[axis]);
      const key = [...position, ...normal].join(":");
      const group = joins.get(key) ?? [];
      group.push(vertices.length);
      joins.set(key, group);
      vertices.push({position, normal, chunk: origin.join(":")});
      input.push(...local, ...normal, uvs[i * 2], uvs[i * 2 + 1], ...origin);
    }
  }
  if (vertices.length === 0) throw new Error("Vine motion probe has no vertices");
  const shared = [...joins.values()].filter(group => group.length > 1);
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("Vine motion probe needs WebGL 2");
  const buffers = [], shaders = [], programs = [];
  const vao = gl.createVertexArray();
  const feedback = gl.createTransformFeedback();
  try {
    gl.bindVertexArray(vao);
    const source = gl.createBuffer();
    buffers.push(source);
    gl.bindBuffer(gl.ARRAY_BUFFER, source);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(input), gl.STATIC_DRAW);
    let offset = 0;
    for (const [index, size] of [3, 3, 2, 3].entries()) {
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, size, gl.FLOAT, false, 44, offset * 4);
      offset += size;
    }
    const output = gl.createBuffer();
    buffers.push(output);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
    gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, vertices.length * 12, gl.STREAM_READ);
    const compile = (type, code) => {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const measure = mode => {
      // Production instances have cached code and shared UBO declarations.
      // This standalone oracle varies the mode and binds plain GL uniforms.
      const code = VegetationMotionPlugin.prototype.getCustomCode.call({mode}, "vertex");
      const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
precision highp float;
layout(location = 0) in vec3 point;
layout(location = 1) in vec3 faceNormal;
layout(location = 2) in vec2 texcoord;
layout(location = 3) in vec3 origin;
out vec3 moved;
${VegetationMotionPlugin.prototype.getUniforms().vertex}
${code.CUSTOM_VERTEX_DEFINITIONS}
void main() {
  vec3 positionUpdated = point;
  vec3 normalUpdated = faceNormal;
  vec2 uvUpdated = texcoord;
  mat4 world = mat4(1.0);
  world[3] = vec4(origin, 1.0);
  ${code.CUSTOM_VERTEX_UPDATE_POSITION}
  moved = (world * vec4(positionUpdated, 1.0)).xyz;
  gl_Position = vec4(0.0);
}`);
      const fragment = compile(gl.FRAGMENT_SHADER, "#version 300 es\nprecision highp float; out vec4 color; void main() {color = vec4(1.0);}");
      const program = gl.createProgram();
      programs.push(program);
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.transformFeedbackVaryings(program, ["moved"], gl.INTERLEAVED_ATTRIBS);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      const anchor = vertices[0].position;
      gl.uniform4f(gl.getUniformLocation(program, "ovVegetationPlayer"), anchor[0] - 6, anchor[1], anchor[2] - 6, 0);
      const stats = {maximumGap: 0, maximumNormalOffset: 0, maximumMotion: 0, calmMotion: 0};
      for (const [windX, windZ, time] of [[0, 0, 0], [12, 7, 0.3], [-8, 10, 1.7], [5, -9, 4.2]]) {
        gl.uniform4f(gl.getUniformLocation(program, "ovVegetationWind"), windX, windZ, 0, time);
        gl.enable(gl.RASTERIZER_DISCARD);
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArrays(gl.POINTS, 0, vertices.length);
        gl.endTransformFeedback();
        gl.disable(gl.RASTERIZER_DISCARD);
        const result = new Float32Array(vertices.length * 3);
        gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, result);
        if (gl.getError() !== gl.NO_ERROR) throw new Error("Vine transform feedback failed");
        for (const [index, {position, normal}] of vertices.entries()) {
          const delta = position.map((value, axis) => result[index * 3 + axis] - value);
          const motion = Math.hypot(...delta);
          stats.maximumMotion = Math.max(stats.maximumMotion, motion);
          if (time === 0) stats.calmMotion = Math.max(stats.calmMotion, motion);
          stats.maximumNormalOffset = Math.max(stats.maximumNormalOffset, Math.abs(delta.reduce((sum, value, axis) => sum + value * normal[axis], 0)));
        }
        for (const group of shared) for (const index of group.slice(1)) {
          stats.maximumGap = Math.max(stats.maximumGap, Math.hypot(...[0, 1, 2].map(axis => result[index * 3 + axis] - result[group[0] * 3 + axis])));
        }
      }
      return stats;
    };
    const corrected = measure("vine");
    const grassOracle = measure("cross");
    return {...corrected, grassOracleGap: grassOracle.maximumGap, vertices: vertices.length, joins: shared.length,
      chunkJoins: shared.filter(group => new Set(group.map(index => vertices[index].chunk)).size > 1).length};
  } finally {
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.deleteTransformFeedback(feedback);
    gl.deleteVertexArray(vao);
    for (const buffer of buffers) gl.deleteBuffer(buffer);
    for (const program of programs) gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
