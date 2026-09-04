require('dotenv').config();
const mongoose = require('mongoose');
const Word = require('../src/models/Word');
const Progress = require('../src/models/Progress');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const smokeWordRegex = /^smoke_word_/i;

  const deletedWords = await Word.deleteMany({ word: smokeWordRegex });

  const queueCleanup = await Progress.updateMany(
    { 'adaptiveQueue.activeQueue.items.word': smokeWordRegex },
    {
      $set: {
        'adaptiveQueue.activeQueue': null,
      },
    }
  );

  console.log(JSON.stringify({
    deletedSmokeWords: deletedWords.deletedCount || 0,
    resetQueues: queueCleanup.modifiedCount || 0,
  }));

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err.message || err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
