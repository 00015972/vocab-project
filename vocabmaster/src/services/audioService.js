/**
 * Audio Management Service
 * Handles: TTS, Recording, Storage, Pronunciation Checking
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

class AudioService {
  constructor() {
    // TTS Provider: Google Cloud Text-to-Speech or AWS Polly
    this.ttsProvider = process.env.TTS_PROVIDER || 'google'; // google, aws, azure
    this.ttsApiKey = process.env.TTS_API_KEY;
    
    // Storage: AWS S3, Google Cloud Storage, or local
    this.storageProvider = process.env.STORAGE_PROVIDER || 'local';
    this.storagePath = './public/audio'; // Local storage path
  }

  /**
   * Generate TTS audio for a word or sentence
   * @param {string} text - Text to convert to speech
   * @param {string} language - Language code (es, fr, en, etc.)
   * @param {string} voice - Specific voice ID (optional)
   * @returns {Promise<{url: string, duration: number}>}
   */
  async generateTTS(text, language, voice = null) {
    try {
      let audioData, duration;

      if (this.ttsProvider === 'google') {
        ({ audioData, duration } = await this.generateGoogleTTS(text, language, voice));
      } else if (this.ttsProvider === 'azure') {
        ({ audioData, duration } = await this.generateAzureTTS(text, language, voice));
      } else if (this.ttsProvider === 'aws') {
        ({ audioData, duration } = await this.generateAWSPolly(text, language, voice));
      }

      // Store the audio file
      const url = await this.storeAudio(audioData, language, text.substring(0, 20));

      return { url, duration, text, language };
    } catch (err) {
      console.error('TTS generation failed:', err);
      throw new Error('Failed to generate audio');
    }
  }

  /**
   * Generate using Google Cloud Text-to-Speech
   * @private
   */
  async generateGoogleTTS(text, language, voice) {
    const googleTTS = require('@google-cloud/text-to-speech');
    const client = new googleTTS.TextToSpeechClient({
      keyFilename: process.env.GOOGLE_TTS_KEY_FILE,
    });

    // Map language codes
    const voiceMap = {
      es: { languageCode: 'es-ES', name: 'es-ES-Neural2-A' }, // Spanish
      fr: { languageCode: 'fr-FR', name: 'fr-FR-Neural2-A' }, // French
      de: { languageCode: 'de-DE', name: 'de-DE-Neural2-A' }, // German
      it: { languageCode: 'it-IT', name: 'it-IT-Neural2-A' }, // Italian
      pt: { languageCode: 'pt-BR', name: 'pt-BR-Neural2-A' }, // Portuguese
      en: { languageCode: 'en-US', name: 'en-US-Neural2-C' }, // English
      ar: { languageCode: 'ar-XA', name: 'ar-XA-Standard-A' }, // Arabic
    };

    const voiceConfig = voiceMap[language] || voiceMap.en;

    const request = {
      input: { text },
      voice: {
        languageCode: voiceConfig.languageCode,
        name: voice || voiceConfig.name,
      },
      audioConfig: {
        audioEncoding: 'MP3',
        pitch: 0,
        speakingRate: 1,
      },
    };

    const [response] = await client.synthesizeSpeech(request);
    const audioContent = response.audioContent;

    // Estimate duration (rough: ~150 words per minute = 0.4s per word)
    const wordCount = text.split(' ').length;
    const duration = (wordCount / 150) * 60;

    return { audioData: audioContent, duration };
  }

  /**
   * Generate using Azure Cognitive Services
   * @private
   */
  async generateAzureTTS(text, language, voice) {
    const axios = require('axios');

    const voiceMap = {
      es: 'es-ES-AlvaroNeural',
      fr: 'fr-FR-DeniseNeural',
      de: 'de-DE-KatjaNeural',
      en: 'en-US-AriaNeural',
    };

    const endpoint = `https://${process.env.AZURE_TTS_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const ssml = `
      <speak version="1.0" xml:lang="${language}">
        <voice name="${voice || voiceMap[language]}">
          ${this.escapeXML(text)}
        </voice>
      </speak>
    `;

    const response = await axios.post(endpoint, ssml, {
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_TTS_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3',
      },
      responseType: 'arraybuffer',
    });

    const wordCount = text.split(' ').length;
    const duration = (wordCount / 150) * 60;

    return { audioData: response.data, duration };
  }

  /**
   * Generate using AWS Polly
   * @private
   */
  async generateAWSPolly(text, language, voice) {
    const AWS = require('aws-sdk');
    const polly = new AWS.Polly({
      region: process.env.AWS_REGION,
    });

    const voiceMap = {
      es: 'Lucia',
      fr: 'Celine',
      de: 'Hans',
      en: 'Joanna',
    };

    const params = {
      Text: text,
      OutputFormat: 'mp3',
      VoiceId: voice || voiceMap[language] || 'Joanna',
      Engine: 'neural',
    };

    const result = await polly.synthesizeSpeech(params).promise();
    const audioData = result.AudioStream;

    const wordCount = text.split(' ').length;
    const duration = (wordCount / 150) * 60;

    return { audioData, duration };
  }

  /**
   * Store audio file
   * @private
   */
  async storeAudio(audioData, language, identifier) {
    if (this.storageProvider === 'local') {
      const filename = `${language}_${Date.now()}_${identifier.replace(/\s+/g, '_')}.mp3`;
      const filepath = path.join(this.storagePath, language, filename);

      // Create directory if it doesn't exist
      await fs.mkdir(path.dirname(filepath), { recursive: true });
      await fs.writeFile(filepath, audioData);

      return `/audio/${language}/${filename}`;
    } else if (this.storageProvider === 's3') {
      // Upload to AWS S3
      const AWS = require('aws-sdk');
      const s3 = new AWS.S3();

      const key = `audio/${language}/${Date.now()}_${identifier}.mp3`;
      await s3
        .putObject({
          Bucket: process.env.AWS_S3_BUCKET,
          Key: key,
          Body: audioData,
          ContentType: 'audio/mpeg',
          CacheControl: 'max-age=31536000', // 1 year cache
        })
        .promise();

      return `https://${process.env.AWS_S3_BUCKET}.s3.amazonaws.com/${key}`;
    }
  }

  /**
   * Check pronunciation of user recording
   * Compares user audio with reference pronunciation
   * @param {Buffer} userAudio - User's recorded audio
   * @param {string} referenceUrl - URL of reference pronunciation
   * @param {string} language - Language code
   * @returns {Promise<{score: number, feedback: string}>}
   */
  async checkPronunciation(userAudio, referenceUrl, language) {
    try {
      // Download reference audio
      const referenceAudio = await axios.get(referenceUrl, {
        responseType: 'arraybuffer',
      });

      // Use speech recognition + comparison
      const userTranscription = await this.transcribeAudio(userAudio, language);
      const referenceTranscription = await this.transcribeAudio(
        referenceAudio.data,
        language
      );

      // Compare transcriptions (simple string match)
      const similarity = this.calculateSimilarity(userTranscription, referenceTranscription);

      // In production, use phonetic analysis or ML-based comparison
      const score = Math.round(similarity * 100);

      let feedback = '';
      if (score >= 90) {
        feedback = 'Perfect pronunciation! 🎉';
      } else if (score >= 75) {
        feedback = 'Good! Very close to the reference pronunciation.';
      } else if (score >= 60) {
        feedback = 'Not bad! Try to match the reference pronunciation more closely.';
      } else {
        feedback = 'Keep practicing! Listen to the reference and try again.';
      }

      return { score, feedback, userTranscription, referenceTranscription };
    } catch (err) {
      console.error('Pronunciation check failed:', err);
      return { score: 0, feedback: 'Could not check pronunciation. Please try again.' };
    }
  }

  /**
   * Transcribe audio to text using speech recognition
   * @private
   */
  async transcribeAudio(audioData, language) {
    // Use Google Cloud Speech-to-Text or Azure Speech Services
    const speech = require('@google-cloud/speech');
    const client = new speech.SpeechClient({
      keyFilename: process.env.GOOGLE_SPEECH_KEY_FILE,
    });

    const request = {
      audio: { content: audioData },
      config: {
        encoding: 'MP3',
        sampleRateHertz: 16000,
        languageCode: `${language}-${language.toUpperCase()}`,
      },
    };

    const [response] = await client.recognize(request);
    const transcription = response.results
      .map((result) => result.alternatives[0].transcript)
      .join('\n');

    return transcription.toLowerCase();
  }

  /**
   * Calculate similarity between two strings
   * @private
   */
  calculateSimilarity(str1, str2) {
    const s1 = str1.toLowerCase().split(' ');
    const s2 = str2.toLowerCase().split(' ');

    let matches = 0;
    const maxLen = Math.max(s1.length, s2.length);

    for (let i = 0; i < Math.min(s1.length, s2.length); i++) {
      if (this.levenshteinDistance(s1[i], s2[i]) <= 1) {
        matches++;
      }
    }

    return matches / maxLen;
  }

  /**
   * Levenshtein distance for string comparison
   * @private
   */
  levenshteinDistance(a, b) {
    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * Escape XML special characters
   * @private
   */
  escapeXML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

module.exports = new AudioService();
