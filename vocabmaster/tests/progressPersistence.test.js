const test = require('node:test');
const assert = require('node:assert/strict');
const { saveProgressForUser } = require('../src/services/progressPersistence');

test('saveProgressForUser persists the supplied progress document in DB mode', async () => {
  let saveCount = 0;
  const progress = {
    userId: 'user-1',
    adaptiveQueue: { activeQueue: { status: 'active' } },
    save: async () => {
      saveCount += 1;
    },
  };

  const result = await saveProgressForUser({
    userId: 'user-1',
    progress,
    isDbConnected: true,
    Progress: {},
    devStore: {
      saveProgress: () => {
        throw new Error('dev store should not be used in DB mode');
      },
    },
    clearCache: () => {},
    progressCache: null,
    createEmptyProgress: () => ({ userId: 'user-1' }),
  });

  assert.equal(saveCount, 1);
  assert.equal(result, progress);
});
