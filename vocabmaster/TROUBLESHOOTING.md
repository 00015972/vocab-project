# 🔧 Taleem Lexicon - Troubleshooting Guide

## 📋 System Requirements

- **Node.js**: 14.0+
- **npm**: 6.0+
- **MongoDB**: 4.0+ (or use dev-store.json fallback)
- **Browser**: Chrome, Firefox, Safari, Edge (latest versions)
- **Port**: 3000 (default, configurable via .env)

---

## 🚀 QUICK START

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Create or update `.env` file:
```
NODE_ENV=development
PORT=3000
DATABASE_URL=mongodb://localhost:27017/taleem-lexicon
JWT_SECRET=dev-secret-key
JWT_EXPIRES_IN=7d
OPENAI_API_KEY=sk-your-key
TTS_PROVIDER=google
STORAGE_PROVIDER=local
```

### 3. Start Server
```bash
npm start

# Or for development with auto-reload:
npm run dev
```

### 4. Access Application
```
Landing: http://localhost:3000
Login: http://localhost:3000/public/login.html
Resource Manager: http://localhost:3000/public/resource-manager.html
```

---

## ❌ COMMON ERRORS & FIXES

### Error 1: "Cannot find module 'express'"
**Cause**: Dependencies not installed
```bash
# Fix:
npm install
```

### Error 2: "MongoDB Connection Failed"
**Cause**: MongoDB not running or connection string wrong
```bash
# Fix options:
# Option 1: Start MongoDB locally
mongod

# Option 2: Use cloud MongoDB (Atlas)
# Update .env: DATABASE_URL=mongodb+srv://user:pass@cluster.mongodb.net/db

# Option 3: Use fallback (dev-store.json)
# Works automatically if DB is offline
```

### Error 3: "Port 3000 is already in use"
**Cause**: Another process using the port
```bash
# Fix: Change port in .env
PORT=3001

# Or kill existing process:
# Windows:
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Mac/Linux:
lsof -i :3000
kill -9 <PID>
```

### Error 4: "Invalid JWT token"
**Cause**: Token expired or JWT secret changed
```bash
# Fix: Log out and log back in to get new token
# Or clear localStorage and refresh
localStorage.removeItem('token');
```

### Error 5: "CORS Error - Access denied"
**Cause**: Frontend and backend on different origins
```bash
# Already configured, but check:
# 1. SERVER runs on http://localhost:3000
# 2. PUBLIC folder served from same server
# 3. API calls use correct base URL
```

### Error 6: "OpenAI API Key Invalid"
**Cause**: Missing or invalid API key
```bash
# Fix: 
# 1. Get key from https://platform.openai.com/api-keys
# 2. Add to .env: OPENAI_API_KEY=sk-your-actual-key
# 3. Restart server
```

### Error 7: "Cannot POST /api/words"
**Cause**: Endpoint not registered or auth failed
```bash
# Fix:
# 1. Check server.js has: app.use('/api/words', require('./src/routes/words'));
# 2. Check auth middleware in request headers
# 3. Verify token in localStorage
```

### Error 8: "Audio file not found"
**Cause**: TTS generation failed or file not stored
```bash
# Fix:
# 1. Check TTS_PROVIDER environment variable
# 2. Verify API keys for TTS provider
# 3. Ensure /public/audio directory exists
# 4. Check server logs for detailed error
```

---

## ✅ VERIFICATION CHECKLIST

### Server Health
- [ ] Server starts without errors
- [ ] No "Cannot find module" messages
- [ ] Database connected (or fallback enabled)
- [ ] Port 3000 accessible

### API Endpoints
- [ ] `GET /api/health` returns `{"status":"ok"}`
- [ ] `POST /api/auth/register` creates account
- [ ] `POST /api/auth/login` returns JWT token
- [ ] `GET /api/words` returns word list (requires auth)
- [ ] `POST /api/words` creates word (creator only)
- [ ] `POST /api/words/bulk/import` imports multiple
- [ ] `GET /api/words/analytics` returns stats
- [ ] `GET /api/words/search` filters results

### Frontend Pages
- [ ] `/public/index.html` loads (landing page)
- [ ] `/public/login.html` loads (login page)
- [ ] `/public/register.html` loads (registration)
- [ ] `/public/student-dashboard.html` loads (student area)
- [ ] `/public/resource-manager.html` loads (creator area)
- [ ] `/public/lesson-builder.html` loads (course builder)
- [ ] `/public/lesson-player.html` loads (lesson viewer)

