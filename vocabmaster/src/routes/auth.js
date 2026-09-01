const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const Word = require('../models/Word');
const { sendVerificationEmail, sendPasswordResetEmail, isEmailServiceConfigured } = require('../services/email');
const authMiddleware = require('../middleware/auth');
const { isDbConnected } = require('../config/db');
const devStore = require('../services/devStore');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const DEFAULT_DEV_CREATOR_ACCESS_CODE = 'creator123';
const CREATOR_ACCESS_CODE = process.env.CREATOR_ACCESS_CODE || (process.env.NODE_ENV === 'production' ? null : DEFAULT_DEV_CREATOR_ACCESS_CODE);
let googleClient = null;

function isDevelopmentMode() {
  return String(process.env.NODE_ENV || '').toLowerCase() !== 'production';
}

function getAllowedCreatorAccessCodes() {
  const codes = new Set();
  const configuredCode = String(process.env.CREATOR_ACCESS_CODE || '').trim();
  if (configuredCode) codes.add(configuredCode.toUpperCase());
  if (isDevelopmentMode()) {
    codes.add('CREATOR123');
    codes.add('DEMO01');
  }
  return codes;
}

function isValidCreatorAccessCode(candidateCode, creatorCode = '', role = 'creator') {
  if (role !== 'creator') return true;
  const normalizedCandidate = String(candidateCode || '').trim().toUpperCase();
  const normalizedCreatorCode = String(creatorCode || '').trim().toUpperCase();

  if (isDevelopmentMode()) {
    if (!normalizedCandidate || normalizedCandidate === normalizedCreatorCode) {
      return true;
    }
    return getAllowedCreatorAccessCodes().has(normalizedCandidate);
  }

  if (!normalizedCandidate) {
    return true;
  }
  if (normalizedCreatorCode && normalizedCandidate === normalizedCreatorCode) {
    return true;
  }
  return getAllowedCreatorAccessCodes().has(normalizedCandidate);
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

function issueAuthToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function normalizeRole(input) {
  return String(input || 'student').toLowerCase() === 'creator' ? 'creator' : 'student';
}

function buildCreatorCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
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
    const { name, email, password, role, creatorPortalCode, linkedCreatorCode } = req.body;
    const normalizedRole = normalizeRole(role);
    if (!name || !email || !password)
      return res.status(400).json({ message: 'Name, email and password are required.' });
    if (password.length < 6)
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    if (normalizedRole === 'creator') {
      if (!CREATOR_ACCESS_CODE && !isDevelopmentMode()) {
        return res.status(403).json({ message: 'Creator registration is disabled.' });
      }
      if (!isValidCreatorAccessCode(creatorPortalCode, '', normalizedRole)) {
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
      
      // Create token for immediate login
      const token = issueAuthToken(localUser._id);
      const userResp = {
        id: localUser._id,
        name: localUser.name,
        email: localUser.email,
        role: localUser.role,
        creatorCode: localUser.creatorCode || null,
        linkedCreatorCode: localUser.linkedCreatorCode || null,
        createdAt: new Date().toISOString(),
      };
      
      return res.status(201).json({
        token,
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

    const emailConfigured = isEmailServiceConfigured();
    const skipEmailVerification = normalizedRole === 'creator';
    const user = new User({
      name,
      email,
      password,
      role: normalizedRole,
      creatorCode: resolvedCreatorCode,
      linkedCreatorCode: normalizedRole === 'student' && linkedCreatorCode ? linkedCreatorCode.toUpperCase() : undefined,
      ...(emailConfigured && !skipEmailVerification
        ? {
            verificationToken: crypto.randomBytes(32).toString('hex'),
            verificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
          }
        : { isVerified: true }),
    });
    await user.save();

    const token = issueAuthToken(user._id);
    const userResp = buildAuthUser(user);

    if (emailConfigured && !skipEmailVerification) {
      try {
        await sendVerificationEmail(email, name, user.verificationToken);
      } catch (emailErr) {
        console.error('Verification email send error:', emailErr);
        return res.status(502).json({
          message: 'Account created, but verification email could not be sent. Check RESEND_API_KEY, FROM_EMAIL and Resend sender settings.',
        });
      }
      return res.status(201).json({
        token,
        user: userResp,
        message: 'Registration successful! Please check your email to verify your account.',
        emailVerificationRequired: true,
        creatorCode: user.creatorCode || null,
      });
    }
    return res.status(201).json({
      token,
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
    const { email, password, role, creatorPortalCode } = req.body;
    const requestedRole = role ? String(role).toLowerCase() : null;
    const expectedRole = ['student', 'creator', 'admin'].includes(requestedRole)
      ? requestedRole
      : null;
    if (!email || !password)
      return res.status(400).json({ message: 'Email and password are required.' });

    if (!isDbConnected()) {
      const user = devStore.findUserByEmail(email);
      if (!user) return res.status(401).json({ message: 'Invalid email or password.' });
      if (user.isActive === false) {
        return res.status(403).json({ message: 'Your account is deactivated. Contact support.' });
      }
      const effectiveRole = user.role || 'creator';
      if (expectedRole && expectedRole !== effectiveRole) {
        return res.status(403).json({ message: `This account is registered as ${effectiveRole}. Use the correct portal.` });
      }
      if (effectiveRole === 'creator' && !isValidCreatorAccessCode(creatorPortalCode, user.creatorCode || '', effectiveRole)) {
        return res.status(403).json({ message: 'Invalid creator access code.' });
      }

      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) return res.status(401).json({ message: 'Invalid email or password.' });

      const token = issueAuthToken(user._id);

      return res.json({
        token,
        user: buildAuthUser(user),
      });
    }

    const user = await User.findOne({ email });
    if (!user)
      return res.status(401).json({ message: 'Invalid email or password.' });
    if (user.isActive === false) {
      return res.status(403).json({ message: 'Your account is deactivated. Contact support.' });
    }
    const effectiveRole = user.role || 'creator';
    if (expectedRole && expectedRole !== effectiveRole) {
      return res.status(403).json({ message: `This account is registered as ${effectiveRole}. Use the correct portal.` });
    }
    if (effectiveRole === 'creator' && !isValidCreatorAccessCode(creatorPortalCode, user.creatorCode || '', effectiveRole)) {
      return res.status(403).json({ message: 'Invalid creator access code.' });
    }

    if (!user.isVerified) {
      if (isEmailServiceConfigured() && effectiveRole !== 'creator') {
        return res.status(403).json({ message: 'Please verify your email before logging in. Check your inbox.' });
      }
      user.isVerified = true;
      user.verificationToken = undefined;
      user.verificationExpires = undefined;
      await user.save();
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch)
      return res.status(401).json({ message: 'Invalid email or password.' });

    const token = issueAuthToken(user._id);

    res.json({
      token,
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
    const { credential, role } = req.body;
    const expectedRole = role ? normalizeRole(role) : null;
    if (expectedRole === 'creator') {
      return res.status(403).json({ message: 'Creator accounts must use email/password and creator access code.' });
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
        return res.status(403).json({ message: 'Creator accounts must use email/password and creator access code.' });
      }

      const token = issueAuthToken(localUser._id);
      return res.json({
        token,
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
      return res.status(403).json({ message: 'Creator accounts must use email/password and creator access code.' });
    }

    const token = issueAuthToken(user._id);
    return res.json({
      token,
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
      verificationToken: token,
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

router.post('/creator-access', async (req, res) => {
  try {
    const { creatorPortalCode } = req.body;
    if (!isValidCreatorAccessCode(creatorPortalCode, '', 'creator')) {
      return res.status(403).json({ message: 'Invalid creator access code.' });
    }

    if (!isDbConnected()) {
      const creatorUser = devStore.listUsers().find((u) => (u.role || 'student') === 'creator' && u.isActive !== false);
      if (!creatorUser) {
        return res.status(404).json({ message: 'No creator account exists yet.' });
      }

      return res.json({
        token: issueAuthToken(creatorUser._id),
        user: buildAuthUser(creatorUser),
      });
    }

    const creatorUser = await User.findOne({ role: 'creator', isActive: { $ne: false } })
      .sort({ createdAt: 1 })
      .lean();

    if (!creatorUser) {
      return res.status(404).json({ message: 'No creator account exists yet.' });
    }

    return res.json({
      token: issueAuthToken(creatorUser._id),
      user: buildAuthUser(creatorUser),
    });
  } catch (err) {
    console.error('Creator access error:', err);
    return res.status(500).json({ message: 'Failed to open creator dashboard.' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const isDevMode = isDevelopmentMode();
    const { email } = req.body;
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
        const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour expiry
        
        // Update user with reset token
        if (isDbConnected()) {
          user.resetPasswordToken = resetToken;
          user.resetPasswordExpires = resetExpires;
          await user.save();
        } else {
          // Update in dev store (only reset token fields)
          devStore.updateUser(user._id, {
            resetPasswordToken: resetToken,
            resetPasswordExpires: resetExpires,
          });
        }

        // Send password reset email
        await sendPasswordResetEmail(email, user.name || 'User', resetToken);
        console.log(`✅ Password reset email sent to ${email}`);
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
    const { token, password } = req.body;
    if (!token || !password)
      return res.status(400).json({ message: 'Token and new password are required.' });
    if (password.length < 6)
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });

    // Works with or without database
    if (!isDbConnected()) {
      // For devStore: get all users and find user with valid reset token
      const users = devStore.listUsers();
      const user = users.find(u => 
        u.resetPasswordToken === token && 
        u.resetPasswordExpires && 
        new Date(u.resetPasswordExpires) > new Date()
      );

      if (!user)
        return res.status(400).json({ message: 'Invalid or expired reset link. Please request a new one.' });

      // Update user with hashed password and clear reset token
      const hashedPassword = bcrypt.hashSync(password, 10);
      devStore.updateUser(user._id, {
        passwordHash: hashedPassword,
        resetPasswordToken: undefined,
        resetPasswordExpires: undefined,
      });

      console.log(`✅ Password reset successfully for user ${user.email}`);
      return res.json({ message: 'Password reset successfully! You can now log in with your new password.' });
    }

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user)
      return res.status(400).json({ message: 'Invalid or expired reset link. Please request a new one.' });

    // Password will be hashed by User model pre-save hook
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    console.log(`✅ Password reset successfully for user ${user.email}`);
    res.json({ message: 'Password reset successfully! You can now log in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ message: 'Server error during password reset.' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    if (!isDbConnected()) {
      const user = devStore.findUserById(req.user.id);
      if (!user) return res.status(404).json({ message: 'User not found.' });
      return res.json({
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          createdAt: user.createdAt,
          isVerified: true,
          role: user.role || 'creator',
          creatorCode: user.creatorCode || null,
          linkedCreatorCode: user.linkedCreatorCode || null,
          avatar: user.avatar || null,
        },
      });
    }

    const user = await User.findById(req.user.id).select('-password -verificationToken -resetPasswordToken');
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ user });
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
    if (newPassword.length < 6)
      return res.status(400).json({ message: 'New password must be at least 6 characters.' });

    if (!isDbConnected()) {
      const user = devStore.findUserById(req.user.id);
      if (!user) return res.status(404).json({ message: 'User not found.' });

      const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isMatch) return res.status(401).json({ message: 'Current password is incorrect.' });

      const passwordHash = await bcrypt.hash(newPassword, 12);
      devStore.updateUser(req.user.id, { passwordHash });
      return res.json({ message: 'Password changed successfully.' });
    }

    const user = await User.findById(req.user.id);
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch)
      return res.status(401).json({ message: 'Current password is incorrect.' });

    user.password = newPassword;
    await user.save();
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
      return res.json({ message: 'Account deleted successfully.' });
    }

    await User.findByIdAndDelete(req.user.id);
    const Word = require('../models/Word');
    await Word.deleteMany({ userId: req.user.id });
    res.json({ message: 'Account deleted successfully.' });
  } catch (err) {
    res.status(500).json({ message: 'Server error.' });
  }
});

module.exports = router;
