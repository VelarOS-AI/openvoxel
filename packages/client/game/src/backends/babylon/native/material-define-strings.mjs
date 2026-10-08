import {MaterialDefines} from "@babylonjs/core/Materials/materialDefines.js";

const serialize = MaterialDefines.prototype.toString;
const capacity = 32;

function matches(entry, defines) {
  const keys = defines._keys;
  if (keys.length !== entry.keys.length) return false;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (key !== entry.keys[index] || defines[key] !== entry.values[index]) return false;
  }
  return true;
}

// Voxel submeshes prepare the same small set of PBR variants repeatedly. Share
// only the serialized text, never defines, Effects, readiness or GPU bindings.
// Compare every ordered key/value even when Babylon's dirty flags are clear.
export class MaterialDefineStrings {
  constructor() {
    this.entries = [];
    this.next = 0;
    this.last = null;
    this.hints = new WeakMap();
  }

  attach(defines) {
    if (defines.toString !== serialize) return;
    const cache = this;
    // Non-enumerable: MaterialDefines.rebuild must not see a new shader macro.
    Object.defineProperty(defines, "toString", {
      configurable: true, writable: true, value() { return cache.read(this); },
    });
  }

  read(defines) {
    const hint = this.entries[this.hints.get(defines)];
    if (hint && matches(hint, defines)) return hint.text;
    if (this.last && matches(this.last, defines)) return this.last.text;
    for (const entry of this.entries) {
      if (entry !== this.last && matches(entry, defines)) {
        this.last = entry;
        this.hints.set(defines, entry.slot);
        return entry.text;
      }
    }
    const keys = defines._keys.slice();
    const entry = {keys, values: keys.map(key => defines[key]), text: serialize.call(defines), slot: this.next};
    this.entries[this.next] = entry;
    this.hints.set(defines, this.next);
    this.next = (this.next + 1) % capacity;
    this.last = entry;
    return entry.text;
  }

  clear() {
    this.entries.length = 0;
    this.next = 0;
    this.last = null;
    this.hints = new WeakMap();
  }
}
