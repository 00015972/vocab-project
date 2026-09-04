class MemoryCache {
  constructor() {
    this.store = new Map();
  }

  set(key, value, ttlMs = 60000) {
    const expiresAt = Date.now() + ttlMs;
    this.store.set(key, { value, expiresAt });
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

function createCache() {
  return new MemoryCache();
}

async function withCache(cache, key, ttlMs, factory) {
  if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function') {
    return factory();
  }

  const cached = cache.get(key);
  if (cached !== null && typeof cached !== 'undefined') {
    return cached;
  }

  const value = await factory();
  cache.set(key, value, ttlMs);
  return value;
}

function clearByPrefix(cache, prefix) {
  if (!cache || typeof cache.store?.forEach !== 'function') return;
  cache.store.forEach((value, key) => {
    if (String(key).startsWith(prefix)) {
      cache.store.delete(key);
    }
  });
}

module.exports = { createCache, withCache, clearByPrefix };
