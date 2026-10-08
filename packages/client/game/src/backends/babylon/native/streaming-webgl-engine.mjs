import {Engine} from "@babylonjs/core/Engines/engine.js";
import {createStreamingEffect} from "./shader-preparation.mjs";

export class StreamingWebGLEngine extends Engine {
  createEffect(...args) { return createStreamingEffect(this, ...args); }
}
