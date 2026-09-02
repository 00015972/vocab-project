require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const csrf = require('express-csurf');
const path = require('path');
const { connectDB, isDbConnected } = require('./src/config/db');

const app = express();
const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

function validateProductionConfig() {
  if (!isProduction) return;
  const problems = [];
  const jwtSecret = String(process.env.JWT_SECRET || '');
  const sessionSecret = String(process.env.SESSION_SECRET || '');
  const clientUrl = String(process.env.CLIENT_URL || '');
  const mongoUri = String(process.env.MONGODB_URI || '');
  const creatorAccessCode = String(process.env.CREATOR_ACCESS_CODE || '').trim();
  const resendApiKey = String(process.env.RESEND_API_KEY || '');
  const fromEmail = String(process.env.FROM_EMAIL || '');

  if (jwtSecret.length < 32 || /change|secret-key|your-/i.test(jwtSecret)) problems.push('JWT_SECRET must be a random value of at least 32 characters');
  if (sessionSecret.length < 32 || /change|secret-key|your-/i.test(sessionSecret)) problems.push('SESSION_SECRET must be a different random value of at least 32 characters');
  if (!clientUrl.startsWith('https://')) problems.push('CLIENT_URL must be the public HTTPS origin');
  if (!mongoUri || /YOUR_PASSWORD|USERNAME:PASSWORD/i.test(mongoUri)) problems.push('MONGODB_URI must contain real Atlas credentials');
  if (creatorAccessCode.length < 12) problems.push('CREATOR_ACCESS_CODE must be at least 12 characters');
  if (!resendApiKey.startsWith('re_') || /your_resend_api_key/i.test(resendApiKey)) problems.push('RESEND_API_KEY is required for email verification and password recovery');
  if (!fromEmail || /yourdomain\.com/i.test(fromEmail)) problems.push('FROM_EMAIL must be a verified sender address');

  if (problems.length) {
    throw new Error(`Invalid production configuration:\n- ${problems.join('\n- ')}`);
  }
}

validateProductionConfig();
if (isProduction) app.set('trust proxy', 1);

connectDB();

app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  referrerPolicy: { policy: 'no-referrer' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "https://accounts.google.com", "https://cdnjs.cloudflare.com", "https://unpkg.com", "https://cdn.jsdelivr.net"],
      scriptSrcElem: ["'self'", "'unsafe-inline'", "https://accounts.google.com", "https://cdnjs.cloudflare.com", "https://unpkg.com", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      workerSrc: ["'self'", "blob:", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://accounts.google.com"],
      styleSrcElem: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://accounts.google.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://www.image2url.com", "https:"],
      mediaSrc: ["'self'", "blob:", "data:", "https:"],
      connectSrc: ["'self'", "http://localhost:3000", "http://127.0.0.1:3000", "https://accounts.google.com", "https://lottie.host", "https://unpkg.com", "https://cdn.jsdelivr.net"],
      frameSrc: ["'self'", "https://accounts.google.com"],
    }
  }
}));

const explicitOrigins = new Set([
  process.env.CLIENT_URL || 'http://localhost:3000',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
const localOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.use(cors({
  origin: (origin, callback) => {
    // Allow same-origin requests and local tooling that may not send Origin.
    if (!origin || explicitOrigins.has(origin) || localOriginPattern.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

const apiRateWindowMs = Number(process.env.API_RATE_WINDOW_MS || (15 * 60 * 1000));
const apiRateMax = Number(process.env.API_RATE_MAX || (isProduction ? 600 : 2000));
const authRateWindowMs = Number(process.env.AUTH_RATE_WINDOW_MS || (15 * 60 * 1000));
const authRateMax = Number(process.env.AUTH_RATE_MAX || (isProduction ? 20 : 120));

const limiter = rateLimit({
  windowMs: apiRateWindowMs,
  max: apiRateMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    const retryAfter = Math.ceil(Number(options.windowMs || apiRateWindowMs) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(options.statusCode || 429).json({
      message: 'Too many requests, please try again later.',
      retryAfterSeconds: retryAfter,
    });
  },
});
app.use('/api/', limiter);

const authLimiter = rateLimit({
  windowMs: authRateWindowMs,
  max: authRateMax,
  handler: (req, res, next, options) => {
    const retryAfter = Math.ceil(Number(options.windowMs || authRateWindowMs) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(options.statusCode || 429).json({
      message: 'Too many requests, please try again later.',
      retryAfterSeconds: retryAfter,
    });
  },
});
app.use('/api/auth/', authLimiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cookie-authenticated write requests must come from this application origin.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const hasAuthCookie = String(req.headers.cookie || '').split(';').some((part) => part.trim().startsWith('vm_auth='));
  if (!hasAuthCookie) return next();
  const origin = String(req.headers.origin || '');
  if (origin && (explicitOrigins.has(origin) || localOriginPattern.test(origin))) return next();
  if (!origin && String(req.headers.authorization || '').startsWith('Bearer ')) return next();
  return res.status(403).json({ message: 'Request origin is not allowed.' });
});

// Session middleware for CSRF token generation
app.use(session({
  secret: process.env.SESSION_SECRET || 'local-development-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict',
  },
}));

// CSRF protection middleware - skip for API routes
const csrfProtection = csrf({ cookie: false });
app.use((req, res, next) => {
  // Skip CSRF for API routes (they use JWT instead)
  if (req.path.startsWith('/api/')) {
    return next();
  }
  csrfProtection(req, res, next);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    database: isDbConnected() ? 'connected' : 'disconnected',
  });
});

// CSRF token endpoint
app.get('/api/csrf-token', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index-ultra.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/words', require('./src/routes/words'));
app.use('/api/progress', require('./src/routes/progress'));
app.use('/api/ai', require('./src/routes/ai'));
app.use('/api/decks', require('./src/routes/decks'));
app.use('/api/import', require('./src/routes/import'));
app.use('/api/export', require('./src/routes/import')); // Reuse import route for export
app.use('/api/study', require('./src/routes/study'));
app.use('/api/creator', require('./src/routes/creator'));
app.use('/api/cms', require('./src/routes/cms'));
app.use('/api/user', require('./src/routes/user'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/tts', require('./src/routes/tts'));
app.use('/api/audio', require('./src/routes/audio'));

// Image proxy — fetches external image server-side and streams it to avoid ORB/CORS blocks
app.get('/api/image-proxy', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url.startsWith('https://image.pollinations.ai/')) {
    return res.status(400).json({ message: 'Only Pollinations images are proxied.' });
  }
  try {
    const axios = require('axios');
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 35000 });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (err) {
    // If server-side fetch fails (DNS/rate-limit/network), fall back to direct image URL.
    // Browser image tags can still render it even when proxy cannot fetch from this environment.
    res.redirect(302, url);
  }
});

// API error handler
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ message: 'API endpoint not found' });
  }
  next();
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  if (req.path.startsWith('/api/')) {
    return res.status(err.status || 500).json({ message: err.message || 'Internal Server Error' });
  }
  res.status(err.status || 500).send('Internal Server Error');
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VocabMaster server running on port ${PORT}`);
  });
}

module.exports = { app, validateProductionConfig };
