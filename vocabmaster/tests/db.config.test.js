const test = require('node:test');
const assert = require('node:assert/strict');

const dbConfig = require('../src/config/db');

const {
  hasPlaceholderCredentials,
  shouldForceDevStore,
  ensureCreatorCodeSparseIndex,
} = dbConfig.__internals;

test('hasPlaceholderCredentials detects template values', () => {
  assert.equal(hasPlaceholderCredentials('mongodb+srv://x:YOUR_PASSWORD@cluster/db'), true);
  assert.equal(hasPlaceholderCredentials('mongodb+srv://x:USERNAME:PASSWORD@cluster/db'), true);
  assert.equal(hasPlaceholderCredentials('mongodb://localhost:27017/vocabmaster'), false);
});

test('shouldForceDevStore honors DB_MODE and USE_DEV_STORE', () => {
  const previousDbMode = process.env.DB_MODE;
  const previousUseDevStore = process.env.USE_DEV_STORE;

  try {
    process.env.DB_MODE = 'devstore';
    process.env.USE_DEV_STORE = '';
    assert.equal(shouldForceDevStore(), true);

    process.env.DB_MODE = '';
    process.env.USE_DEV_STORE = 'true';
    assert.equal(shouldForceDevStore(), true);

    process.env.DB_MODE = '';
    process.env.USE_DEV_STORE = '0';
    assert.equal(shouldForceDevStore(), false);
  } finally {
    process.env.DB_MODE = previousDbMode;
    process.env.USE_DEV_STORE = previousUseDevStore;
  }
});

test('ensureCreatorCodeSparseIndex drops incompatible creatorCode index and skips create when compatible index exists', async () => {
  const dropped = [];
  const created = [];

  const fakeConnection = {
    collection(name) {
      assert.equal(name, 'users');
      return {
        async getIndexes() {
          return {
            _id_: { key: { _id: 1 } },
            creatorCode_1: { key: { creatorCode: 1 }, unique: true, sparse: false },
            creatorCode_1_partial: {
              key: { creatorCode: 1 },
              unique: true,
              partialFilterExpression: { creatorCode: { $exists: true, $type: 'string' } },
            },
          };
        },
        async dropIndex(indexName) {
          dropped.push(indexName);
        },
        async createIndex(key, options) {
          created.push({ key, options });
        },
      };
    },
  };

  await ensureCreatorCodeSparseIndex(fakeConnection);

  assert.deepEqual(dropped, ['creatorCode_1']);
  assert.equal(created.length, 0);
});

test('ensureCreatorCodeSparseIndex creates partial unique index when no compatible index exists', async () => {
  const created = [];

  const fakeConnection = {
    collection(name) {
      assert.equal(name, 'users');
      return {
        async getIndexes() {
          return {
            _id_: { key: { _id: 1 } },
          };
        },
        async dropIndex() {
          throw new Error('dropIndex should not be called when no creatorCode index exists');
        },
        async createIndex(key, options) {
          created.push({ key, options });
        },
      };
    },
  };

  await ensureCreatorCodeSparseIndex(fakeConnection);

  assert.equal(created.length, 1);
  assert.deepEqual(created[0].key, { creatorCode: 1 });
  assert.deepEqual(created[0].options, {
    unique: true,
    name: 'creatorCode_unique_partial',
    partialFilterExpression: { creatorCode: { $exists: true, $type: 'string' } },
  });
});
