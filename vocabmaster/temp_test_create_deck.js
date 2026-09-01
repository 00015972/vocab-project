const axios = require('axios');
(async()=>{
  try{
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhNTcxNjYyNjlkNjdkYzZhMjk1NDI1ZCIsImlhdCI6MTc4NzIxMzMwOSwiZXhwIjoxNzg3ODE4MTA5fQ.egA2rIv_eBUJNMXPn2eQcjX9Q0isBl9j-_DHlufEyH8';
    const words = ['serendipity','eloquent','tenacity'];
    const suggest = await axios.post('http://localhost:3000/api/ai/suggest-deck', { words }, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
    console.log('SUGGEST', suggest.data);
    const sug = suggest.data && suggest.data.suggestion ? suggest.data.suggestion : null;
    if (!sug) return console.error('No suggestion');
    const deckResp = await axios.post('http://localhost:3000/api/decks', { name: sug.name, topic: sug.topic, difficulty: sug.difficulty, description: sug.description }, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
    console.log('DECK CREATED', deckResp.data);
    const deck = deckResp.data && deckResp.data.deck ? deckResp.data.deck : null;
    if (!deck) return console.error('Deck not created');
    const importPayload = words.map(w=>({ word: w, definition: '', example: '', partOfSpeech: 'other', deckId: deck._id }));
    const imp = await axios.post('http://localhost:3000/api/words/bulk/import', { words: importPayload }, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
    console.log('IMPORT', imp.data);
  }catch(err){
    if (err.response) console.error('ERR', err.response.status, err.response.data);
    else console.error(err.message);
  }
})();