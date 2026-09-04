const http = require('http');

const BASE_URL = 'http://localhost:3000';

async function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: null, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('\n=== DEBUGGING CSV EXPORT ISSUE ===\n');

  try {
    // Step 1: Health check
    console.log('Step 1: Health check...');
    const health = await request('GET', '/api/health');
    console.log('Health:', health.status, '\n');

    // Step 2: Login
    console.log('Step 2: Logging in as creator...');
    const loginRes = await request('POST', '/api/auth/login', {
      email: 'creator@test.local',
      password: 'Creator123!',
      role: 'creator',
      creatorPortalCode: 'creator123'
    });
    console.log('Login status:', loginRes.status);
    const token = loginRes.body?.token;
    if (!token) {
      console.log('ERROR: No token received!');
      console.log('Response:', loginRes.body);
      return;
    }
    console.log('Got token:', token.substring(0, 20) + '...\n');

    // Step 3: Try CSV export
    console.log('Step 3: Requesting CSV export...');
    const csvRes = await request('GET', '/api/creator/export/analytics?format=csv');
    // Add token manually
    const url = new URL('/api/creator/export/analytics?format=csv', BASE_URL);
    const csvOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };

    const csvResult = await new Promise((resolve) => {
      const req = http.request(csvOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, body: parsed, raw: data });
          } catch {
            resolve({ status: res.statusCode, body: null, raw: data });
          }
        });
      });
      req.on('error', (err) => resolve({ error: err.message }));
      req.end();
    });

    console.log('CSV Export response status:', csvResult.status);
    if (csvResult.error) {
      console.log('ERROR:', csvResult.error);
    } else if (csvResult.status === 500) {
      console.log('ERROR (500):', csvResult.body?.message);
      console.log('Full response:', JSON.stringify(csvResult.body, null, 2));
    } else if (csvResult.status === 200) {
      console.log('SUCCESS! CSV generated');
      console.log('CSV length:', csvResult.raw.length);
      console.log('First 200 chars:', csvResult.raw.substring(0, 200));
    }

  } catch (err) {
    console.error('Test error:', err.message);
  }

  console.log('\n=== TEST COMPLETE ===\n');
  process.exit(0);
}

runTests();
