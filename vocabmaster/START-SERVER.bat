@echo off
REM Taleem Lexicon - Server Startup Script (Windows)

echo.
echo ========================================
echo  TALEEM LEXICON - Server Startup
echo ========================================
echo.

REM Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js 14+ first.
    pause
    exit /b 1
)

echo [OK] Node.js found: 
node --version

REM Check npm
npm --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found. Please install npm first.
    pause
    exit /b 1
)

echo [OK] npm found: 
npm --version

REM Install dependencies if needed
if not exist "node_modules\" (
    echo.
    echo [INFO] Installing dependencies...
    call npm install
)

echo [OK] Dependencies ready

REM Check .env file
if not exist ".env" (
    echo.
    echo [WARN] .env file not found. Creating with defaults...
    (
        echo # Environment Configuration
        echo NODE_ENV=development
        echo PORT=3000
        echo DATABASE_URL=mongodb://localhost:27017/taleem-lexicon
        echo JWT_SECRET=your-secret-key-change-in-production
        echo JWT_EXPIRES_IN=7d
        echo SESSION_SECRET=session-secret-change-in-production
        echo OPENAI_API_KEY=sk-your-key-here
        echo TTS_PROVIDER=google
        echo STORAGE_PROVIDER=local
        echo CLIENT_URL=http://localhost:3000
        echo GOOGLE_TTS_KEY_FILE=./google-cloud-key.json
        echo TTS_API_KEY=your-api-key
        echo MAIL_HOST=smtp.gmail.com
        echo MAIL_PORT=587
        echo MAIL_USER=your-email@gmail.com
        echo MAIL_PASS=your-app-password
    ) > .env
    echo [INFO] Created .env - update API keys as needed
)

echo [OK] Configuration ready

REM Start server
echo.
echo ========================================
echo  Starting server on http://localhost:3000
echo ========================================
echo.

call npm start
REM Alternative for development: npm run dev

pause
