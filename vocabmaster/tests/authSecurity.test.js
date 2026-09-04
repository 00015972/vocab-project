'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

process.env.CREATOR_ACCESS_CODE = 'test-private-invite-code';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-at-least-32-characters';
process.env.NODE_ENV = 'test';

const authRoute = read('src/routes/auth.js');
const authMiddleware = read('src/middleware/auth.js');
const adminMiddleware = read('src/middleware/admin.js');
const userModel = read('src/models/User.js');
const apiClient = read('public/js/api.js');
const server = read('server.js');
const creatorDashboard = read('public/creator-dashboard-new.html');

assert(!authRoute.includes("router.post('/creator-access'"), 'creator-access bypass route must not exist');
assert(!creatorDashboard.includes("/auth/creator-access"), 'creator dashboard must not auto-authenticate');
assert(adminMiddleware.includes("if (role !== 'admin')"), 'admin middleware must require the admin role');
assert(!adminMiddleware.includes("role !== 'admin' && role !== 'creator'"), 'creators must not receive admin privileges');

assert(authMiddleware.includes("AUTH_COOKIE_NAME = 'vm_auth'"), 'authentication must accept the HttpOnly cookie');
assert(authMiddleware.includes("algorithms: ['HS256']"), 'JWT algorithm must be pinned');
assert(authMiddleware.includes('user.isActive === false'), 'deactivated users must be rejected');
assert(authMiddleware.includes('!user.isVerified'), 'unverified users must be rejected');
assert(authMiddleware.includes('decoded.sessionVersion'), 'revoked sessions must be rejected');

assert(authRoute.includes("crypto.createHash('sha256')"), 'one-time email tokens must be hashed');
assert(authRoute.includes('MIN_PASSWORD_LENGTH = 12'), 'password minimum must be 12 characters');
assert(userModel.includes('minlength: 12'), 'database password validation must match the API');
assert(userModel.includes('sessionVersion'), 'users must carry a session revocation version');

assert(!apiClient.includes("localStorage.setItem('token', token)"), 'raw JWTs must not be stored in localStorage');
assert(apiClient.includes("AUTH_SESSION_MARKER = 'http-only-cookie'"), 'legacy pages should receive only a non-secret marker');
assert(apiClient.includes("credentials: 'include'"), 'API calls must send the session cookie');

assert(server.includes('validateProductionConfig'), 'production secrets must be validated at startup');
assert(server.includes("app.set('trust proxy', 1)"), 'secure cookies must work behind Railway proxying');
assert(server.includes("referrerPolicy: { policy: 'no-referrer' }"), 'reset tokens must not leak through referrers');

async function runMiddleware(middleware, req) {
  let statusCode = 200;
  let payload = null;
  let nextCalled = false;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
  };
  await middleware(req, res, () => { nextCalled = true; });
  return { statusCode, payload, nextCalled };
}

async function main() {
  const jwt = require('jsonwebtoken');
  const dbConfigPath = require.resolve('../src/config/db');
  const devStorePath = require.resolve('../src/services/devStore');
  const authMiddlewarePath = require.resolve('../src/middleware/auth');
  const adminMiddlewarePath = require.resolve('../src/middleware/admin');
  const dbConfig = require(dbConfigPath);
  const devStore = require(devStorePath);
  const originalDbCheck = dbConfig.isDbConnected;
  const originalFindUser = devStore.findUserById;

  dbConfig.isDbConnected = () => false;
  devStore.findUserById = () => ({
    _id: 'user-1',
    email: 'student@example.com',
    role: 'student',
    isActive: true,
    isVerified: true,
    sessionVersion: 3,
  });
  delete require.cache[authMiddlewarePath];
  delete require.cache[adminMiddlewarePath];
  const auth = require(authMiddlewarePath);
  const admin = require(adminMiddlewarePath);
  const token = jwt.sign({ id: 'user-1', sessionVersion: 3 }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    issuer: 'vocabmaster',
    audience: 'vocabmaster-web',
    subject: 'user-1',
    expiresIn: '5m',
  });

  const valid = await runMiddleware(auth, { headers: { cookie: `vm_auth=${encodeURIComponent(token)}` } });
  assert(valid.nextCalled, 'a valid cookie session should authenticate');

  const revokedToken = jwt.sign({ id: 'user-1', sessionVersion: 2 }, process.env.JWT_SECRET, {
    algorithm: 'HS256', issuer: 'vocabmaster', audience: 'vocabmaster-web', subject: 'user-1', expiresIn: '5m',
  });
  const revoked = await runMiddleware(auth, { headers: { cookie: `vm_auth=${encodeURIComponent(revokedToken)}` } });
  assert.strictEqual(revoked.statusCode, 401, 'a revoked session should be rejected');

  const creatorDenied = await runMiddleware(admin, { user: { id: 'user-1' } });
  assert.strictEqual(creatorDenied.statusCode, 403, 'a non-admin must not pass admin middleware');

  dbConfig.isDbConnected = originalDbCheck;
  devStore.findUserById = originalFindUser;
  console.log('auth security regression tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
