import {gameSettings, subscribeGameSettings} from "../../settings/preferences.mjs";
import {weatherAudioLevels} from "../../environment/weather-dynamics.mjs";

const audioRoot = "/generated/audio/";

const footsteps = Object.freeze({
  glass: ["Stone", "FootstepStone", 2],
  grass: ["Dirt", "FootstepDirt", 5],
  gravel: ["Dirt", "FootstepDirt", 5],
  leaves: ["Plant", "FootstepPlant", 3],
  magma: ["Stone", "FootstepStone", 2],
  sand: ["Sand", "FootstepsSand", 4],
  snow: ["Snow", "FootstepSnow", 5],
  stone: ["Stone", "FootstepStone", 2],
  water: ["Water", "FootstepWater", 3],
  wood: ["Wood", "FootstepWood", 4],
});

const impacts = Object.freeze({
  glass: ["Glass", "ImpactGlass", 3],
  grass: ["Dirt", "ImpactDirt", 2],
  gravel: ["Dirt", "ImpactDirt", 2],
  leaves: ["Plant", "ImpactPlant", 1],
  magma: ["Stone", "ImpactStone", 4],
  sand: ["Dirt", "ImpactDirt", 2],
  snow: ["Dirt", "ImpactDirt", 2],
  stone: ["Stone", "ImpactStone", 4],
  water: ["Soft", "ImpactSoft", 3],
  wood: ["Wood", "ImpactWood", 2],
});

function soundName(key) {
  return typeof key === "string" && key.startsWith("openvoxel:sound/")
    ? key.slice("openvoxel:sound/".length) : null;
}

function variation([folder, prefix, count], category) {
  return `${category}/${folder}/${prefix}${1 + Math.floor(Math.random() * count)}.flac`;
}

