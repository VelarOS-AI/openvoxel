const storageKey = "openvoxel.settings.v1";
const range = (value, minimum, maximum) => typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : null;
export const defaultSettings = Object.freeze({
  renderBackend: "auto",
  renderScale: .85, viewDistance: 5, fov: 60, brightness: 0.95, saturation: -5,
  shadows: true, softShadows: false, antialias: true, bloom: false, waterReflections: true, particles: true, vegetationMotion: true,
  masterVolume: 1, effectsVolume: 1, ambientVolume: 1, muteUnfocused: true,
  sensitivity: 1, invertY: false,
  forwardKey: "KeyW", backwardKey: "KeyS", leftKey: "KeyA", rightKey: "KeyD", jumpKey: "Space", sprintKey: "ShiftLeft", crouchKey: "KeyC", descendKey: "ControlLeft",
  minimap: true, crosshair: true, toolbar: true,
  timeMode: "auto", hour: 12, season: "auto", weather: "auto", precipitation: 0.6, wind: 1, fog: 1,
});
const numericRanges = {renderScale: [.5, 1], viewDistance: [3, 8], fov: [45, 100], brightness: [.6, 1.5], saturation: [-25, 15], masterVolume: [0, 1], effectsVolume: [0, 1], ambientVolume: [0, 1], sensitivity: [.2, 3], hour: [0, 23.5], precipitation: [.1, 1], wind: [0, 2], fog: [.5, 2]};
export const graphicsProfiles = Object.freeze({
  low: {renderScale: .65, viewDistance: 3, shadows: false, softShadows: false, antialias: true, bloom: false, waterReflections: false, particles: false, vegetationMotion: true},
  balanced: {renderScale: .85, viewDistance: 5, shadows: true, softShadows: false, antialias: true, bloom: false, waterReflections: true, particles: true, vegetationMotion: true},
  high: {renderScale: 1, viewDistance: 6, shadows: true, softShadows: true, antialias: true, bloom: true, waterReflections: true, particles: true, vegetationMotion: true},
  ultra: {renderScale: 1, viewDistance: 8, shadows: true, softShadows: true, antialias: true, bloom: true, waterReflections: true, particles: true, vegetationMotion: true},
});


export function recommendGraphicsPreset({cores = 0, memory = 0, pixels = 0, mobile = false} = {}) {
  if ((cores > 0 && cores <= 4) || (memory > 0 && memory <= 4)) return "low";
  if (!mobile && cores >= 12 && (memory === 0 || memory >= 8) && pixels > 0 && pixels <= 6_000_000) return "high";
  return "balanced";
}
export function activeGraphicsPreset(settings) {
  return Object.keys(graphicsProfiles).find(name => Object.entries(graphicsProfiles[name]).every(([key, value]) => settings[key] === value)) ?? "custom";
}

export const bindingKeys = Object.keys(defaultSettings).filter(key => key.endsWith("Key"));
export function validBinding(code) { return typeof code === "string" && code !== "KeyE" && /^(Key[A-Z]|Arrow(Up|Down|Left|Right)|Space|ShiftLeft|ControlLeft)$/u.test(code); }
export function normalizeSettings(input) {
  const result = {...defaultSettings};
  if (input === null || typeof input !== "object" || Array.isArray(input)) return result;
  for (const key of Object.keys(result)) {
    const value = input[key];
    if (key in numericRanges) {
      const number = range(value, ...numericRanges[key]);
      if (number !== null) result[key] = key === "viewDistance" ? Math.round(number) : number;
    } else if (typeof result[key] === "boolean") {
      if (typeof value === "boolean") result[key] = value;
    } else if (bindingKeys.includes(key)) {
      if (validBinding(value)) result[key] = value;
    } else if (key === "renderBackend" && ["auto", "webgpu", "webgl"].includes(value)) result[key] = value;
    else if (key === "timeMode" && ["auto", "fixed"].includes(value)) result[key] = value;
    else if (key === "season" && ["auto", "spring", "summer", "autumn", "winter"].includes(value)) result[key] = value;
    else if (key === "weather" && ["auto", "clear", "cloudy", "rain", "snow"].includes(value)) result[key] = value;
  }
  // A damaged saved map cannot make two actions share the same key.
  if (new Set(bindingKeys.map(key => result[key])).size !== bindingKeys.length) for (const key of bindingKeys) result[key] = defaultSettings[key];
  return result;
}
export function createSettingsStore(storage = null, device = {}) {
  const recommended = recommendGraphicsPreset(device);
  const deviceDefaults = Object.freeze({...defaultSettings, ...graphicsProfiles[recommended]});
  let current = deviceDefaults, persistenceError = "";
  const listeners = new Set();
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) ?? "null");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) current = Object.freeze(normalizeSettings({...deviceDefaults, ...saved}));
  } catch { /* Defaults recover unavailable or malformed storage. */ }
  function publish(next) {
    current = Object.freeze(normalizeSettings(next));
    try { storage?.setItem(storageKey, JSON.stringify(current)); persistenceError = ""; }
    catch { persistenceError = "浏览器未能保存偏好；本次调整仍然有效。"; }
    for (const listener of listeners) listener(current);
    return current;
  }
  return {
    get: () => current,
    error: () => persistenceError,
    set(key, value) {
      if (!Object.hasOwn(defaultSettings, key)) throw new Error("Unknown setting " + key);
      const next = {...current, [key]: value};
      if (bindingKeys.includes(key)) {
        if (!validBinding(value)) throw new Error("E 用于物品栏，请选择其他字母、方向键、空格、左 Shift 或左 Ctrl。");
        const conflict = bindingKeys.find(other => other !== key && current[other] === value);
        if (conflict) next[conflict] = current[key];
      }
      return publish(next);
    },
    reset: () => publish(deviceDefaults),
    recommended: () => recommended,
    preset(name) {
      if (!(name in graphicsProfiles)) throw new Error("Unknown graphics preset");
      return publish({...current, ...graphicsProfiles[name]});
    },
    subscribe(listener) { listeners.add(listener); return {close: () => { listeners.delete(listener); }}; },
  };
}
let store;
function preferences() {
  if (store === undefined) {
    let storage = null;
    try { storage = globalThis.localStorage ?? null; } catch { /* Session settings still work. */ }
    store = createSettingsStore(storage, {
      cores: globalThis.navigator?.hardwareConcurrency ?? 0,
      memory: globalThis.navigator?.deviceMemory ?? 0,
      pixels: (globalThis.innerWidth ?? 0) * (globalThis.innerHeight ?? 0) * (globalThis.devicePixelRatio ?? 1) ** 2,
      mobile: globalThis.matchMedia?.('(pointer: coarse)').matches ?? false,
    });
  }
  return store;
}
export const gameSettings = () => preferences().get();
export const setGameSetting = (key, value) => preferences().set(key, value);
export const resetGameSettings = () => preferences().reset();
export const applyGraphicsPreset = name => preferences().preset(name);
export const recommendedGraphicsPreset = () => preferences().recommended();
export const settingsPersistenceError = () => preferences().error();
export const subscribeGameSettings = listener => preferences().subscribe(listener);
export const settingNumber = (settings, key) => Number(settings[key]);
export const settingText = (settings, key) => String(settings[key]);
export const settingBoolean = (settings, key) => settings[key] === true;

export const createGameSettingsPort = () => ({recommended: recommendedGraphicsPreset, profile: activeGraphicsPreset, get: gameSettings, set: setGameSetting, reset: resetGameSettings, preset: applyGraphicsPreset, error: settingsPersistenceError, subscribe: subscribeGameSettings, number: settingNumber, text: settingText, boolean: settingBoolean});
