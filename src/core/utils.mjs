import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

function normalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not allow non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  }
  throw new TypeError(`Canonical JSON does not allow ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function sha256(value) {
  const input = typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value);
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

export function parseJson(value, fallback = null) {
  return value === null || value === undefined ? fallback : JSON.parse(value);
}

export function opaqueId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export function opaqueKey() {
  return randomUUID();
}

export function systemClock() {
  return new Date();
}

export function iso(clock = systemClock) {
  return clock().toISOString();
}

export async function measure(fn) {
  const started = performance.now();
  const value = await fn();
  return { value, duration_ms: Number((performance.now() - started).toFixed(3)) };
}

export function addMinutes(isoValue, minutes) {
  return new Date(new Date(isoValue).getTime() + minutes * 60_000).toISOString();
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
