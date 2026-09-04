require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Word = require('../src/models/Word');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const studentEmail = 'obidov20@gmail.com';
  const student = await User.findOne({ email: studentEmail }).select('_id name email role linkedCreatorCode creatorCode').lean();

  const creators = await User.find({ role: 'creator' }).select('_id name email creatorCode').lean();
  const creatorRows = [];
  for (const creator of creators) {
    const total = await Word.countDocuments({ userId: creator._id });
    const smoke = await Word.countDocuments({ userId: creator._id, word: /^smoke_word_/i });
    creatorRows.push({
      creatorId: String(creator._id),
      name: creator.name,
      email: creator.email,
      creatorCode: creator.creatorCode || null,
      totalWords: total,
      smokeWords: smoke,
      realWords: total - smoke,
    });
  }

  console.log(JSON.stringify({
    student: student ? {
      id: String(student._id),
      name: student.name,
      email: student.email,
      role: student.role,
      linkedCreatorCode: student.linkedCreatorCode || null,
      creatorCode: student.creatorCode || null,
    } : null,
    creators: creatorRows,
    totals: {
      creators: creatorRows.length,
      creatorsWithAnyWords: creatorRows.filter((r) => r.totalWords > 0).length,
      creatorsWithRealWords: creatorRows.filter((r) => r.realWords > 0).length,
    },
  }, null, 2));

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
