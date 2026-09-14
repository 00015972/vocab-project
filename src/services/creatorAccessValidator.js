const crypto = require('crypto');

function _toBuffer(input) {
  return Buffer.from(String(input || ''), 'utf8');
}

function _safeEqualBuffers(aBuf, bBuf) {
  try {
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch (e) {
    return false;
  }
}

function normalizeCode(code) {
  return String(code || '').trim();
}

function validateCreatorAccessCode(candidate) {
  const c = normalizeCode(candidate);
  if (!c) return false;

  const configured = normalizeCode(process.env.CREATOR_ACCESS_CODE || '');
  if (configured) {
    const candBuf = _toBuffer(c);
    const confBuf = _toBuffer(configured);
    if (candBuf.length === confBuf.length) {
      return _safeEqualBuffers(candBuf, confBuf);
    }
    return false;
  }

  const listRaw = String(process.env.CREATOR_ACCESS_LIST || '').trim();
  if (listRaw) {
    const list = listRaw.split(',').map((s) => normalizeCode(s).toUpperCase());
    return list.includes(c.toUpperCase());
  }

  return false;
}

module.exports = { validateCreatorAccessCode };
