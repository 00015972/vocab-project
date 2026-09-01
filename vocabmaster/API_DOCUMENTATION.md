# VocabMaster API Documentation

## Base URL
```
http://localhost:3000/api
```

## Authentication
All endpoints except `/auth/*` require JWT token in Authorization header:
```
Authorization: Bearer <token>
```

---

## Authentication Endpoints

### Register User
```
POST /auth/register
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "password123",
  "role": "student|creator",
  "creatorPortalCode": "ABC123" // Required if role=creator
}

Response (201):
{
  "message": "Account created successfully",
  "emailVerificationRequired": false,
  "creatorCode": "ABC123" // Only for creators
}
```

### Login
```
POST /auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "password123",
  "role": "student|creator",
  "creatorPortalCode": "ABC123" // Required if role=creator
}

Response (200):
{
  "token": "eyJhbGc...",
  "user": {
    "id": "507f1f77bcf86cd799439011",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "student|creator",
    "creatorCode": "ABC123", // Only if creator
    "linkedCreatorCode": "XYZ789" // Only if student linked to class
  }
}
```

### Verify Email
```
GET /auth/verify-email?token=<verification_token>

Response (200):
{
  "message": "Email verified successfully"
}
```

### Forgot Password
```
POST /auth/forgot-password
{
  "email": "john@example.com"
}

Response (200):
{
  "message": "Password reset link sent to email"
}
```

### Reset Password
```
POST /auth/reset-password
{
  "token": "<reset_token>",
  "newPassword": "newpassword123"
}

Response (200):
{
  "message": "Password reset successfully"
}
```

### Google Sign-In
```
POST /auth/google
{
  "credential": "<google_id_token>",
  "role": "student|creator"
}

Response (200):
{
  "token": "eyJhbGc...",
  "user": { ... }
}
```

---

## User Endpoints

### Get User Stats
```
GET /user/stats
Authorization: Bearer <token>

Response (200):
{
  "userId": "507f1f77bcf86cd799439011",
  "name": "John Doe",
  "email": "john@example.com",
  "role": "student",
  "totalXP": 2540,
  "currentStreak": 5,
  "lastStudyDate": "2026-07-15T10:30:00Z",
  "longestStreak": 12,
  "totalSessions": 28,
  "averageAccuracy": 82.5,
  // For creators:
  "studentCount": 15,
  "wordCount": 450,
  "classCode": "ABC123"
}
```

### Update Profile
```
POST /user/update-profile
Authorization: Bearer <token>
{
  "name": "Jane Doe"
}

Response (200):
{
  "id": "507f1f77bcf86cd799439011",
  "name": "Jane Doe",
  "email": "john@example.com",
  "role": "student"
}
```

### Change Password
```
POST /user/change-password
Authorization: Bearer <token>
{
  "currentPassword": "password123",
  "newPassword": "newpassword456"
}

Response (200):
{
  "message": "Password changed successfully"
}
```

---

## Word Endpoints

### Get Words
```
GET /words?limit=50&skip=0
Authorization: Bearer <token>

Response (200):
{
  "words": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "word": "serendipity",
      "definition": "Finding something good without looking for it",
      "difficulty": "medium",
      "userId": "507f1f77bcf86cd799439012",
      "createdAt": "2026-07-01T00:00:00Z"
    }
  ],
  "total": 450,
  "limit": 50,
  "skip": 0
}
```

### Get Word by ID
```
GET /words/:id
Authorization: Bearer <token>

Response (200):
{
  "_id": "507f1f77bcf86cd799439011",
  "word": "serendipity",
  "definition": "Finding something good without looking for it",
  "difficulty": "medium",
  "userId": "507f1f77bcf86cd799439012"
}
```

