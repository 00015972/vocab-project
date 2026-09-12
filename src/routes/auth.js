const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const { sendPasswordResetEmail, isEmailServiceConfigured } = require('../services/email');
const authMiddleware = require('../middleware/auth');
const { isDbConnected } = require('../config/db');
const devStore = require('../services/devStore');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CREATOR_ACCESS_CODE = String(process.env.CREATOR_ACCESS_CODE || '').trim();
const AUTH_COOKIE_NAME = 'vm_auth';
const AUTH_COOKIE_MAX_AGE_MS = Math.max(60_000, Number(process.env.JWT_COOKIE_MAX_AGE_MS) || (7 * 24 * 60 * 60 * 1000));
const JWT_ISSUER = 'vocabmaster';
const JWT_AUDIENCE = 'vocabmaster-web';
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;
let googleClient = null;

function isProductionMode() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidCreatorAccessCode(candidateCode) {
  const candidate = Buffer.from(String(candidateCode || '').trim(), 'utf8');
  const configured = Buffer.from(CREATOR_ACCESS_CODE, 'utf8');
  return candidate.length > 0
    && configured.length > 0
    && candidate.length === configured.length
    && crypto.timingSafeEqual(candidate, configured);
}

function validatePassword(password, label = 'Password') {
  if (typeof password !== 'string') return `${label} is required.`;
  if (password.length < MIN_PASSWORD_LENGTH) return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `${label} must be no more than ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

function hashOneTimeToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function authCookieOptions() {
  return {
    httpOnly: true,
    secure: isProductionMode(),
    sameSite: 'strict',
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
  };
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProductionMode(),
    sameSite: 'strict',
    path: '/',
  });
}

function requirePersistentDatabase(res) {
  if (isProductionMode() && !isDbConnected()) {
    res.status(503).json({ message: 'Authentication is temporarily unavailable.' });
    return false;
  }
  return true;
}

function isGoogleSignInConfigured() {
  return (
    GOOGLE_CLIENT_ID &&
    !GOOGLE_CLIENT_ID.includes('your-google-client-id') &&
    GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com')
  );
}

function getGoogleClient() {
  if (!isGoogleSignInConfigured()) {
    throw new Error('Google Sign-In is not configured. Set GOOGLE_CLIENT_ID in .env.');
  }
  if (!googleClient) {
    googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
  }
  return googleClient;
}

function issueAuthToken(user) {
  const userId = String(user && (user._id || user.id) || '');
  const sessionVersion = Math.max(0, Number(user && user.sessionVersion) || 0);
  return jwt.sign({ id: userId, sessionVersion }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    subject: userId,
  });
}

function establishAuthSession(res, user) {
  res.cookie(AUTH_COOKIE_NAME, issueAuthToken(user), authCookieOptions());
}

function normalizeRole(input) {
  return String(input || 'student').toLowerCase() === 'creator' ? 'creator' : 'student';
}

function buildCreatorCode() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
}

async function generateUniqueCreatorCode() {
  let code = buildCreatorCode();
  for (let i = 0; i < 8; i += 1) {
    const existing = await User.findOne({ creatorCode: code }).select('_id');
    if (!existing) return code;
    code = buildCreatorCode();
  }
  return `${Date.now().toString(36).slice(-6)}`.toUpperCase();
}

function buildAuthUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    role: user.role || 'student',
    creatorCode: user.creatorCode || null,
    linkedCreatorCode: user.linkedCreatorCode || null,
    avatar: user.avatar || null,
  };
}

router.get('/google/config', (req, res) => {
  res.json({
    enabled: isGoogleSignInConfigured(),
    clientId: isGoogleSignInConfigured() ? GOOGLE_CLIENT_ID : null,
  });
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    if (!requirePersistentDatabase(res)) return;
    const { name, password, role, creatorPortalCode } = req.body;
    const email = normalizeEmail(req.body.email);
    const linkedCreatorCode = String(req.body.linkedCreatorCode || '').trim().toUpperCase();
    const normalizedRole = normalizeRole(role);
    if (!name || !email || !password)
      return res.status(400).json({ message: 'Name, email and password are required.' });
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ message: passwordError });
    if (normalizedRole === 'creator') {
      if (!CREATOR_ACCESS_CODE) {
        return res.status(403).json({ message: 'Creator registration is disabled.' });
      }
      if (!isValidCreatorAccessCode(creatorPortalCode)) {
        return res.status(403).json({ message: 'Invalid creator access code.' });
      }
    }
    if (normalizedRole === 'student' && linkedCreatorCode) {
      if (!isDbConnected()) {
        const creatorExists = devStore.listUsers().some((u) => u.creatorCode === linkedCreatorCode);
        if (!creatorExists)
          return res.status(404).json({ message: 'Creator class code not found.' });
      } else {
        const creatorExists = await User.findOne({ creatorCode: linkedCreatorCode }).select('_id');
        if (!creatorExists)
          return res.status(404).json({ message: 'Creator class code not found.' });
      }
    }

    if (!isDbConnected()) {
      const existingLocal = devStore.findUserByEmail(email);
      if (existingLocal)
        return res.status(409).json({ message: 'An account with this email already exists.' });
      const passwordHash = await bcrypt.hash(password, 12);
      const localCreatorCode = normalizedRole === 'creator' ? buildCreatorCode() : '';
      const localUser = devStore.createUser({
        name,
        email,
        passwordHash,
        isVerified: true,
        role: normalizedRole,
        creatorCode: localCreatorCode,
        linkedCreatorCode: normalizedRole === 'student' && linkedCreatorCode ? linkedCreatorCode.toUpperCase() : '',
      });

      const userResp = {
        id: localUser._id,
        name: localUser.name,
        email: localUser.email,
        role: localUser.role,
        creatorCode: localUser.creatorCode || null,
        linkedCreatorCode: localUser.linkedCreatorCode || null,
        createdAt: new Date().toISOString(),
      };

      establishAuthSession(res, localUser);
      return res.status(201).json({
        user: userResp,
        message: normalizedRole === 'creator'
          ? `Creator account created in local mode. Your class code is ${localCreatorCode}.`
          : 'Student account created in local mode. You can log in now.',
        creatorCode: localCreatorCode || null,
      });
    }

    const existing = await User.findOne({ email });
    if (existing)
      return res.status(409).json({ message: 'An account with this email already exists.' });
    let resolvedCreatorCode = null;
    if (normalizedRole === 'creator') {
      resolvedCreatorCode = await generateUniqueCreatorCode();
    }

    const user = new User({
      name,
      email,
      password,
      role: normalizedRole,
      creatorCode: resolvedCreatorCode,
      linkedCreatorCode: normalizedRole === 'student' && linkedCreatorCode ? linkedCreatorCode.toUpperCase() : undefined,
      isVerified: true,
    });
    await user.save();

    const userResp = buildAuthUser(user);
    establishAuthSession(res, user);
    return res.status(201).json({
      user: userResp,
      message: normalizedRole === 'creator'
        ? `Creator account created! Your class code is ${user.creatorCode}. You can log in now.`
        : 'Student account created! You can log in now.',
      emailVerificationRequired: false,
      creatorCode: user.creatorCode || null,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ message: 'Server error during registration.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    if (!requirePersistentDatabase(res)) return;
    const email = normalizeEmail(req.body.email);
    const { password, role } = req.body;
    const requestedRole = role ? String(role).toLowerCase() : null;
    const expectedRole = ['student', 'creator', 'admin'].includes(requestedRole)
      ? requestedRole
      : null;
    if (!email || !password)
      return res.status(400).json({ message: 'Email and password are required.' });

    if (!isDbConnected()) {
      const user = devStore.findUserByEmail(email);
      if (!user) return res.status(401).json({ message: 'Invalid email or password.' });
      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) return res.status(401).json({ message: 'Invalid email or password.' });
      if (user.isActive === false) {
        return res.status(403).json({ message: 'Your account is deactivated. Contact support.' });
      }
      const effectiveRole = user.role || 'creator';
      if (expectedRole && expectedRole !== effectiveRole) {
        return res.status(403).json({ message: `This account is registered as ${effectiveRole}. Use the correct portal.` });
      }
      if (!user.isVerified) return res.status(403).json({ message: 'Please verify your email before logging in.' });

      const updatedUser = devStore.updateUser(user._id, { lastLogin: new Date().toISOString() }) || user;
      establishAuthSession(res, updatedUser);
      return res.json({
        user: buildAuthUser(updatedUser),
      });
    }

    const user = await User.findOne({ email });
    if (!user)
      return res.status(401).json({ message: 'Invalid email or password.' });
    const isMatch = await user.comparePassword(password);
    if (!isMatch)
      return res.status(401).json({ message: 'Invalid email or password.' });
    if (user.isActive === false) {
      return res.status(403).json({ message: 'Your account is deactivated. Contact support.' });
    }
    const effectiveRole = user.role || 'creator';
    if (expectedRole && expectedRole !== effectiveRole) {
      return res.status(403).json({ message: `This account is registered as ${effectiveRole}. Use the correct portal.` });
    }

    user.lastLogin = new Date();
    await user.save();
    establishAuthSession(res, user);
    res.json({
      user: buildAuthUser(user),
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error during login.' });
  }
});

// POST /api/auth/google
router.post('/google', async (req, res) => {
  try {
    if (!requirePersistentDatabase(res)) return;
    const { credential, role } = req.body;
    const expectedRole = role ? normalizeRole(role) : null;
    if (expectedRole === 'creator') {
      return res.status(403).json({ message: 'Creator accounts must use email and password.' });
    }
    if (!credential) {
      return res.status(400).json({ message: 'Google credential is required.' });
    }

    const ticket = await getGoogleClient().verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ message: 'Invalid Google token payload.' });
    }
    if (!payload.email_verified) {
      return res.status(403).json({ message: 'Google email is not verified.' });
    }

    const email = String(payload.email).toLowerCase();
    const name = payload.name || email.split('@')[0] || 'Google User';

    if (!isDbConnected()) {
      let localUser = devStore.findUserByEmail(email);
      if (!localUser) {
        const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12);
        localUser = devStore.createUser({ name, email, passwordHash, isVerified: true, role: 'student' });
      } else if (!localUser.isVerified) {
        localUser = devStore.updateUser(localUser._id, { isVerified: true });
      }
      if (localUser.isActive === false) {
        return res.status(403).json({ message: 'Your account is deactivated. Contact support.' });
      }
      if ((localUser.role || 'creator') === 'creator') {
        return res.status(403).json({ message: 'Creator accounts must use email and password.' });
      }

      localUser = devStore.updateUser(localUser._id, { lastLogin: new Date().toISOString() }) || localUser;
      establishAuthSession(res, localUser);
      return res.json({
        user: buildAuthUser(localUser),
      });
    }

    let user = await User.findOne({ email });
    if (!user) {
      user = new User({
        name,
        email,
        password: crypto.randomBytes(24).toString('hex'),
        isVerified: true,
        isActive: true,
        role: 'student',
      });
      await user.save();
    } else if (!user.isVerified) {
      user.isVerified = true;
      user.verificationToken = undefined;
      user.verificationExpires = undefined;
      await user.save();
    }
    if (user.isActive === false) {
      return res.status(403).json({ message: 'Your account is deactivated. Contact support.' });
    }
    if ((user.role || 'creator') === 'creator') {
      return res.status(403).json({ message: 'Creator accounts must use email and password.' });
    }

    user.lastLogin = new Date();
    await user.save();
    establishAuthSession(res, user);
    return res.json({
      user: buildAuthUser(user),
    });
  } catch (err) {
    console.error('Google auth error:', err);
    return res.status(500).json({ message: 'Google sign-in failed.' });
  }
});

// GET /api/auth/verify-email?token=xxx
router.get('/verify-email', async (req, res) => {
  try {
    if (!requirePersistentDatabase(res)) return;
    if (!isDbConnected()) {
      return res.json({ message: 'Email verification is skipped in local mode.' });
    }
    if (!isEmailServiceConfigured()) {
      return res.json({ message: 'Email verification is disabled because email service is not configured.' });
    }

    const { token } = req.query;
    if (!token)
      return res.status(400).json({ message: 'Verification token is missing.' });

    const user = await User.findOne({
      verificationToken: hashOneTimeToken(token),
      verificationExpires: { $gt: new Date() },
    });

    if (!user)
      return res.status(400).json({ message: 'Invalid or expired verification link. Please register again.' });

    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationExpires = undefined;
    await user.save();

    res.json({ message: 'Email verified successfully! You can now log in.' });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ message: 'Server error during verification.' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    if (!requirePersistentDatabase(res)) return;
    const email = normalizeEmail(req.body.email);
    if (!email)
      return res.status(400).json({ message: 'Email is required.' });

    // Verify email service is configured
    if (!isEmailServiceConfigured()) {
      return res.status(503).json({
        message: 'Password reset service is currently unavailable. Please try again later or contact support.'
      });
    }

    let user = null;

    // Try to find user in database
    if (isDbConnected()) {
      user = await User.findOne({ email });
    } else {
      // Fallback to dev store
      user = devStore.findUserByEmail(email);
    }

    // Always respond the same way to prevent email enumeration
    if (user) {
      try {
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenHash = hashOneTimeToken(resetToken);
        const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour expiry

        // Update user with reset token
        if (isDbConnected()) {
          user.resetPasswordToken = resetTokenHash;
          user.resetPasswordExpires = resetExpires;
          await user.save();
        } else {
          // Update in dev store (only reset token fields)
          devStore.updateUser(user._id, {
            resetPasswordToken: resetTokenHash,
            resetPasswordExpires: resetExpires,
          });
        }

        // Send password reset email
        await sendPasswordResetEmail(email, user.name || 'User', resetToken);
        console.log('Password reset email sent.');
      } catch (emailError) {
        console.error('Failed to send password reset email:', emailError);
        // Don't expose email service error to user
        // Still respond with generic message
      }
    }

    // Always respond the same way to prevent email enumeration
    res.json({ message: 'If an account with that email exists, a password reset link has been sent to the registered email address.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    if (!requirePersistentDatabase(res)) return;
    const { token, password } = req.body;
    if (!token || !password)
      return res.status(400).json({ message: 'Token and new password are required.' });
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ message: passwordError });
    const tokenHash = hashOneTimeToken(token);

    // Works with or without database
    if (!isDbConnected()) {
      // For devStore: get all users and find user with valid reset token
      const users = devStore.listUsers();
      const user = users.find(u =>
        u.resetPasswordToken === tokenHash &&
        u.resetPasswordExpires &&
        new Date(u.resetPasswordExpires) > new Date()
      );

      if (!user)
        return res.status(400).json({ message: 'Invalid or expired reset link. Please request a new one.' });

      // Update user with hashed password and clear reset token
      const hashedPassword = await bcrypt.hash(password, 12);
      devStore.updateUser(user._id, {
        passwordHash: hashedPassword,
        resetPasswordToken: undefined,
        resetPasswordExpires: undefined,
        sessionVersion: Math.max(0, Number(user.sessionVersion) || 0) + 1,
      });

      clearAuthCookie(res);
      return res.json({ message: 'Password reset successfully! You can now log in with your new password.' });
    }

    const user = await User.findOne({
      resetPasswordToken: tokenHash,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user)
      return res.status(400).json({ message: 'Invalid or expired reset link. Please request a new one.' });

    // Password will be hashed by User model pre-save hook
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.sessionVersion = Math.max(0, Number(user.sessionVersion) || 0) + 1;
    await user.save();

    clearAuthCookie(res);
    res.json({ message: 'Password reset successfully! You can now log in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ message: 'Server error during password reset.' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    return res.json({ user: buildAuthUser(req.authUser) });
  } catch (err) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ message: 'Both current and new password are required.' });
    const passwordError = validatePassword(newPassword, 'New password');
    if (passwordError) return res.status(400).json({ message: passwordError });

    if (!isDbConnected()) {
      const user = devStore.findUserById(req.user.id);
      if (!user) return res.status(404).json({ message: 'User not found.' });

      const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isMatch) return res.status(401).json({ message: 'Current password is incorrect.' });

      const passwordHash = await bcrypt.hash(newPassword, 12);
      devStore.updateUser(req.user.id, {
        passwordHash,
        sessionVersion: Math.max(0, Number(user.sessionVersion) || 0) + 1,
      });
      clearAuthCookie(res);
      return res.json({ message: 'Password changed successfully.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch)
      return res.status(401).json({ message: 'Current password is incorrect.' });

    user.password = newPassword;
    user.sessionVersion = Math.max(0, Number(user.sessionVersion) || 0) + 1;
    await user.save();
    clearAuthCookie(res);
    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// DELETE /api/auth/account
router.delete('/account', authMiddleware, async (req, res) => {
  try {
    if (!isDbConnected()) {
      devStore.deleteUser(req.user.id);
      clearAuthCookie(res);
      return res.json({ message: 'Account deleted successfully.' });
    }

    await User.findByIdAndDelete(req.user.id);
    const Word = require('../models/Word');
    await Word.deleteMany({ userId: req.user.id });
    clearAuthCookie(res);
    res.json({ message: 'Account deleted successfully.' });
  } catch (err) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/auth/logout — revokes all outstanding sessions for this account.
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    if (!isDbConnected()) {
      const user = devStore.findUserById(req.user.id);
      if (user) {
        devStore.updateUser(user._id, {
          sessionVersion: Math.max(0, Number(user.sessionVersion) || 0) + 1,
        });
      }
    } else {
      await User.updateOne({ _id: req.user.id }, { $inc: { sessionVersion: 1 } });
    }
    clearAuthCookie(res);
    return res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    clearAuthCookie(res);
    return res.status(500).json({ message: 'Could not complete logout.' });
  }
});

module.exports = router;
module.exports.__internals = {
  isValidCreatorAccessCode,
  validatePassword,
  hashOneTimeToken,
  authCookieOptions,
};
