/**
 * Model lists per platform.
 * - Cached on disk for 24 h and returned instantly (stale-while-revalidate: a stale list is still returned
 *   immediately and refreshed in the background).
 * - Concurrent requests share one fetch. Fetching never blocks the hub (async child processes).
 * - Validation returns a pick-list table instead of failing later.
 */
import path from 'node:path';
import { DATA } from '../paths.mjs';
import { readJson, writeJsonAtomic } from '../util.mjs';
import { adapter } from './adapters.mjs';

const CACHE = path.join(DATA, 'hub', 'models-cache.json');
const TTL = 24 * 3600e3;
const inflight = new Map();

const readCache = () => readJson(CACHE, {}) || {};

function fetchAndStore(platform) {
  if (inflight.has(platform)) return inflight.get(platform);
  const p = (async () => {
    const models = await adapter(platform).models().catch(() => []);
    if (models.length) {
      const cache = readCache();
      cache[platform] = { at: Date.now(), models };
      writeJsonAtomic(CACHE, cache);
    }
    return models;
  })().finally(() => inflight.delete(platform));
  inflight.set(platform, p);
  return p;
}

/** Instant when cached; `refresh: true` forces a new fetch (falls back to the cached list if it fails). */
export async function listModels(platform, { refresh = false } = {}) {
  const hit = readCache()[platform];
  if (!refresh && hit?.models?.length) {
    if (Date.now() - hit.at > TTL) fetchAndStore(platform); // background refresh
    return hit.models;
  }
  const models = await fetchAndStore(platform);
  return models.length ? models : hit?.models || [];
}

export function modelsCachedAt(platform) {
  return readCache()[platform]?.at || null;
}

/** Fill the cache in the background (daemon start), one platform at a time so nothing competes. */
export async function warmModelCache(platforms) {
  for (const p of platforms) {
    if (readCache()[p]?.models?.length) continue;
    await fetchAndStore(p).catch(() => {});
  }
}

export async function modelTable(platform) {
  const models = await listModels(platform);
  if (!models.length) return `(${adapter(platform).label} does not publish a model list; use the name from its own docs/config.)`;
  const rows = models.slice(0, 60).map((m) => `| ${m.id} | ${m.name || ''} | ${m.note || (m.efforts?.length ? `effort: ${m.efforts.join(', ')}` : '')} |`);
  return ['| model | name | notes |', '|---|---|---|', ...rows, models.length > 60 ? `| … | ${models.length - 60} more | |` : ''].filter(Boolean).join('\n');
}

/**
 * Returns the model to use. Throws with a table of choices if the platform publishes a list and the
 * requested model is not in it (exact id, or unique case-insensitive / partial match).
 */
export async function resolveModel(platform, requested) {
  const ad = adapter(platform);
  const want = requested || ad.defaultModel || null;
  if (!want) return null;
  const models = await listModels(platform);
  if (!models.length || ad.acceptsAnyModel) return want;
  if (models.some((m) => m.id === want)) return want;
  const lc = want.toLowerCase();
  const near = models.filter((m) => m.id.toLowerCase() === lc || m.id.toLowerCase().includes(lc) || (m.name || '').toLowerCase().includes(lc));
  if (near.length === 1) return near[0].id;
  const err = new Error(`Model "${want}" does not exist for ${ad.label}. Choose one of these:\n${await modelTable(platform)}`);
  err.code = 'MODEL_NOT_FOUND';
  throw err;
}
