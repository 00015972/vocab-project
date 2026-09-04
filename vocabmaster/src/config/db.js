const mongoose = require('mongoose');

let connected = false;
let retryTimer = null;
let connecting = false;

const RETRY_DELAY_MS = 10000;

function hasPlaceholderCredentials(mongoUri) {
  const uri = String(mongoUri || '');
  return (
    uri.includes('YOUR_PASSWORD')
    || uri.includes('YOUR_REAL_PASSWORD')
    || uri.includes('USERNAME:PASSWORD')
  );
}

function shouldForceDevStore() {
  const dbMode = String(process.env.DB_MODE || '').trim().toLowerCase();
  const useDevStore = String(process.env.USE_DEV_STORE || '').trim().toLowerCase();
  return dbMode === 'devstore' || useDevStore === 'true' || useDevStore === '1';
}

async function ensureCreatorCodeSparseIndex(connection) {
  const userCollection = connection.collection('users');
  const indexes = await userCollection.getIndexes();

  const isCompatibleCreatorCodeIndex = (indexInfo) => {
    const expr = indexInfo && indexInfo.partialFilterExpression;
    const creatorExpr = expr && expr.creatorCode;
    const isPartialCompatible = !!(
      indexInfo
      && indexInfo.key
      && indexInfo.key.creatorCode
      && indexInfo.unique === true
      && creatorExpr
      && creatorExpr.$type === 'string'
      && creatorExpr.$exists === true
    );
    const isSparseCompatible = !!(
      indexInfo
      && indexInfo.key
      && indexInfo.key.creatorCode
      && indexInfo.unique === true
      && indexInfo.sparse === true
    );
    return isPartialCompatible || isSparseCompatible;
  };

  let hasCompatibleIndex = false;

  for (const [indexName, indexInfo] of Object.entries(indexes)) {
    if (indexInfo && indexInfo.key && indexInfo.key.creatorCode && isCompatibleCreatorCodeIndex(indexInfo)) {
      hasCompatibleIndex = true;
      continue;
    }
    if (indexInfo && indexInfo.key && indexInfo.key.creatorCode && !isCompatibleCreatorCodeIndex(indexInfo)) {
      await userCollection.dropIndex(indexName);
      console.log(`Dropped incompatible creatorCode index: ${indexName}`);
    }
  }

  if (hasCompatibleIndex) {
    console.log('creatorCode unique index is already compatible');
    return;
  }

  await userCollection.createIndex(
    { creatorCode: 1 },
    {
      unique: true,
      name: 'creatorCode_unique_partial',
      partialFilterExpression: {
        creatorCode: { $exists: true, $type: 'string' },
      },
    }
  );
  console.log('Ensured creatorCode partial unique index');
}

function scheduleReconnect(reason) {
  if (retryTimer || shouldForceDevStore()) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connectDB();
  }, RETRY_DELAY_MS);
  if (reason) {
    console.log(`Scheduling MongoDB reconnect in ${Math.round(RETRY_DELAY_MS / 1000)}s (${reason})`);
  }
}

const connectDB = async () => {
  if (connected || connecting) return;
  connecting = true;

  try {
    if (shouldForceDevStore()) {
      const forcedErr = new Error('Using devStore mode by configuration');
      forcedErr.code = 'DEVSTORE_FORCED';
      throw forcedErr;
    }

    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/vocabmaster';
    if (hasPlaceholderCredentials(mongoUri)) {
      const placeholderErr = new Error('MONGODB_URI contains placeholder credentials. Replace with your real Atlas username/password.');
      placeholderErr.code = 'MONGO_URI_PLACEHOLDER';
      throw placeholderErr;
    }

    const conn = await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });
    connected = true;
    console.log(`MongoDB connected: ${conn.connection.host}`);

    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    try {
      await ensureCreatorCodeSparseIndex(mongoose.connection);
    } catch (indexErr) {
      console.warn(`Index management warning: ${indexErr.message}`);
    }
  } catch (err) {
    connected = false;
    console.log(`Development mode: Using devStore (${err.message})`);
    if (!['DEVSTORE_FORCED', 'MONGO_URI_PLACEHOLDER'].includes(String(err.code || ''))) {
      scheduleReconnect(err.code || err.name || 'connect_error');
    }
  } finally {
    connecting = false;
  }
};

mongoose.connection.on('connected', () => {
  connected = true;
});

mongoose.connection.on('disconnected', () => {
  connected = false;
});

function isDbConnected() {
  return connected;
}

module.exports = { connectDB, isDbConnected };
module.exports.__internals = {
  hasPlaceholderCredentials,
  shouldForceDevStore,
  ensureCreatorCodeSparseIndex,
  scheduleReconnect,
};
