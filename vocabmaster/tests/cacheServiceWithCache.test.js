const assert = require('assert');
const { createCache, withCache } = require('../src/services/cacheService');

async function run() {
  const cache = createCache();
  let calls = 0;

  const first = await withCache(cache, 'demo:key', 1000, async () => {
    calls += 1;
    return { value: 42 };
  });

  const second = await withCache(cache, 'demo:key', 1000, async () => {
    calls += 1;
    return { value: 99 };
  });

  assert.deepStrictEqual(first, { value: 42 });
  assert.deepStrictEqual(second, { value: 42 });
  assert.strictEqual(calls, 1);
  console.log('cache service withCache tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
