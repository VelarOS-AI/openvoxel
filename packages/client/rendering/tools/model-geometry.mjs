import {readFile} from "node:fs/promises";
import {requireList, requireNumber, requireRecord, resolveInside} from "./resource-pack-values.mjs";

export async function loadModelGeometry(dataRoot, file) {
  if (file == null) return null;
  let source = requireRecord(JSON.parse(await readFile(resolveInside(dataRoot, file, "model geometry"), "utf8")), file);
  if (source.elements != null) source = importCuboidModel(source, file);
  if (source.schemaVersion !== 1) throw new Error(`Unsupported model geometry version in ${file}`);
  const color = requireList(source.color, "model color").map(v => requireNumber(v, 0, 1, "model color"));
  if (color.length !== 3) throw new Error(`Model ${file} color must contain RGB`);
  const triangles = requireList(source.triangles, "model triangles").map(raw => {
    const triangle = requireRecord(raw, "model triangle");
    if (!["top", "side"].includes(triangle.face)) throw new Error(`Invalid texture face in ${file}`);
    const vertices = requireList(triangle.vertices, "model vertices");
    if (vertices.length !== 24) throw new Error(`Model ${file} requires three position/normal/UV vertices per triangle`);
    for (let offset = 0; offset < 24; offset += 8) {
      for (let i = 0; i < 3; i++) requireNumber(vertices[offset + i], -0.1, 1.1, "block-local model position");
      for (let i = 3; i < 6; i++) requireNumber(vertices[offset + i], -1, 1, "model normal");
      const normalLength = Math.hypot(...vertices.slice(offset + 3, offset + 6));
      if (Math.abs(normalLength - 1) > 0.001) throw new Error(`Unnormalized model normal in ${file}`);
      for (let i = 6; i < 8; i++) requireNumber(vertices[offset + i], 0, 1, "tile-local model UV");
    }
    return {face: triangle.face, vertices};
  });
  if (!triangles.length || triangles.length > 1024) throw new Error(`Model ${file} exceeds the triangle budget`);
  return {color, triangles};
}

// Import bounded cuboids from authored Minecraft model JSON. Textures remain logical
// pack resources; source model paths and expressions are never evaluated at runtime.
function importCuboidModel(source, file) {
  const triangles = [];
  const definitions = {
    down: {normal: [0,-1,0], corners: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]]},
    up: {normal: [0,1,0], corners: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]]},
    north: {normal: [0,0,-1], corners: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]]},
    south: {normal: [0,0,1], corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]]},
    west: {normal: [-1,0,0], corners: [[0,0,0],[0,0,1],[0,1,1],[0,1,0]]},
    east: {normal: [1,0,0], corners: [[1,0,1],[1,0,0],[1,1,0],[1,1,1]]},
  };
  const elements = requireList(source.elements, `${file} elements`);
  if (!elements.length || elements.length > 64) throw new Error(`${file} exceeds the cuboid budget`);
  for (const element of elements) {
    if (element.rotation != null) throw new Error(`${file} rotated cuboids require an explicit mesh import`);
    const from = requireList(element.from, 'cuboid from'), to = requireList(element.to, 'cuboid to');
    if (from.length !== 3 || to.length !== 3) throw new Error(`${file} cuboid coordinates need three axes`);
    from.forEach((value, axis) => { requireNumber(value,0,16,'cuboid lower'); requireNumber(to[axis],value,16,'cuboid upper'); });
    for (const [direction, face] of Object.entries(requireRecord(element.faces,'cuboid faces'))) {
      const definition = definitions[direction];
      if (!definition || face.texture !== '#all' || face.rotation != null) throw new Error(`${file} uses an unsupported cuboid face`);
      const uv = requireList(face.uv,'cuboid uv');
      if (uv.length !== 4) throw new Error(`${file} face requires four UV bounds`);
      uv.forEach(value => requireNumber(value,0,16,'cuboid uv'));
      const uvPoints = [[uv[0],uv[3]],[uv[2],uv[3]],[uv[2],uv[1]],[uv[0],uv[1]]];
      const vertices = definition.corners.map((corner,index) => [
        ...corner.map((high,axis) => (high ? to[axis] : from[axis])/16),
        ...definition.normal, ...uvPoints[index].map(value => value/16),
      ]);
      for (const indices of [[0,1,2],[0,2,3]]) triangles.push({face: direction === 'up' ? 'top' : 'side',vertices: indices.flatMap(index => vertices[index])});
    }
  }
  return {schemaVersion:1,color:[1,1,1],triangles};
}
