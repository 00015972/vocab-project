const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.FROM_EMAIL || '';
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const BRAND_NAME = process.env.BRAND_NAME || 'Taleem Lexicon';
const LOGO_URL = process.env.EMAIL_LOGO_URL || `${CLIENT_URL}/assets/email-logo.jpg`;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || FROM || 'support@taleemlexicon.com';
let resendClient = null;

function getSenderEmail() {
  if (!FROM || FROM.includes('yourdomain.com')) {
    return 'onboarding@resend.dev';
  }
  return FROM;
}

function isEmailServiceConfigured() {
  return (
    RESEND_API_KEY.startsWith('re_') &&
    !RESEND_API_KEY.includes('your_resend_api_key')
  );
}

function getResendClient() {
  if (!isEmailServiceConfigured()) {
    throw new Error('Email service is not configured. Set RESEND_API_KEY and FROM_EMAIL in .env.');
  }
  if (!resendClient) {
    resendClient = new Resend(RESEND_API_KEY);
  }
  return resendClient;
}

const baseStyle = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #f5f7f9;
  color: #111827;
  margin: 0;
  padding: 0;
`;

function buildEmail(title, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="${baseStyle}">
  <table width="100%" cellpadding="0" cellspacing="0" style="min-height:100vh;background:#f5f7f9;">
    <tr><td align="center" style="padding:30px 16px;">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;border:1px solid #e5e7eb;overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(135deg,#ecfdf3,#fff8e1);padding:24px;text-align:center;border-bottom:1px solid #e5e7eb;">
            <img src="${LOGO_URL}" alt="${BRAND_NAME}" width="64" height="64" style="display:block;margin:0 auto 10px;border-radius:50%;object-fit:cover;" />
            <h1 style="margin:0;color:#166534;font-size:28px;font-weight:800;letter-spacing:-0.4px;">${BRAND_NAME}</h1>
            <p style="margin:6px 0 0;color:#4b5563;font-size:14px;">Secure account notifications</p>
          </td>
        </tr>
        <tr>
          <td style="padding:30px 28px;">
            <h2 style="margin:0 0 14px;color:#111827;font-size:24px;">${title}</h2>
            ${bodyHtml}
            <p style="margin:24px 0 0;color:#6b7280;font-size:12px;">Need help? Contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color:#166534;text-decoration:none;">${SUPPORT_EMAIL}</a>.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:16px 24px;text-align:center;border-top:1px solid #e5e7eb;">
            <p style="margin:0;color:#6b7280;font-size:12px;">© ${new Date().getFullYear()} ${BRAND_NAME}. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendVerificationEmail(to, name, token) {
  if (!isEmailServiceConfigured()) {
    throw new Error('Email service is not configured.');
  }
  const link = `${CLIENT_URL}/verify-email.html?token=${token}`;
  const html = buildEmail('Verify Your Email', `
    <p style="color:#94a3b8;font-size:16px;line-height:1.6;">Hi <strong style="color:#e2e8f0;">${name}</strong>,</p>
    <p style="color:#94a3b8;font-size:15px;line-height:1.6;">Thanks for signing up! Click the button below to verify your email address and start learning.</p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${link}" style="background:linear-gradient(135deg,#6c63ff,#a78bfa);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-size:16px;font-weight:600;display:inline-block;">Verify Email Address</a>
    </div>
    <p style="color:#64748b;font-size:13px;">Or copy this link:<br><a href="${link}" style="color:#6c63ff;word-break:break-all;">${link}</a></p>
    <p style="color:#64748b;font-size:13px;">This link expires in <strong>24 hours</strong>.</p>
  `);
  await getResendClient().emails.send({ from: getSenderEmail(), to, subject: 'Verify your VocabMaster email', html });
}

async function sendPasswordResetEmail(to, name, token) {
  if (!isEmailServiceConfigured()) {
    throw new Error('Email service is not configured.');
  }
  const link = `${CLIENT_URL}/reset-password.html?token=${token}`;
  const html = buildEmail('Reset Your Password', `
    <p style="margin:0 0 12px;color:#0ea5e9;font-size:14px;font-weight:700;text-align:center;">We received a reset request.</p>
    <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;font-style:italic;font-weight:700;">
      Welcome to ${BRAND_NAME} - your trusted companion for building strong vocabulary, sharper comprehension, and a lifelong love of learning.
    </p>
    <p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.55;">Hi <strong>${name}</strong>, there is a request to reset your ${BRAND_NAME} account password.</p>
    <p style="margin:0 0 14px;color:#b91c1c;font-size:14px;font-weight:700;">If you didn't request this, ignore this email.</p>
    <p style="margin:0 0 18px;color:#b45309;font-size:14px;font-weight:700;">Link expires in 1 hour.</p>
    <div style="text-align:center;margin:18px 0 22px;">
      <a href="${link}" style="background:#111827;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;">Reset Password</a>
    </div>
    <p style="color:#6b7280;font-size:12px;line-height:1.5;margin:0 0 8px;">If the button does not work, copy this link:</p>
    <p style="margin:0 0 10px;"><a href="${link}" style="color:#166534;word-break:break-all;font-size:12px;">${link}</a></p>
  `);
  await getResendClient().emails.send({ from: getSenderEmail(), to, subject: `Reset your ${BRAND_NAME} password`, html });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, isEmailServiceConfigured };
