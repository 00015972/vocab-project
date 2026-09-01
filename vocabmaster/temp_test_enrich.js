const axios = require('axios');
(async function(){
  try{
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhNTcxNjYyNjlkNjdkYzZhMjk1NDI1ZCIsImlhdCI6MTc4NzIxMzMwOSwiZXhwIjoxNzg3ODE4MTA5fQ.egA2rIv_eBUJNMXPn2eQcjX9Q0isBl9j-_DHlufEyH8';
    const res = await axios.post('http://localhost:3000/api/ai/enrich-words', { words: ['serendipity','eloquent','tenacity'] }, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, timeout: 120000 });
    console.log('OK', JSON.stringify(res.data, null, 2));
  }catch(err){
    if (err.response) {
      console.error('ERR RESPONSE', err.response.status, err.response.data);
    } else {
      console.error('ERR', err.message);
    }
    process.exit(1);
  }
})();