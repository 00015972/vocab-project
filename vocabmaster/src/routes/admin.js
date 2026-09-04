const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const User = require('../models/User');
const AdminAudit = require('../models/AdminAudit');
const { isDbConnected } = require('../config/db');
const devStore = require('../services/devStore');

function buildCreatorCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function ensureUniqueCreatorCode() {
  if (!isDbConnected()) {
    let code = buildCreatorCode();
    const users = devStore.listUsers();
    for (let i = 0; i < 8; i += 1) {
      const exists = users.some((u) => String(u.creatorCode || '').toUpperCase() === code);
      if (!exists) return code;
      code = buildCreatorCode();
    }
    return `${Date.now().toString(36).slice(-6)}`.toUpperCase();
  }

  let code = buildCreatorCode();
  for (let i = 0; i < 8; i += 1) {
    const existing = await User.findOne({ creatorCode: code }).select('_id');
    if (!existing) return code;
    code = buildCreatorCode();
  }
  return `${Date.now().toString(36).slice(-6)}`.toUpperCase();
}

function mapPublicUser(user) {
  return {
    id: user._id || user.id,
    name: user.name,
    email: user.email,
    role: user.role || 'student',
    isVerified: !!user.isVerified,
    isActive: user.isActive !== false,
    creatorCode: user.creatorCode || null,
    linkedCreatorCode: user.linkedCreatorCode || null,
    createdAt: user.createdAt || null,
    isSeedAccount: !!user.isSeedAccount,
  };
}

function isSeedAccount(user) {
  return user && user.isSeedAccount === true;
}

function isLikelyTestEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.endsWith('@test.local') ||
    normalized.endsWith('@test.com') ||
    normalized.endsWith('@example.com')
  );
}

function isLikelyDemoUser(user) {
  if (!user) return true;
  return isSeedAccount(user) || isLikelyTestEmail(user.email);
}

function filterRealUsers(users) {
  return (users || []).filter((user) => !isLikelyDemoUser(user));
}

function applyUserFilters(users, { search, role, verified, active }) {
  const searchNeedle = String(search || '').trim().toLowerCase();
  const roleNeedle = String(role || '').trim().toLowerCase();
  const verifiedNeedle = String(verified || '').trim().toLowerCase();
  const activeNeedle = String(active || '').trim().toLowerCase();

  return users.filter((u) => {
    const name = String(u.name || '').toLowerCase();
    const email = String(u.email || '').toLowerCase();
    const userRole = String(u.role || 'student').toLowerCase();
    const userVerified = !!u.isVerified;
    const userActive = u.isActive !== false;

    if (searchNeedle && !`${name} ${email}`.includes(searchNeedle)) return false;
    if (roleNeedle && userRole !== roleNeedle) return false;
    if (verifiedNeedle === 'true' && !userVerified) return false;
    if (verifiedNeedle === 'false' && userVerified) return false;
    if (activeNeedle === 'true' && !userActive) return false;
    if (activeNeedle === 'false' && userActive) return false;

    return true;
  });
}

function summarizeUsers(users) {
  return users.reduce((acc, u) => {
    const role = String(u.role || 'student').toLowerCase();
    if (role === 'admin') acc.admins += 1;
    else if (role === 'creator') acc.creators += 1;
    else acc.students += 1;

    if (u.isVerified) acc.verified += 1;
    if (u.isActive !== false) acc.active += 1;
    else acc.inactive += 1;
    return acc;
  }, {
    students: 0,
    creators: 0,
    admins: 0,
    verified: 0,
    active: 0,
    inactive: 0,
  });
}

function listParams(req) {
  return {
    page: Math.max(parseInt(req.query.page, 10) || 1, 1),
    limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200),
    search: String(req.query.search || '').trim(),
    role: String(req.query.role || '').trim().toLowerCase(),
    verified: String(req.query.verified || '').trim().toLowerCase(),
    active: String(req.query.active || '').trim().toLowerCase(),
  };
}

