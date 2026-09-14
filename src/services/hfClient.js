const axios = require('axios');

const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY || '';
const HUGGINGFACE_MODEL_DEFAULT = process.env.HUGGINGFACE_MODEL_DEFAULT || 'google/flan-t5-large';

async function callHuggingFace(prompt, modelName) {
  if (!HUGGINGFACE_API_KEY) throw new Error('HUGGINGFACE_API_KEY is not set in environment');
  const model = String(modelName || HUGGINGFACE_MODEL_DEFAULT).trim();
  const url = `https://api-inference.huggingface.co/models/${model}`;
  try {
    const resp = await axios.post(url, { inputs: prompt, options: { wait_for_model: true } }, {
      headers: {
        Authorization: `Bearer ${HUGGINGFACE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });
    return resp.data;
  } catch (err) {
    const msg = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`HuggingFace request failed: ${msg}`);
  }
}

module.exports = { callHuggingFace, HUGGINGFACE_MODEL_DEFAULT };
