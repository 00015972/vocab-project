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

/**
 * validateCreatorAccessCode
 * - Supports a single env `CREATOR_ACCESS_CODE` (secure, compared using
 *   constant-time comparison when lengths match).
 * - Supports a comma-separated allowlist in `CREATOR_ACCESS_LIST` (useful for
 *   rotating or multiple allowed tokens). Allowlist comparison is done after
 *   normalization.
 * - Returns boolean (true = valid)
 */
function validateCreatorAccessCode(candidate) {
  const c = normalizeCode(candidate).toUpperCase();
  if (!c) return false;

  const configured = normalizeCode(process.env.CREATOR_ACCESS_CODE || '').toUpperCase();
  if (configured) {
    const candBuf = _toBuffer(c);
    const confBuf = _toBuffer(configured);
    if (candBuf.length === confBuf.length) {
      return _safeEqualBuffers(candBuf, confBuf);
    }
    // lengths differ -> not equal
    return false;
  }

  // Fallback: allowlist (comma-separated) for deployments that prefer many codes
  const listRaw = String(process.env.CREATOR_ACCESS_LIST || '').trim();
  if (listRaw) {
    const list = listRaw.split(',').map((s) => normalizeCode(s).toUpperCase());
    return list.includes(c.toUpperCase());
  }

  return false;
}

module.exports = {
  validateCreatorAccessCode,
};