function filterUsersQuery({ search, role, verified, active }) {
  const query = {};
  query.email = { $not: /@(test\.local|test\.com|example\.com)$/i };
  if (role) query.role = role;
  if (verified === 'true') query.isVerified = true;
  if (verified === 'false') query.isVerified = false;
  if (active === 'true') query.isActive = { $ne: false };
  if (active === 'false') query.isActive = false;
  if (search) {
    const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ name: regex }, { email: regex }];
  }
  return query;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function usersToCsv(users) {
  const headers = ['id', 'name', 'email', 'role', 'isVerified', 'isActive', 'creatorCode', 'linkedCreatorCode', 'createdAt'];
  const lines = [headers.join(',')];
  users.forEach((u) => {
    const row = [
      u.id,
      u.name,
      u.email,
      u.role,
      u.isVerified,
      u.isActive,
      u.creatorCode || '',
      u.linkedCreatorCode || '',
      u.createdAt || '',
    ].map(csvEscape).join(',');
    lines.push(row);
  });
  return lines.join('\n');
}

async function logAudit(req, entry) {
  const payload = {
    adminId: String(req.adminUser?._id || req.adminUser?.id || req.user?.id || ''),
    adminEmail: req.adminUser?.email || 'unknown@local',
    action: entry.action,
    targetUserId: entry.targetUserId || null,
    targetEmail: entry.targetEmail || null,
    details: entry.details || {},
    createdAt: new Date(),
  };

  if (!isDbConnected()) {
    devStore.addAdminAudit(payload);
    return;
  }

  await AdminAudit.create(payload);
}

async function updateUserRoleById(userId, role) {
  if (!isDbConnected()) {
    const user = devStore.findUserById(userId);
    if (!user) return { error: 'not-found' };
    const updates = { role };
    if (role === 'creator' && !user.creatorCode) {
      updates.creatorCode = await ensureUniqueCreatorCode();
    }
    const updated = devStore.updateUser(userId, updates);
    return { user: mapPublicUser(updated), before: mapPublicUser(user) };
  }

  const user = await User.findById(userId);
  if (!user) return { error: 'not-found' };
  const before = mapPublicUser(user.toObject());
  user.role = role;
  if (role === 'creator' && !user.creatorCode) {
    user.creatorCode = await ensureUniqueCreatorCode();
  }
  await user.save();
  return { user: mapPublicUser(user.toObject()), before };
}

async function updateUserStatusById(userId, updates) {
  if (!isDbConnected()) {
    const user = devStore.findUserById(userId);
    if (!user) return { error: 'not-found' };
    const before = mapPublicUser(user);
    const updated = devStore.updateUser(userId, updates);
    return { user: mapPublicUser(updated), before };
  }

  const user = await User.findById(userId);
  if (!user) return { error: 'not-found' };
  const before = mapPublicUser(user.toObject());
  if (typeof updates.isVerified === 'boolean') user.isVerified = updates.isVerified;
  if (typeof updates.isActive === 'boolean') user.isActive = updates.isActive;
  await user.save();
  return { user: mapPublicUser(user.toObject()), before };
}

// Stage 1/2: list users (admin only) with filtering + pagination
router.get('/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page, limit, search, role, verified, active } = listParams(req);

    if (!isDbConnected()) {
      const mapped = filterRealUsers(devStore.listUsers().map(mapPublicUser));
      const filtered = applyUserFilters(mapped, { search, role, verified, active });
      const total = filtered.length;
      const pages = Math.max(Math.ceil(total / limit), 1);
      const start = (page - 1) * limit;
      const users = filtered.slice(start, start + limit);
      return res.json({
        users,
        total,
        page,
        limit,
        pages,
        summary: summarizeUsers(filtered),
        source: 'dev-store',
      });
    }

    const query = filterUsersQuery({ search, role, verified, active });
    query.isSeedAccount = { $ne: true };

    const [total, rows, summaryRows] = await Promise.all([
      User.countDocuments(query),
      User.find(query)
        .select('_id name email role isVerified isActive creatorCode linkedCreatorCode createdAt isSeedAccount')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.find(query)
        .select('role isVerified isActive isSeedAccount')
        .lean(),
    ]);

    const visibleRows = filterRealUsers(rows.map(mapPublicUser));
    const visibleSummaryRows = filterRealUsers(summaryRows.map(mapPublicUser));
    const visibleTotal = visibleSummaryRows.length;
    const pages = Math.max(Math.ceil(visibleTotal / limit), 1);
    return res.json({
      users: visibleRows,
      total: visibleTotal,
      page,
      limit,
      pages,
      summary: summarizeUsers(visibleSummaryRows),
      source: 'mongodb',
    });
  } catch (err) {
    console.error('Admin users list error:', err);
    return res.status(500).json({ message: 'Failed to fetch users' });
  }
});

