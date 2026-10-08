import sharp from "sharp";

const size = 96;
const camera = [0.56, 0.48, 0.68];
const right = [0.772, 0, -0.635];
const up = [-0.305, 0.878, -0.371];
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

function quad(face, corners, normal) {
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const vertices = corners.map((point, i) => [...point, ...normal, ...uv[i]]);
  return [[0, 1, 2], [0, 2, 3]].map(indices => ({face, vertices: indices.flatMap(i => vertices[i])}));
}

function box(height) {
  return [
    ...quad("side", [[1,0,1],[1,0,0],[1,height,0],[1,height,1]], [1,0,0]),
    ...quad("side", [[0,0,0],[0,0,1],[0,height,1],[0,height,0]], [-1,0,0]),
    ...quad("front", [[0,0,1],[1,0,1],[1,height,1],[0,height,1]], [0,0,1]),
    ...quad("back", [[1,0,0],[0,0,0],[0,height,0],[1,height,0]], [0,0,-1]),
    ...quad("top", [[0,height,0],[0,height,1],[1,height,1],[1,height,0]], [0,1,0]),
    ...quad("bottom", [[0,0,1],[0,0,0],[1,0,0],[1,0,1]], [0,-1,0]),
  ];
}

function trianglesFor(model, properties) {
  if (model.geometry) return model.geometry.triangles;
  switch (model.kind) {
    case "cross": case "submerged_cross":
      return [
        ...quad("side", [[0,0,0],[1,0,1],[1,1,1],[0,1,0]], [-0.707,0,0.707]),
        ...quad("side", [[1,0,0],[0,0,1],[0,1,1],[1,1,0]], [0.707,0,0.707]),
      ];
    case "wall_overlay":
      return quad("side", [[0,0,0.5],[1,0,0.5],[1,1,0.5],[0,1,0.5]], [0,0,1]);
    case "ground_cover": return box((properties.layers ?? 1) / 16);
    case "snow_layer": return box((properties.layers ?? 1) / 8);
    case "fluid": return box(Math.max(1 / 16, 1 - (properties.level ?? 0) / 16));
    case "cube": case "column": return box(1);
    default: throw new Error(`Missing inventory geometry for ${model.key}`);
  }
}

function previewTint(tint) {
  const tintColor = tint ? [tint.red, tint.green, tint.blue] : [1, 1, 1];
  if (tint && tint.climate !== "none" && tint.climate !== "aquatic_foliage") {
    const climate = tint.climate === "water" ? [0.38, 0.64, 0.82]
      : tint.climate.includes("evergreen") || tint.climate.includes("spruce") ? [0.48, 0.65, 0.43]
      : tint.climate === "birch_foliage" ? [0.64, 0.76, 0.39] : [0.53, 0.76, 0.33];
    for (let i = 0; i < 3; i++) tintColor[i] *= climate[i];
  }
  return tintColor;
}

// Cross plants use one front-facing sprite in inventory, independent of their world billboard rotation.
export async function renderPlantPreview(part, textureFor) {
  const {render, tint} = part;
  const key = render.textures.front ?? render.textures.all ?? render.textures.top ?? render.textures.side;
  const texture = textureFor(key);
  const pixels = Buffer.from(texture.pixels);
  const color = previewTint(tint);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.round(pixels[offset + channel] * color[channel]);
  }
  return sharp(pixels, {raw: {width: texture.width, height: texture.height, channels: 4}})
    .flip().trim().resize(size - 12, size - 12, {fit: "contain", kernel: "nearest", background: "#00000000"})
    .extend({top: 6, bottom: 6, left: 6, right: 6, background: "#00000000"}).png().toBuffer();
}

// Orthographic software rendering happens at build time. The HUD needs no extra GPU contexts.
export async function renderBlockPreview(parts, properties, textureFor) {
  const surfaces = parts.map(part => ({...part, triangles: trianglesFor(part.model, properties)}));
  const triangles = surfaces.flatMap(surface => surface.triangles);
  const vertices = triangles.flatMap(t => [t.vertices.slice(0, 3), t.vertices.slice(8, 11), t.vertices.slice(16, 19)]);
  const xs = vertices.map(p => dot(p, right));
  const ys = vertices.map(p => dot(p, up));
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = (size - 12) / Math.max(maxX - minX, maxY - minY);
  const rgba = Buffer.alloc(size * size * 4);
  const depth = new Float64Array(size * size).fill(-Infinity);
  for (const {render, model, tint, triangles} of surfaces) {
    const tintColor = previewTint(tint);
    for (const triangle of triangles) {
      const normal = triangle.vertices.slice(3, 6);
      if (render.cullFaces && dot(normal, camera) < 0) continue;
      const face = triangle.face;
      const textureKey = render.textures[face] ?? render.textures.side ?? render.textures.all;
      const texture = textureFor(textureKey);
      const points = [0, 8, 16].map(offset => {
        const point = triangle.vertices.slice(offset, offset + 3);
        return [size / 2 + (dot(point, right) - (minX + maxX) / 2) * scale,
          size / 2 - (dot(point, up) - (minY + maxY) / 2) * scale,
          dot(point, camera), triangle.vertices[offset + 6], triangle.vertices[offset + 7]];
      });
      const [a, b, c] = points;
      const area = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(area) < 0.000001) continue;
      const lowX = Math.max(0, Math.floor(Math.min(...points.map(p => p[0]))));
      const highX = Math.min(size - 1, Math.ceil(Math.max(...points.map(p => p[0]))));
      const lowY = Math.max(0, Math.floor(Math.min(...points.map(p => p[1]))));
      const highY = Math.min(size - 1, Math.ceil(Math.max(...points.map(p => p[1]))));
      const shade = 0.62 + 0.38 * Math.max(0, normal[1]) + 0.16 * Math.abs(normal[2]);
      for (let y = lowY; y <= highY; y++) for (let x = lowX; x <= highX; x++) {
        const wa = ((b[1] - c[1]) * (x + 0.5 - c[0]) + (c[0] - b[0]) * (y + 0.5 - c[1])) / area;
        const wb = ((c[1] - a[1]) * (x + 0.5 - c[0]) + (a[0] - c[0]) * (y + 0.5 - c[1])) / area;
        const wc = 1 - wa - wb;
        if (Math.min(wa, wb, wc) < -0.000001) continue;
        const z = wa * a[2] + wb * b[2] + wc * c[2];
        const pixel = y * size + x;
        if (z <= depth[pixel]) continue;
        const u = wa * a[3] + wb * b[3] + wc * c[3];
        const v = wa * a[4] + wb * b[4] + wc * c[4];
        const tx = Math.max(0, Math.min(texture.width - 1, Math.floor(u * texture.width)));
        const ty = Math.max(0, Math.min(texture.height - 1, Math.floor(v * texture.height)));
        const source = (ty * texture.width + tx) * 4;
        if (texture.pixels[source + 3] < 96) continue;
        // Grass side textures contain a neutral cap above the untinted soil.
        const applyTint = tint?.coverage !== "grass_cap" || face === "top" || (face !== "bottom" && v > 0.82);
        for (let i = 0; i < 3; i++) {
          rgba[pixel * 4 + i] = Math.min(255, Math.round(texture.pixels[source + i] * shade
            * (applyTint ? tintColor[i] : 1) * (model.geometry?.color?.[i] ?? 1)));
        }
        rgba[pixel * 4 + 3] = 255;
        depth[pixel] = z;
      }
    }
  }
  return sharp(rgba, {raw: {width: size, height: size, channels: 4}}).png().toBuffer();
}
