const http = require('http');

async function testCohortAnalytics() {
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjBmODQ4YmY0LTAxYjgtNDc0MC1hOTI5LWU4NDY5ZGVkN2M3OSIsImlhdCI6MTcyMTA5MTE4MCwiZXhwIjoxNzIxNjk2MzgwfQ.0AZ_IbkYFYx4CIXz9iZXr7C3B8Xj1U6qXJJ3qjnxGPc';
  
  return new Promise((resolve, reject) => {
    const req = http.get('http://localhost:3000/api/creator/cohort-analytics', {
      headers: { 'Authorization': 'Bearer ' + token }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Cohort Analytics Status:', res.statusCode);
        console.log('Response:', data.substring(0, 300));
        resolve();
      });
    });
    req.on('error', reject);
  });
}

testCohortAnalytics().catch(err => console.error(err));