### Authentication Flow
- [ ] Can register new user
- [ ] Can login with credentials
- [ ] JWT token stored in localStorage
- [ ] Protected routes redirect to login
- [ ] Logout clears token

### Resource Manager Features
- [ ] Can add single word
- [ ] Can edit word
- [ ] Can delete word
- [ ] Can search words
- [ ] Can filter by language
- [ ] Can bulk import CSV
- [ ] Can export to CSV
- [ ] Analytics show correct counts

### User Roles
- [ ] Student: Can view courses, cannot manage words
- [ ] Creator: Can manage words and create courses
- [ ] Admin: Full access to all features

---

## 🧪 MANUAL TESTING

### Test 1: Create Account & Login
```
1. Open http://localhost:3000
2. Click "Register"
3. Fill form: email, password, select "Creator" role
4. Click "Sign Up"
5. Login with credentials
6. Should see creator dashboard
```

### Test 2: Add Vocabulary Word
```
1. Go to Resource Manager
2. Click "+ Add Word"
3. Fill: word="hola", definition="Spanish greeting", language="es"
4. Click "Add Word"
5. Word should appear in list
```

### Test 3: Bulk Import
```
1. Create CSV file:
   word,definition,language,partOfSpeech
   hello,greeting,en,interjection
   bonjour,hello,fr,interjection

2. Go to Resource Manager → Import tab
3. Upload CSV file
4. Review preview
5. Click "Import Words"
6. Verify words added to list
```

### Test 4: Create Lesson
```
1. Go to Lesson Builder
2. Search and select words
3. Click "+ Add Exercise"
4. Select exercise type
5. Fill lesson title
6. Click "Save"
7. Verify exercise created
```

### Test 5: Test API with cURL
```bash
# 1. Register
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123!","role":"creator"}'

# 2. Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123!"}'

# 3. Copy token from response, then:
TOKEN="your-jwt-token-here"

# 4. Get words
curl -X GET http://localhost:3000/api/words \
  -H "Authorization: Bearer $TOKEN"

# 5. Add word
curl -X POST http://localhost:3000/api/words \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"word":"hello","definition":"greeting"}'
```

---

## 🔍 DEBUGGING

### Enable Verbose Logging
```javascript
// In server.js or route files, add:
console.log('Request:', req.method, req.path);
console.log('Headers:', req.headers);
console.log('Body:', req.body);
console.log('Response:', result);
```

### Check Browser Console
1. Open DevTools (F12)
2. Go to Console tab
3. Look for errors (red messages)
4. Check Network tab for failed requests

### Check Server Logs
```bash
# Watch logs in real-time:
npm start | grep -E "error|ERROR|Error"
```

### Database Issues
```bash
# Check MongoDB connection:
mongo mongodb://localhost:27017/taleem-lexicon

# Or use MongoDB Compass GUI (download separately)
```

### Check File Permissions
```bash
# Ensure directory permissions:
chmod -R 755 public/
chmod -R 755 src/
chmod 644 .env
```

---

## 🚀 PERFORMANCE OPTIMIZATION

### Caching Strategy
- Resources cached for 1 hour
- Clear cache: `localStorage.clear()`

### Database Optimization
- Add indexes for common queries
- Use pagination (limit 50-100 per request)
- Compress responses

### Frontend Optimization
- Load JavaScript async/defer
- Minify CSS/JS for production
- Use CDN for static assets
- Lazy load images

---

## 📊 MONITORING

### Key Metrics to Track
- Response time (target: <200ms)
- Error rate (target: <1%)
- Active users
- API call volume
- Database query time

### Health Check Command
```bash
curl http://localhost:3000/api/health
```

Expected response:
```json
{
  "status": "ok",
  "database": "connected"
}
```

---

## 🔐 SECURITY NOTES

### Never Commit Sensitive Data
- `.env` file (API keys, secrets)
- Private keys
- Database passwords

### Production Deployment
```bash
# Set production environment:
NODE_ENV=production

# Use strong secrets:
JWT_SECRET=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)

# Enable HTTPS
# Use environment-specific .env files
# Implement rate limiting
# Enable CORS only for trusted origins
```

---

## 📞 SUPPORT

### Get Help
1. Check browser console for errors (F12)
2. Check server logs in terminal
3. Review this troubleshooting guide
4. Check GitHub issues/documentation
5. Contact support team

### Useful Resources
- Node.js Docs: https://nodejs.org/docs/
- Express Docs: https://expressjs.com/
- MongoDB Docs: https://docs.mongodb.com/
- OpenAI Docs: https://platform.openai.com/docs/

---

**Last Updated**: 2024
**Status**: Verified ✅
