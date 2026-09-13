import {readFile} from "node:fs/promises";
import {requireList, requireNumber, requireRecord, resolveInside} from "./resource-pack-values.mjs";

export async function loadModelGeometry(dataRoot, file) {
  if (file == null) return null;
  const source = requireRecord(JSON.parse(await readFile(resolveInside(dataRoot, file, "model geometry"), "utf8")), file);
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