// Stage 2: update user role (admin only)
router.patch('/users/:userId/role', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const role = String(req.body.role || '').toLowerCase();
    if (!['student', 'creator', 'admin'].includes(role)) {
      return res.status(400).json({ message: 'Role must be student, creator, or admin.' });
    }

    if (String(req.user.id) === String(userId)) {
      return res.status(400).json({ message: 'You cannot change your own role.' });
    }

    const result = await updateUserRoleById(userId, role);
    if (result.error === 'not-found') return res.status(404).json({ message: 'User not found' });

    await logAudit(req, {
      action: 'user.role.update',
      targetUserId: result.user.id,
      targetEmail: result.user.email,
      details: {
        fromRole: result.before?.role,
        toRole: result.user.role,
      },
    });

    return res.json({ message: 'Role updated successfully.', user: result.user });
  } catch (err) {
    console.error('Admin role update error:', err);
    return res.status(500).json({ message: 'Failed to update role' });
  }
});

// Stage 2: update user status (verified/active)
router.patch('/users/:userId/status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const hasVerified = typeof req.body.isVerified === 'boolean';
    const hasActive = typeof req.body.isActive === 'boolean';
    if (!hasVerified && !hasActive) {
      return res.status(400).json({ message: 'Provide isVerified and/or isActive as booleans.' });
    }

    if (String(req.user.id) === String(userId) && hasActive && req.body.isActive === false) {
      return res.status(400).json({ message: 'You cannot deactivate your own account.' });
    }

    const updates = {};
    if (hasVerified) updates.isVerified = req.body.isVerified;
    if (hasActive) updates.isActive = req.body.isActive;
    const result = await updateUserStatusById(userId, updates);
    if (result.error === 'not-found') return res.status(404).json({ message: 'User not found' });

    await logAudit(req, {
      action: 'user.status.update',
      targetUserId: result.user.id,
      targetEmail: result.user.email,
      details: {
        fromVerified: result.before?.isVerified,
        toVerified: result.user.isVerified,
        fromActive: result.before?.isActive,
        toActive: result.user.isActive,
      },
    });

    return res.json({ message: 'Status updated successfully.', user: result.user });
  } catch (err) {
    console.error('Admin status update error:', err);
    return res.status(500).json({ message: 'Failed to update status' });
  }
});

// Stage 3: bulk admin actions
router.post('/users/bulk', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userIds, operation, role } = req.body;
    const ids = Array.isArray(userIds) ? [...new Set(userIds.map(String).filter(Boolean))] : [];
    if (!ids.length) return res.status(400).json({ message: 'Provide at least one user ID.' });
    if (ids.length > 200) return res.status(400).json({ message: 'Bulk operations are limited to 200 users.' });

    const allowedOps = ['verify', 'unverify', 'activate', 'deactivate', 'setRole'];
    if (!allowedOps.includes(operation)) {
      return res.status(400).json({ message: 'Invalid bulk operation.' });
    }
    if (operation === 'setRole' && !['student', 'creator', 'admin'].includes(String(role || '').toLowerCase())) {
      return res.status(400).json({ message: 'Role is required for setRole operation.' });
    }

    const updated = [];
    const skipped = [];
    const failed = [];

    for (const userId of ids) {
      try {
        if (String(req.user.id) === String(userId)) {
          if (operation === 'deactivate' || operation === 'setRole') {
            skipped.push({ userId, reason: 'Cannot apply this operation to your own account.' });
            continue;
          }
        }

        let result;
        if (operation === 'setRole') {
          result = await updateUserRoleById(userId, String(role).toLowerCase());
        } else if (operation === 'verify') {
          result = await updateUserStatusById(userId, { isVerified: true });
        } else if (operation === 'unverify') {
          result = await updateUserStatusById(userId, { isVerified: false });
        } else if (operation === 'activate') {
          result = await updateUserStatusById(userId, { isActive: true });
        } else if (operation === 'deactivate') {
          result = await updateUserStatusById(userId, { isActive: false });
        }

        if (!result || result.error === 'not-found') {
          skipped.push({ userId, reason: 'User not found.' });
          continue;
        }

        updated.push(result.user);
      } catch (err) {
        failed.push({ userId, reason: err.message || 'Failed to update user.' });
      }
    }

    await logAudit(req, {
      action: 'users.bulk',
      details: {
        operation,
        role: operation === 'setRole' ? String(role).toLowerCase() : undefined,
        requested: ids.length,
        updated: updated.length,
        skipped: skipped.length,
        failed: failed.length,
      },
    });

    return res.json({
      message: 'Bulk operation completed.',
      operation,
      requested: ids.length,
      updatedCount: updated.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      updated,
      skipped,
      failed,
    });
  } catch (err) {
    console.error('Admin bulk operation error:', err);
    return res.status(500).json({ message: 'Failed to perform bulk operation' });
  }
});

