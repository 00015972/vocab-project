#!/bin/bash
# Taleem Lexicon - Server Startup and Testing Guide

# ============================================================================
# QUICK START
# ============================================================================

echo "🚀 Taleem Lexicon Server Startup"
echo "=================================="

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 14+ first."
    exit 1
fi

echo "✅ Node.js found: $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found. Please install npm first."
    exit 1
fi

echo "✅ npm found: $(npm -v)"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

echo "✅ Dependencies ready"

# Check .env file
if [ ! -f ".env" ]; then
    echo "⚠️  .env file not found. Creating .env with default values..."
    cat > .env << 'EOF'
# Environment Configuration
NODE_ENV=development
PORT=3000
DATABASE_URL=mongodb://localhost:27017/taleem-lexicon
JWT_SECRET=your-secret-key-change-in-production
JWT_EXPIRES_IN=7d
SESSION_SECRET=session-secret-change-in-production
OPENAI_API_KEY=sk-your-key-here
TTS_PROVIDER=google
STORAGE_PROVIDER=local
CLIENT_URL=http://localhost:3000
GOOGLE_TTS_KEY_FILE=./google-cloud-key.json
TTS_API_KEY=your-api-key
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_USER=your-email@gmail.com
MAIL_PASS=your-app-password
EOF
    echo "📝 Created .env file - update API keys as needed"
fi

echo "✅ Configuration ready"

# ============================================================================
# START SERVER
# ============================================================================

echo ""
echo "🎯 Starting server on http://localhost:3000"
echo ""

npm start

# Alternative: Use nodemon for development
# npm run dev
