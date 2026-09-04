/**
 * Export Feature Test Suite
 * Tests CSV and PDF export functionality end-to-end
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Test configuration
const BASE_URL = 'http://localhost:3000';
const TEST_TOKEN = 'test-token'; // Will get real token from login
let creatorToken = null;

// Test results
const results = {
  totalTests: 0,
  passed: 0,
  failed: 0,
  errors: []
};

// Helper: Make HTTP request
async function makeRequest(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    };

    if (options.token) {
      reqOptions.headers['Authorization'] = `Bearer ${options.token}`;
    }

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          bodyJson: (() => {
            try {
              return JSON.parse(data);
            } catch (e) {
              return null;
            }
          })()
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }

    req.end();
  });
}

// Test: Check health endpoint
async function testHealthEndpoint() {
  console.log('\n✓ Test: Health Endpoint');
  results.totalTests++;
  
  try {
    const res = await makeRequest('GET', '/api/health');
    if (res.status === 200) {
      console.log('  ✓ Health check passed (HTTP 200)');
      results.passed++;
      return true;
    } else {
      throw new Error(`Unexpected status: ${res.status}`);
    }
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}`);
    results.failed++;
    results.errors.push(`Health endpoint: ${err.message}`);
    return false;
  }
}

// Test: Get demo creator token (using devStore data)
async function testGetCreatorToken() {
  console.log('\n✓ Test: Get Creator Authentication');
  results.totalTests++;
  
  try {
    // In dev mode, we need to get a real JWT token
    // For testing, we'll use the /api/auth/login endpoint
    const res = await makeRequest('POST', '/api/auth/login', {
      body: {
        email: 'creator@test.local',
        password: 'Creator123!',
        role: 'creator',
        creatorPortalCode: 'creator123'  // Dev mode default code
      }
    });

    if (res.status === 200 && res.bodyJson && res.bodyJson.token) {
      creatorToken = res.bodyJson.token;
      console.log('  ✓ Got creator token');
      results.passed++;
      return true;
    } else {
      throw new Error(`Login failed: ${res.status} ${res.body}`);
    }
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}`);
    results.failed++;
    results.errors.push(`Auth: ${err.message}`);
    return false;
  }
}

// Test: CSV Export Endpoint
async function testCSVExport() {
  console.log('\n✓ Test: CSV Export Endpoint');
  results.totalTests++;
  
  if (!creatorToken) {
    console.log('  ✗ No authentication token');
    results.failed++;
    return false;
  }

  try {
    const res = await makeRequest('GET', '/api/creator/export/analytics?format=csv', {
      token: creatorToken
    });

    if (res.status === 200 && res.headers['content-type'].includes('text/csv')) {
      console.log('  ✓ CSV export successful (HTTP 200)');
      console.log(`  ✓ Content-Type: ${res.headers['content-type']}`);
      console.log(`  ✓ CSV size: ${res.body.length} bytes`);
      
      // Verify CSV structure
      if (res.body.includes('CLASS ANALYTICS SNAPSHOT')) {
        console.log('  ✓ CSV has correct header');
        results.passed++;
        
        // Save CSV for manual inspection
        fs.writeFileSync('test-export.csv', res.body);
        console.log('  ✓ CSV saved to test-export.csv');
        return true;
      } else {
        throw new Error('CSV missing header');
      }
    } else {
      // Show error details
      console.log(`  Error response: ${res.body.substring(0, 500)}`);
      throw new Error(`Unexpected response: ${res.status}`);
    }
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}`);
    results.failed++;
    results.errors.push(`CSV Export: ${err.message}`);
    return false;
  }
}

// Test: PDF Export Endpoint
async function testPDFExport() {
  console.log('\n✓ Test: PDF Export Endpoint');
  results.totalTests++;
  
  if (!creatorToken) {
    console.log('  ✗ No authentication token');
    results.failed++;
    return false;
  }

  try {
    const res = await makeRequest('GET', '/api/creator/export/analytics?format=pdf', {
      token: creatorToken
    });

    if (res.status === 200 && res.bodyJson) {
      console.log('  ✓ PDF export endpoint successful (HTTP 200)');
      console.log(`  ✓ Content-Type: ${res.headers['content-type']}`);
      
      // Verify PDF data structure
      if (res.bodyJson.format === 'pdf' && res.bodyJson.html && res.bodyJson.filename) {
        console.log('  ✓ PDF data structure valid');
        console.log(`  ✓ HTML size: ${res.bodyJson.html.length} bytes`);
        console.log(`  ✓ Filename: ${res.bodyJson.filename}`);
        
        // Verify HTML content
        if (res.bodyJson.html.includes('Class Analytics Report')) {
          console.log('  ✓ HTML has correct title');
          results.passed++;
          
          // Save HTML for manual inspection
          fs.writeFileSync('test-export.html', res.bodyJson.html);
          console.log('  ✓ HTML saved to test-export.html');
          return true;
        } else {
          throw new Error('HTML missing title');
        }
      } else {
        throw new Error(`Invalid PDF structure: ${JSON.stringify(res.bodyJson).substring(0, 200)}`);
      }
    } else {
      throw new Error(`Unexpected response: ${res.status}`);
    }
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}`);
    results.failed++;
    results.errors.push(`PDF Export: ${err.message}`);
    return false;
  }
}

// Test: Invalid format rejection
async function testInvalidFormat() {
  console.log('\n✓ Test: Invalid Format Rejection');
  results.totalTests++;
  
  if (!creatorToken) {
    console.log('  ✗ No authentication token');
    results.failed++;
    return false;
  }

  try {
    const res = await makeRequest('GET', '/api/creator/export/analytics?format=xml', {
      token: creatorToken
    });

    if (res.status === 400) {
      console.log('  ✓ Invalid format properly rejected (HTTP 400)');
      console.log(`  ✓ Error message: ${res.bodyJson?.message || res.body}`);
      results.passed++;
      return true;
    } else {
      throw new Error(`Expected 400, got ${res.status}`);
    }
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}`);
    results.failed++;
    results.errors.push(`Invalid format: ${err.message}`);
    return false;
  }
}

// Test: Missing authentication
async function testAuthenticationRequired() {
  console.log('\n✓ Test: Authentication Required');
  results.totalTests++;
  
  try {
    const res = await makeRequest('GET', '/api/creator/export/analytics?format=csv');

    if (res.status === 401 || res.status === 403) {
      console.log(`  ✓ Unauthenticated request rejected (HTTP ${res.status})`);
      results.passed++;
      return true;
    } else {
      throw new Error(`Expected 401/403, got ${res.status}`);
    }
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}`);
    results.failed++;
    results.errors.push(`Auth required: ${err.message}`);
    return false;
  }
}

// Test: Cohort analytics data matches export data
async function testDataConsistency() {
  console.log('\n✓ Test: Data Consistency (Cohort vs Export)');
  results.totalTests++;
  
  if (!creatorToken) {
    console.log('  ✗ No authentication token');
    results.failed++;
    return false;
  }

  try {
    // Get cohort analytics
    const cohortRes = await makeRequest('GET', '/api/creator/cohort-analytics', {
      token: creatorToken
    });

    // Get export data
    const exportRes = await makeRequest('GET', '/api/creator/export/analytics?format=pdf', {
      token: creatorToken
    });

    if (cohortRes.status !== 200 || !cohortRes.bodyJson || exportRes.status !== 200 || !exportRes.bodyJson) {
      throw new Error('Failed to get data');
    }

    const cohortData = cohortRes.bodyJson;
    const exportData = exportRes.bodyJson.cohortData;

    // Compare key metrics
    const checks = [
      ['totalStudents', cohortData.overview.totalStudents === exportData.overview.totalStudents],
      ['activeStudents', cohortData.overview.activeStudents === exportData.overview.activeStudents],
      ['avgXP', cohortData.overview.avgXP === exportData.overview.avgXP],
      ['avgAccuracy', cohortData.overview.avgAccuracy === exportData.overview.avgAccuracy],
    ];

    let allMatch = true;
    checks.forEach(([key, matches]) => {
      if (matches) {
        console.log(`  ✓ ${key} matches`);
      } else {
        console.log(`  ✗ ${key} mismatch`);
        allMatch = false;
      }
    });

    if (allMatch) {
      results.passed++;
      return true;
    } else {
      throw new Error('Data consistency check failed');
    }
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}`);
    results.failed++;
    results.errors.push(`Data consistency: ${err.message}`);
    return false;
  }
}

// Main test runner
async function runTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EXPORT FEATURE - COMPREHENSIVE TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Server: ${BASE_URL}`);
  console.log(`  Time: ${new Date().toLocaleString()}`);
  console.log('');

  // Run tests in sequence
  await testHealthEndpoint();
  await testGetCreatorToken();
  await testCSVExport();
  await testPDFExport();
  await testInvalidFormat();
  await testAuthenticationRequired();
  await testDataConsistency();

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total Tests:  ${results.totalTests}`);
  console.log(`  Passed:       ${results.passed}`);
  console.log(`  Failed:       ${results.failed}`);
  console.log(`  Success Rate: ${Math.round((results.passed / results.totalTests) * 100)}%`);

  if (results.errors.length > 0) {
    console.log('\n  Errors:');
    results.errors.forEach(err => console.log(`    - ${err}`));
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  
  if (results.failed === 0) {
    console.log('  ✓ ALL TESTS PASSED');
  } else {
    console.log(`  ✗ ${results.failed} TEST(S) FAILED`);
  }
  
  console.log('═══════════════════════════════════════════════════════════\n');
  
  process.exit(results.failed === 0 ? 0 : 1);
}

// Run
runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
