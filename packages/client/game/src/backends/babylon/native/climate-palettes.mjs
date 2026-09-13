// Climate-map corners: cold/dry, warm/dry, cold/wet, warm/wet.
// Species palettes follow the owned reference assets' BlockColorsMap contract.
// CPU and GLSL are generated from one table so screenshot and shader policy agree.
export const climatePalettes = Object.freeze({
  1: [[151, 184, 195], [210, 201, 93], [151, 184, 195], [79, 225, 56]],
  2: [[96, 161, 123], [174, 164, 42], [96, 161, 123], [30, 191, 1]],
  3: [[0, 0, 120], [0, 80, 100], [0, 40, 85], [0, 113, 97]],
  5: [[96, 161, 155], [129, 174, 42], [96, 161, 155], [1, 191, 53]],
  6: [[146, 191, 176], [160, 191, 176], [146, 191, 166], [150, 201, 141]],
  7: [[80, 110, 90], [110, 110, 50], [80, 110, 90], [110, 110, 50]],
  8: [[76, 181, 96], [174, 109, 42], [66, 215, 116], [77, 235, 96]],
  9: [[76, 181, 96], [174, 109, 42], [56, 205, 106], [67, 215, 86]],
  10: [[90, 141, 165], [119, 152, 51], [86, 141, 165], [1, 158, 65]],
});

const clamp = v => Math.max(0, Math.min(1, v));
export function climatePaletteColor(role, temperatureCelsius, humidity) {
  const corners = climatePalettes[role] ?? climatePalettes[1];
  // WorldClimate has already applied height and season to Celsius. Convert once;
  // do not cool the same sample a second time using vertex elevation.
  const t = clamp((temperatureCelsius / 2.5 + 3) / 8);
  const h = clamp((humidity * 15 - 4) / 10);
  return corners[0].map((c, i) => ((c * (1 - t) + corners[1][i] * t) * (1 - h)
    + (corners[2][i] * (1 - t) + corners[3][i] * t) * h) / 255);
}

const vector = rgb => `vec3(${rgb.map(v => (v / 255).toFixed(9)).join(", ")})`;
export const climatePaletteShader = `
vec3 ovPaletteMix(vec3 coldDry, vec3 warmDry, vec3 coldWet, vec3 warmWet, vec2 amounts) {
  return mix(mix(coldDry, warmDry, amounts.x), mix(coldWet, warmWet, amounts.x), amounts.y);
}
vec3 ovClimatePalette(float role, vec4 climate) {
  vec2 amounts = clamp(vec2((climate.x / 2.5 + 3.0) / 8.0, (climate.y * 15.0 - 4.0) / 10.0), 0.0, 1.0);
  ${Object.entries(climatePalettes).map(([role, colors]) => `if (abs(role - ${Number(role).toFixed(1)}) < 0.5) return ovPaletteMix(${colors.map(vector).join(", ")}, amounts);`).join("\n  ")}
  return ovPaletteMix(${climatePalettes[1].map(vector).join(", ")}, amounts);
}`;
