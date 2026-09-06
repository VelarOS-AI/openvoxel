import {createHash} from "node:crypto";
import {isAbsolute, relative, resolve} from "node:path";

export function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a record`);
  }
  return value;
}

export function requireKnownFields(value, fields, label) {
  const known = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!known.has(field)) throw new Error(`${label} contains unknown field ${field}`);
  }
  return value;
}

export function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be non-empty text`);
  return value;
}

export function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export function requireNumber(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a number from ${minimum} through ${maximum}`);
  }
  return value;
}

export function requireList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a list`);
  return value;
}

export function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

export function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonical(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(canonical(value));
}

export function sha256(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

export function resolveInside(root, file, label) {
  const path = resolve(root, requireText(file, label));
  const local = relative(root, path);
  if (local === "" || local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(local)) {
    throw new Error(`${label} escapes the resource data directory`);
  }
  return path;
}

export function uniqueByKey(values, owner, label) {
  const keys = new Set();
  for (const raw of requireList(values, label)) {
    const value = requireRecord(raw, `${label} entry`);
    const key = requireText(value.key, `${label} key`);
    if (!key.startsWith(`${owner}:`)) throw new Error(`${label} key ${key} does not belong to ${owner}`);
    if (keys.has(key)) throw new Error(`${label} repeats ${key}`);
    keys.add(key);
  }
  return keys;
}

export function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}