### Create Word
```
POST /words
Authorization: Bearer <token>
Content-Type: application/json
X-CSRF-Token: <csrf_token>

{
  "word": "serendipity",
  "definition": "Finding something good without looking for it",
  "difficulty": "medium",
  "partOfSpeech": "noun"
}

Response (201):
{
  "_id": "507f1f77bcf86cd799439011",
  "word": "serendipity",
  "definition": "Finding something good without looking for it",
  "difficulty": "medium",
  "userId": "507f1f77bcf86cd799439012"
}
```

### Update Word
```
PUT /words/:id
Authorization: Bearer <token>
Content-Type: application/json
X-CSRF-Token: <csrf_token>

{
  "definition": "Finding something valuable without looking",
  "difficulty": "hard"
}

Response (200):
{
  "_id": "507f1f77bcf86cd799439011",
  "word": "serendipity",
  "definition": "Finding something valuable without looking",
  "difficulty": "hard"
}
```

### Delete Word
```
DELETE /words/:id
Authorization: Bearer <token>
X-CSRF-Token: <csrf_token>

Response (204): No content
```

### Get Word Stats
```
GET /words/stats
Authorization: Bearer <token>

Response (200):
{
  "totalWords": 450,
  "mostDifficult": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "word": "ubiquitous",
      "difficulty": "hard",
      "attempts": 150
    }
  ],
  "averageDifficulty": "medium",
  "studentProgress": {
    "learned": 150,
    "learning": 120,
    "new": 180
  }
}
```

---

## Learning Session Endpoints

### Save Learning Session
```
POST /learning-session
Authorization: Bearer <token>
X-CSRF-Token: <csrf_token>

{
  "mode": "flashcard|quiz|matching|spelling",
  "wordIds": ["507f1f77bcf86cd799439011"],
  "totalCards": 10,
  "correctAnswers": 8,
  "incorrectAnswers": 2,
  "xpEarned": 120,
  "maxCombo": 5,
  "durationSeconds": 420,
  "wordPerformance": [
    {
      "wordId": "507f1f77bcf86cd799439011",
      "correct": true,
      "quality": 4,
      "timeSpent": 3000
    }
  ]
}

Response (201):
{
  "_id": "507f1f77bcf86cd799439013",
  "userId": "507f1f77bcf86cd799439011",
  "mode": "flashcard",
  "accuracy": 80,
  "xpEarned": 120,
  "completedAt": "2026-07-15T10:30:00Z"
}
```

### Get User Sessions
```
GET /learning-session?limit=20&skip=0&mode=flashcard
Authorization: Bearer <token>

Response (200):
{
  "sessions": [
    {
      "_id": "507f1f77bcf86cd799439013",
      "mode": "flashcard",
      "accuracy": 80,
      "xpEarned": 120,
      "durationSeconds": 420,
      "completedAt": "2026-07-15T10:30:00Z"
    }
  ],
  "total": 28,
  "limit": 20,
  "skip": 0
}
```

---

## CSRF Protection

### Get CSRF Token
```
GET /csrf-token

Response (200):
{
  "token": "eyJhbGc..."
}
```

Include the CSRF token in all state-changing requests (POST, PUT, DELETE) as a header:
```
X-CSRF-Token: <token>
```

---

## Error Responses

### 400 Bad Request
```json
{
  "message": "Validation error description"
}
```

### 401 Unauthorized
```json
{
  "message": "Invalid email or password"
}
```

### 403 Forbidden
```json
{
  "message": "Invalid creator access code"
}
```

### 404 Not Found
```json
{
  "message": "Resource not found"
}
```

### 409 Conflict
```json
{
  "message": "An account with this email already exists"
}
```

### 500 Internal Server Error
```json
{
  "message": "Server error message"
}
```

---

## Rate Limiting

- **Auth endpoints:** 5 requests per 15 minutes per IP
- **API endpoints:** 100 requests per 15 minutes per user
- **AI endpoints:** 10 requests per 15 minutes per user

---

## Client Library (api.js)

