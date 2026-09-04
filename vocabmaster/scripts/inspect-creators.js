require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Word = require('../src/models/Word');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const grouped = await Word.aggregate([
    {
      $group: {
        _id: '$userId',
        total: { $sum: 1 },
        smoke: {
          $sum: {
            $cond: [
              { $regexMatch: { input: '$word', regex: '^smoke_word_' } },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { total: -1 } },
    { $limit: 30 },
  ]);

  for (const row of grouped) {
    const user = await User.findById(row._id).select('name email role creatorCode').lean();
    if (!user) continue;
    const real = Number(row.total || 0) - Number(row.smoke || 0);
    if (real <= 0) continue;
    console.log(JSON.stringify({
      userId: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      creatorCode: user.creatorCode || null,
      total: row.total,
      smoke: row.smoke,
      real,
    }));
  }

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
