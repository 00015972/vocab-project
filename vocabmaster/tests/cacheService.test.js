const assert = require('assert');
const { createCache, clearByPrefix } = require('../src/services/cacheService');

function run() {
  const cache = createCache();
  cache.set('demo', { ok: true }, 50);
  const hit = cache.get('demo');
  assert.deepStrictEqual(hit, { ok: true });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.strictEqual(cache.get('demo'), null);
      cache.set('alpha', 'one', 1000);
      clearByPrefix(cache, 'alpha');
      assert.strictEqual(cache.get('alpha'), null);
      console.log('cache service tests passed');
      resolve();
    }, 80);
  });
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
