const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { isDbConnected } = require('../config/db');
const devStore = require('../services/devStore');

const AUTH_COOKIE_NAME = 'vm_auth';
const JWT_ISSUER = 'vocabmaster';
const JWT_AUDIENCE = 'vocabmaster-web';

function readCookie(cookieHeader, name) {
  const pairs = String(cookieHeader || '').split(';');
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function extractToken(req) {
  const cookieToken = readCookie(req.headers.cookie, AUTH_COOKIE_NAME);
  if (cookieToken) return cookieToken;

  const authHeader = String(req.headers.authorization || '');
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim() || null;
  }
  return null;
}

async function authMiddleware(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ message: 'No valid session was provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    const userId = String(decoded.sub || decoded.id || '');
    if (!userId) throw new Error('Token subject is missing.');

    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production' && !isDbConnected()) {
      return res.status(503).json({ message: 'Authentication is temporarily unavailable.' });
    }

    const user = isDbConnected()
      ? await User.findById(userId).select('_id name email role creatorCode linkedCreatorCode avatar createdAt isVerified isActive sessionVersion')
      : devStore.findUserById(userId);

    if (!user || user.isActive === false) {
      return res.status(401).json({ message: 'This session is no longer active.' });
    }
    if (!user.isVerified) {
      return res.status(403).json({ message: 'Email verification is required.' });
    }
    const currentVersion = Math.max(0, Number(user.sessionVersion) || 0);
    if (currentVersion !== Math.max(0, Number(decoded.sessionVersion) || 0)) {
      return res.status(401).json({ message: 'This session has been revoked.' });
    }

    req.user = { id: userId };
    req.authUser = user;
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Session is invalid or has expired.' });
  }
}

authMiddleware.__internals = { readCookie, extractToken };

module.exports = authMiddleware;
