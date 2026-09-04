async function saveProgressForUser({
  userId,
  progress,
  isDbConnected,
  Progress,
  devStore,
  clearCache,
  progressCache,
  createEmptyProgress,
}) {
  if (!progress) return null;

  const dbConnected = typeof isDbConnected === 'function' ? isDbConnected() : Boolean(isDbConnected);

  if (!dbConnected) {
    devStore.saveProgress(userId, progress);
    if (clearCache && progressCache) {
      clearCache(progressCache, 'progress:');
    }
    return progress;
  }

  if (typeof progress.save === 'function') {
    await progress.save();
    if (clearCache && progressCache) {
      clearCache(progressCache, 'progress:');
    }
    return progress;
  }

  let doc = await Progress.findOne({ userId });
  if (!doc) {
    doc = new Progress({ ...(createEmptyProgress ? createEmptyProgress(userId) : { userId }) });
  }

  Object.assign(doc, progress);
  await doc.save();

  if (clearCache && progressCache) {
    clearCache(progressCache, 'progress:');
  }

  return doc;
}

module.exports = {
  saveProgressForUser,
};