// Stage 3: export filtered users as CSV
router.get('/users/export', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { search, role, verified, active } = listParams(req);

    let users;
    if (!isDbConnected()) {
      const mapped = filterRealUsers(devStore.listUsers().map(mapPublicUser));
      users = applyUserFilters(mapped, { search, role, verified, active });
    } else {
      const query = filterUsersQuery({ search, role, verified, active });
      query.isSeedAccount = { $ne: true };
      const rows = await User.find(query)
        .select('_id name email role isVerified isActive creatorCode linkedCreatorCode createdAt isSeedAccount')
        .sort({ createdAt: -1 })
        .limit(5000)
        .lean();
      users = filterRealUsers(rows.map(mapPublicUser));
    }

    const csv = usersToCsv(users);
    await logAudit(req, {
      action: 'users.export.csv',
      details: {
        count: users.length,
        filters: { search, role, verified, active },
      },
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="admin-users-${Date.now()}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('Admin users export error:', err);
    return res.status(500).json({ message: 'Failed to export users' });
  }
});

// Stage 3: audit timeline
router.get('/audit', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const search = String(req.query.search || '').trim().toLowerCase();
    const action = String(req.query.action || '').trim().toLowerCase();
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    const fromDate = from && !Number.isNaN(from.getTime()) ? from : null;
    const toDate = to && !Number.isNaN(to.getTime()) ? to : null;

    if (!isDbConnected()) {
      const logs = devStore.listAdminAudit();
      const filtered = logs.filter((item) => {
        const adminEmail = String(item.adminEmail || '').toLowerCase();
        const targetEmail = String(item.targetEmail || '').toLowerCase();
        if (isLikelyTestEmail(adminEmail) || isLikelyTestEmail(targetEmail)) return false;

        const actionOk = action ? String(item.action || '').toLowerCase() === action : true;
        const haystack = `${item.adminEmail || ''} ${item.targetEmail || ''} ${item.action || ''}`.toLowerCase();
        const searchOk = search ? haystack.includes(search) : true;
        const createdAt = item.createdAt ? new Date(item.createdAt) : null;
        const fromOk = fromDate ? createdAt && createdAt >= fromDate : true;
        const toOk = toDate ? createdAt && createdAt < new Date(toDate.getTime() + 24 * 60 * 60 * 1000) : true;
        return actionOk && searchOk && fromOk && toOk;
      });

      const total = filtered.length;
      const pages = Math.max(Math.ceil(total / limit), 1);
      const start = (page - 1) * limit;
      const audit = filtered.slice(start, start + limit);
      return res.json({ audit, total, page, limit, pages, source: 'dev-store' });
    }

    const query = {};
    if (action) query.action = action;
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = fromDate;
      if (toDate) {
        const inclusiveTo = new Date(toDate);
        inclusiveTo.setDate(inclusiveTo.getDate() + 1);
        query.createdAt.$lt = inclusiveTo;
      }
    }
    if (search) {
      const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { adminEmail: regex },
        { targetEmail: regex },
        { action: regex },
      ];
    }

    const [total, audit] = await Promise.all([
      AdminAudit.countDocuments(query),
      AdminAudit.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const pages = Math.max(Math.ceil(total / limit), 1);
    return res.json({ audit, total, page, limit, pages, source: 'mongodb' });
  } catch (err) {
    console.error('Admin audit list error:', err);
    return res.status(500).json({ message: 'Failed to fetch audit log' });
  }
});

module.exports = router;