export function createAudioAdapter(canvas) {
  if (!(canvas instanceof canvas.ownerDocument.defaultView.HTMLCanvasElement)) {
    throw new TypeError("World audio requires a canvas element");
  }
  const document = canvas.ownerDocument;
  const browser = document.defaultView;
  const AudioContext = browser.AudioContext || browser.webkitAudioContext;
  const buffers = new Map();
  const loops = new Map();
  const sources = new Set();
  const oneShots = new Set();
  let focused = true;
  const audible = () => !gameSettings().muteUnfocused || (focused && document.visibilityState !== "hidden");
  let context = null;
  let environment = null;
  let waterLevel = 0;
  let magmaLevel = 0;
  let listenerPosition = null;
  let lightningSequence = null;
  let closed = false;

  function bufferFor(path) {
    if (!buffers.has(path)) {
      const pending = browser.fetch(`${audioRoot}${path}`)
        .then(response => {
          if (!response.ok) throw new Error(`Audio asset ${path} returned HTTP ${response.status}`);
          return response.arrayBuffer();
        })
        .then(bytes => context.decodeAudioData(bytes))
        .catch(error => {
          console.warn(`Could not load audio asset ${path}`, error);
          return null;
        });
      buffers.set(path, pending);
    }
    return buffers.get(path);
  }

  function startSource(buffer, level, rate = 1, loop = false, when = 0, filter = null) {
    if (closed || context === null) return null;
    const source = context.createBufferSource();
    const output = context.createGain();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.value = rate;
    const shot = {output, level};
    if (!loop) oneShots.add(shot);
    output.gain.value = loop ? level : (audible() ? level * gameSettings().masterVolume * gameSettings().effectsVolume : 0);
    source.connect(output).connect(filter ?? context.destination);
    if (filter !== null) filter.connect(context.destination);
    sources.add(source);
    source.onended = () => { oneShots.delete(shot); sources.delete(source); source.disconnect(); output.disconnect(); filter?.disconnect(); };
    source.start(Math.max(context.currentTime, when));
    return {source, output};
  }

  function playFile(path, level, rate = 1, delay = 0) {
    if (context === null || context.state !== "running" || !audible()) return;
    const when = context.currentTime + delay;
    void bufferFor(path).then(buffer => {
      if (buffer !== null && context?.state === "running" && audible()) {
        startSource(buffer, level, rate, false, when);
      }
    });
  }

  function loopFile(name, path) {
    void bufferFor(path).then(buffer => {
      if (buffer === null || closed || loops.has(name)) return;
      const channel = startSource(buffer, 0, 1, true);
      if (channel !== null) {
        loops.set(name, channel);
        applyEnvironment();
      }
    });
  }

  function applyEnvironment() {
    if (context === null) return;
    const visible = audible();
    const settings = gameSettings();
    for (const shot of oneShots) shot.output.gain.setTargetAtTime(visible ? shot.level * settings.masterVolume * settings.effectsVolume : 0, context.currentTime, 0.03);
    const mix = weatherAudioLevels(environment, listenerPosition ?? {x: 0, z: 0});
    const levels = {Rain: mix.rain, Wind: mix.wind, Water: 0.25 * waterLevel * mix.water, Magma: 0.25 * magmaLevel};
    loops.get("Wind")?.filter.frequency.setTargetAtTime(mix.windCutoff, context.currentTime, 0.7);
    for (const [name, channel] of loops) {
      channel.output.gain.setTargetAtTime(visible ? levels[name] * settings.masterVolume * settings.ambientVolume : 0, context.currentTime, name === "Wind" ? 0.7 : 0.3);
    }
  }

  function unlock() {
    if (closed || AudioContext === undefined || !audible()) return;
    try {
      if (context === null) {
        context = new AudioContext();
        loopFile("Rain", "Rain.flac");
        loopFile("Water", "Water.flac");
        loopFile("Magma", "Magma.flac");
        // Procedural filtered wind, separate from the original game recordings.
        // One short looping buffer; no per-frame audio allocation or worklet.
        const sampleRate = 22050;
        const buffer = context.createBuffer(1, sampleRate * 6, sampleRate);
        const noise = buffer.getChannelData(0);
        let previous = 0;
        for (let i = 0; i < noise.length; i += 1) {
          previous = previous * 0.97 + (Math.random() * 2 - 1) * 0.03;
          noise[i] = previous * 3;
        }
        // Match both ends over 100ms to remove the loop-boundary click.
        const overlap = sampleRate / 10;
        for (let i = 0; i < overlap; i += 1) {
          const t = i / (overlap - 1);
          noise[noise.length - overlap + i] = noise[noise.length - overlap + i] * (1 - t) + noise[i] * t;
        }
        const filter = context.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 800;
        filter.Q.value = 0.5;
        const channel = startSource(buffer, 0, 1, true, 0, filter);
        channel.source.loopStart = 0.1;
        loops.set("Wind", {...channel, filter});
        applyEnvironment();
      }
      if (context.state !== "running") void context.resume().catch(() => null);
    } catch (error) {
      console.warn("Could not start world audio", error);
    }
  }

  function visibilityChanged() {
    if (closed || context === null) return;
    applyEnvironment();
    if (!audible()) void context.suspend().catch(() => null);
    else if (context.state !== "running") void context.resume().catch(() => null);
  }

  const settingsSubscription = subscribeGameSettings(visibilityChanged);
  const blur = () => { focused = false; visibilityChanged(); };
  const focus = () => { focused = true; visibilityChanged(); };
  browser.addEventListener?.("blur", blur);
  browser.addEventListener?.("focus", focus);
  canvas.addEventListener("pointerdown", unlock);
  document.addEventListener("visibilitychange", visibilityChanged);

  return {
    play(action, group) {
      if (closed || context === null) return;
      const name = soundName(group);
      if (name === null || name === "none") return;
      if (action === "place") {
        playFile("BlockPlaced.flac", 0.55);
      } else if (action === "break") {
        const profile = impacts[name];
        if (profile !== undefined) playFile(variation(profile, "Impacts"), 0.55);
      } else if (action === "step" || action === "land") {
        const profile = footsteps[name];
        if (profile !== undefined) playFile(variation(profile, "Footsteps"), action === "land" ? 0.5 : 0.3);
      }
    },
    setAmbient(water, magma) {
      if (closed) return;
      waterLevel = Math.max(0, Math.min(1, water));
      magmaLevel = Math.max(0, Math.min(1, magma));
      applyEnvironment();
    },
    setListenerPosition(position) {
      if (!closed) listenerPosition = position;
    },
    setEnvironment(sample) {
      if (closed) return;
      environment = sample;
      applyEnvironment();
      const lightning = sample.lightning;
      if (lightning === null || lightning === undefined || lightningSequence === lightning.sequence) return;
      lightningSequence = lightning.sequence;
      const distance = listenerPosition === null ? 0 : Math.hypot(
        lightning.position.x - listenerPosition.x,
        lightning.position.y - listenerPosition.y,
        lightning.position.z - listenerPosition.z,
      );
      if (distance >= 200) return;
      const folder = distance < 40 ? "ThunderNear" : "ThunderFar";
      const index = 1 + Math.floor(Math.random() * 2);
      const age = Math.max(0, ((sample.worldMilliseconds ?? 0) - (lightning.occurredAtWorldMilliseconds ?? sample.worldMilliseconds ?? 0)) / 1000);
      playFile(`${folder}/${folder}${index}.flac`, 0.75 * lightning.intensity, 1, Math.max(0, distance / 343 - age));
    },
    async close() {
      if (closed) return null;
      closed = true;
      settingsSubscription.close();
      browser.removeEventListener?.("blur", blur);
      browser.removeEventListener?.("focus", focus);
      oneShots.clear();
      canvas.removeEventListener("pointerdown", unlock);
      document.removeEventListener("visibilitychange", visibilityChanged);
      for (const source of sources) source.stop();
      sources.clear();
      loops.clear();
      if (context !== null) await context.close();
      context = null;
      return null;
    },
  };
}