### Initialization
```javascript
// Set auth token
setAuth(token, user);

// Get current user
const user = getUser();

// Check if authenticated
const token = getToken();

// Clear auth
clearAuth();
```

### Making Requests
```javascript
// GET request
const data = await api.get('/words?limit=50');

// POST request
const response = await api.post('/words', {
  word: 'serendipity',
  definition: '...',
  difficulty: 'medium'
});

// PUT request
const updated = await api.put(`/words/${id}`, {
  definition: 'New definition'
});

// DELETE request
await api.delete(`/words/${id}`);
```

---

## Environment Variables

```env
# Database
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/vocabmaster

# Authentication
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=7d

# Creator Security
CREATOR_ACCESS_CODE=your-admin-code

# Email Service (optional)
RESEND_API_KEY=key_...
FROM_EMAIL=noreply@vocab.master

# Google Sign-In
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com

# Server
PORT=3000
NODE_ENV=development
```

---

## Database Schema

### User
```javascript
{
  _id: ObjectId,
  name: String,
  email: String (unique),
  password: String (hashed),
  role: String (student|creator),
  creatorCode: String (unique, for creators only),
  linkedCreatorCode: String (for students only),
  isVerified: Boolean,
  verificationToken: String,
  verificationExpires: Date,
  totalXP: Number (default: 0),
  currentStreak: Number (default: 0),
  longestStreak: Number (default: 0),
  lastStudyDate: Date,
  totalSessions: Number (default: 0),
  averageAccuracy: Number (default: 0),
  createdAt: Date,
  updatedAt: Date
}
```

### Word
```javascript
{
  _id: ObjectId,
  word: String (required),
  definition: String (required),
  partOfSpeech: String,
  difficulty: String (easy|medium|hard),
  userId: ObjectId (creator),
  examples: [String],
  createdAt: Date,
  updatedAt: Date
}
```

### LearningSession
```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  mode: String (flashcard|quiz|matching|spelling),
  wordIds: [ObjectId],
  totalCards: Number,
  correctAnswers: Number,
  incorrectAnswers: Number,
  accuracy: Number (0-100%),
  xpEarned: Number,
  maxCombo: Number,
  durationSeconds: Number,
  wordPerformance: [{
    wordId: ObjectId,
    correct: Boolean,
    quality: Number (0-5),
    timeSpent: Number (ms)
  }],
  completedAt: Date,
  createdAt: Date,
  updatedAt: Date
}
```

---

## Example Workflows

### Student Registration & First Study
```javascript
// 1. Register
await api.post('/auth/register', {
  name: 'John Doe',
  email: 'john@example.com',
  password: 'pass123',
  role: 'student',
  linkedCreatorCode: 'ABC123'
});

// 2. Login
const {token, user} = await api.post('/auth/login', {
  email: 'john@example.com',
  password: 'pass123',
  role: 'student'
});
setAuth(token, user);

// 3. Get vocabulary
const {words} = await api.get('/words?limit=100');

// 4. Study with flashcards, then save session
const session = {
  mode: 'flashcard',
  totalCards: 10,
  correctAnswers: 8,
  xpEarned: 120,
  // ...
};
await api.post('/learning-session', session);
```

### Creator Class Management
```javascript
// 1. Register as creator
await api.post('/auth/register', {
  name: 'Jane Smith',
  email: 'jane@school.com',
  password: 'pass123',
  role: 'creator',
  creatorPortalCode: 'admin-code'
});

// 2. Login and get class code
const {token, user} = await api.post('/auth/login', {...});
setAuth(token, user);
const classCode = user.creatorCode; // Share with students

// 3. Add words to class
await api.post('/words', {
  word: 'serendipity',
  definition: 'Finding good without looking',
  difficulty: 'medium'
});

// 4. Monitor student progress
const stats = await api.get('/user/stats');
console.log(`Students in class: ${stats.studentCount}`);
```

---

**Last Updated:** July 15, 2026  
**API Version:** 1.0  
**Status:** Production Ready
