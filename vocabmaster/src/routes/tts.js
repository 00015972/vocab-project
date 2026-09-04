const express = require('express');
const axios = require('axios');
const router = express.Router();

async function fetchDictionaryAudio(word) {
  const lookupUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  const lookupResponse = await axios.get(lookupUrl, { timeout: 7000 });
  const entries = Array.isArray(lookupResponse.data) ? lookupResponse.data : [];

  for (const entry of entries) {
    const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
    for (const item of phonetics) {
      if (!item || !item.audio) continue;
      const audioUrl = item.audio.startsWith('//') ? `https:${item.audio}` : item.audio;
      if (!/^https?:\/\//i.test(audioUrl)) continue;

      const audioResponse = await axios.get(audioUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
      });

      return {
        buffer: Buffer.from(audioResponse.data),
        contentType: audioResponse.headers['content-type'] || 'audio/mpeg',
      };
    }
  }

  return null;
}

async function fetchStreamElementsAudio(text) {
  const url = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(text)}`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 12000,
  });

  return {
    buffer: Buffer.from(response.data),
    contentType: response.headers['content-type'] || 'audio/mpeg',
  };
}

async function fetchGoogleFallbackAudio(text) {
  const urls = [
    `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(text)}`,
    `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=en&client=gtx&q=${encodeURIComponent(text)}`,
  ];

  let lastErr = null;
  for (const url of urls) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
        },
      });
      return {
        buffer: Buffer.from(response.data),
        contentType: response.headers['content-type'] || 'audio/mpeg',
      };
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('Google fallback failed');
}

async function handleTtsRequest(textInput, providerInput, res) {
  const text = String(textInput || '').trim();
  const provider = String(providerInput || '').trim();

  try {
    if (!text) {
      return res.status(400).json({ message: 'Text is required' });
    }

    const cartesiaApiKey = String(process.env.CARTESIA_API_KEY || '').trim();
    const cartesiaVoiceId = String(process.env.CARTESIA_VOICE_ID || '').trim();
    const elevenLabsApiKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    const preferredProvider = String(provider || process.env.TTS_PROVIDER || 'cartesia').toLowerCase();
    const preferElevenLabs = preferredProvider === 'elevenlabs';
    const preferCartesia = preferredProvider === 'cartesia' || (!provider && Boolean(cartesiaApiKey));
    const canUseCartesia = Boolean(cartesiaApiKey && cartesiaVoiceId);
    const canUseElevenLabs = Boolean(elevenLabsApiKey && voiceId);
    let elevenLabsFailure = '';

    const tryCartesia = async () => {
      const response = await axios.post(
        'https://api.cartesia.ai/tts/stream',
        {
          model_id: 'sonic-english',
          voice: {
            mode: 'id',
            id: cartesiaVoiceId,
          },
          input: text,
          output_format: { container: 'mp3', codec: 'libmp3lame', sample_rate: 44100 },
        },
        {
          headers: {
            'X-API-Key': cartesiaApiKey,
            'Content-Type': 'application/json',
          },
          responseType: 'arraybuffer',
          timeout: 30000,
        }
      );

      const contentType = response.headers?.['content-type'] || 'audio/mpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-TTS-Source', 'cartesia');
      return res.send(Buffer.from(response.data));
    };

    const tryElevenLabs = async () => {
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
          },
        },
        {
          headers: {
            'xi-api-key': elevenLabsApiKey,
            'Content-Type': 'application/json',
          },
          responseType: 'arraybuffer',
        }
      );

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('X-TTS-Source', 'elevenlabs');
      return res.send(Buffer.from(response.data));
    };

    if (canUseCartesia && (preferCartesia || (!preferElevenLabs && !provider))) {
      try {
        return await tryCartesia();
      } catch (providerErr) {
        console.error('Cartesia TTS provider error, using fallback:', providerErr.message);
      }
    }

    if (canUseElevenLabs && preferElevenLabs) {
      try {
        return await tryElevenLabs();
      } catch (providerErr) {
        const status = Number(providerErr?.response?.status || 0);
        elevenLabsFailure = `preferred:${status || 'error'}:${providerErr.message || 'unknown'}`;
        console.error('Preferred ElevenLabs provider error, using fallback:', providerErr.message);
      }
    }

    try {
      const dictionaryAudio = await fetchDictionaryAudio(text);
      if (dictionaryAudio) {
        res.setHeader('Content-Type', dictionaryAudio.contentType);
        res.setHeader('X-TTS-Source', 'dictionary');
        return res.send(dictionaryAudio.buffer);
      }
    } catch (dictionaryErr) {
      console.error('Dictionary audio lookup failed:', dictionaryErr.message);
    }

    if (canUseElevenLabs && (!provider || preferredProvider === 'elevenlabs' || (!canUseCartesia && !preferCartesia))) {
      try {
        return await tryElevenLabs();
      } catch (providerErr) {
        const status = Number(providerErr?.response?.status || 0);
        elevenLabsFailure = `standard:${status || 'error'}:${providerErr.message || 'unknown'}`;
        console.error('ElevenLabs provider error, using fallback:', providerErr.message);
      }
    }

    try {
      const streamAudio = await fetchStreamElementsAudio(text);
      if (streamAudio) {
        res.setHeader('Content-Type', streamAudio.contentType);
        res.setHeader('X-TTS-Source', 'stream-elements');
        if (elevenLabsFailure) res.setHeader('X-TTS-Error', elevenLabsFailure);
        return res.send(streamAudio.buffer);
      }
    } catch (streamErr) {
      console.error('StreamElements fallback failed:', streamErr.message);
    }

    const fallbackAudio = await fetchGoogleFallbackAudio(text);
    res.setHeader('Content-Type', fallbackAudio.contentType);
    res.setHeader('X-TTS-Source', 'google-fallback');
    if (elevenLabsFailure) res.setHeader('X-TTS-Error', elevenLabsFailure);
    return res.send(fallbackAudio.buffer);
  } catch (error) {
    console.error('TTS error:', error.message);
    return res.status(502).json({ message: 'Failed to generate audio' });
  }
}

router.post('/', async (req, res) => {
  const body = req.body || {};
  return handleTtsRequest(body.text, body.provider, res);
});

router.get('/', async (req, res) => {
  return handleTtsRequest(req.query?.text, req.query?.provider, res);
});

module.exports = router;
