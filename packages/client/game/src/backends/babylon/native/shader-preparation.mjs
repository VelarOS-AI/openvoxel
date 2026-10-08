import {Effect} from "@babylonjs/core/Materials/effect.js";
import {getStateObject} from "@babylonjs/core/Engines/thinEngine.functions.js";

// Resolve one live preparation per animation frame. Promise continuations run
// before the next callback, keeping batches of include expansion/plugin
// injection out of a single render task. Cached Effects bypass this queue.
export class ShaderPreparationQueue {
  constructor(requestFrame, cancelFrame) {
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.pending = new Map();
    this.frame = null;
    this.closed = false;
  }
  wait(alive) {
    if (this.closed) return Promise.resolve(false);
    return new Promise(resolve => {
      this.pending.set(resolve, alive);
      this.schedule();
    });
  }
  schedule() {
    if (this.frame !== null || this.closed || this.pending.size === 0) return;
    this.frame = this.requestFrame(() => {
      this.frame = null;
      for (const [resolve, alive] of this.pending) {
        this.pending.delete(resolve);
        const valid = alive();
        resolve(valid);
        if (valid) break;
      }
      this.schedule();
    });
  }
  close() {
    this.closed = true;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    for (const resolve of this.pending.keys()) resolve(false);
    this.pending.clear();
  }
}

const queues = new WeakMap();
function queueFor(engine) {
  let queue = queues.get(engine);
  if (!queue) {
    const host = engine.getHostWindow();
    queue = new ShaderPreparationQueue(host.requestAnimationFrame.bind(host), host.cancelAnimationFrame.bind(host));
    queues.set(engine, queue);
    engine.onDisposeObservable.addOnce(() => { queue.close(); queues.delete(engine); });
  }
  return queue;
}

class StreamingEffect extends Effect {
  async _processShaderCodeAsync(processor = null, keepPipeline = false, context = null, initialize) {
    const request = this.preparationRequest = (this.preparationRequest ?? 0) + 1;
    const alive = () => !this.isDisposed && !this._engine.isDisposed && this.preparationRequest === request;
    if (initialize) await initialize();
    if (!alive() || !await queueFor(this._engine).wait(alive) || !alive()) return;
    return super._processShaderCodeAsync(processor, keepPipeline, context);
  }
}

// Babylon 9.23 factory contract, confined to our two engine subclasses. Keep
// key construction, reference acquisition, callbacks and restoration intact;
// only the newly allocated Effect's preprocessing gains an asynchronous turn.
export function createStreamingEffect(engine, baseName, options, uniformsOrEngine, samplers, defines, fallbacks, onCompiled, onError, indexParameters, language = 0, initialize) {
  const vertex = typeof baseName === "string" ? baseName : baseName.vertexToken || baseName.vertexSource || baseName.vertexElement || baseName.vertex;
  const fragment = typeof baseName === "string" ? baseName : baseName.fragmentToken || baseName.fragmentSource || baseName.fragmentElement || baseName.fragment;
  const globalDefines = engine._getGlobalDefines();
  let fullDefines = defines ?? options.defines ?? "";
  if (globalDefines) fullDefines += (engine.isWebGPU ? "\n" : "") + globalDefines;
  const name = vertex + "+" + fragment + "@" + fullDefines;
  const existing = engine._compiledEffects[name];
  if (existing) {
    if (onCompiled && existing.isReady()) onCompiled(existing);
    existing._refCount++;
    return existing;
  }
  if (engine._gl) getStateObject(engine._gl);
  const effect = new StreamingEffect(baseName, options, options.attributes !== undefined ? engine : uniformsOrEngine,
    samplers, engine, defines, fallbacks, onCompiled, onError, indexParameters, name,
    options.shaderLanguage ?? language, options.extraInitializationsAsync ?? initialize);
  engine._compiledEffects[name] = effect;
  return effect;
}
