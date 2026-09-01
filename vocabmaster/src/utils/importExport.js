/**
 * Import/Export utilities for vocabulary decks
 * Supports: CSV, JSON, Anki (.apkg), Tab-separated
 */

const fs = require('fs');
const path = require('path');

class ImportExportService {
  /**
   * Parse CSV format: word, definition, example, partOfSpeech, difficulty, notes
   * @param {string} csvContent
   * @returns {array} Parsed words
   */
  parseCSV(csvContent) {
    const lines = csvContent.trim().split('\n');
    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const words = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map((v) => v.trim());
      if (values.length < 2) continue;

      const wordIndex = headers.indexOf('word');
      const defIndex = headers.indexOf('definition') || headers.indexOf('def');
      const exIndex = headers.indexOf('example') || headers.indexOf('ex');
      const posIndex = headers.indexOf('part of speech') || headers.indexOf('pos');
      const diffIndex = headers.indexOf('difficulty') || headers.indexOf('diff');
      const notesIndex = headers.indexOf('notes');

      words.push({
        word: values[wordIndex],
        definition: values[defIndex],
        example: values[exIndex] || '',
        partOfSpeech: values[posIndex] || 'other',
        difficulty: parseInt(values[diffIndex]) || 3,
        notes: values[notesIndex] || '',
      });
    }

    return words;
  }

  /**
   * Parse Tab-separated format
   * @param {string} tsvContent
   * @returns {array} Parsed words
   */
  parseTSV(tsvContent) {
    const lines = tsvContent.trim().split('\n');
    const headers = lines[0].split('\t').map((h) => h.trim().toLowerCase());
    const words = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      if (values.length < 2) continue;

      const wordIndex = headers.indexOf('word');
      const defIndex = headers.indexOf('definition');
      const exIndex = headers.indexOf('example');
      const posIndex = headers.indexOf('part of speech');
      const diffIndex = headers.indexOf('difficulty');

      words.push({
        word: values[wordIndex],
        definition: values[defIndex],
        example: values[exIndex] || '',
        partOfSpeech: values[posIndex] || 'other',
        difficulty: parseInt(values[diffIndex]) || 3,
      });
    }

    return words;
  }

  /**
   * Parse JSON format
   * @param {string} jsonContent
   * @returns {array} Parsed words
   */
  parseJSON(jsonContent) {
    try {
      const data = JSON.parse(jsonContent);
      if (Array.isArray(data)) {
        return data.map((item) => ({
          word: item.word || item.term,
          definition: item.definition || item.meaning,
          example: item.example || '',
          partOfSpeech: item.partOfSpeech || item.pos || 'other',
          difficulty: item.difficulty || 3,
          notes: item.notes || '',
        }));
      }
      return [];
    } catch (err) {
      throw new Error('Invalid JSON format');
    }
  }

  /**
   * Parse Anki apkg (simplified - treats as JSON/CSV inside)
   * Full apkg parsing requires SQLite extraction
   * This is a basic text-based fallback
   * @param {string} content
   * @returns {array}
   */
  parseAnki(content) {
    // Try to extract JSON/CSV content from apkg
    // Full implementation requires extracting ZIP and SQLite
    // For now, assume content is already extracted
    try {
      return this.parseJSON(content);
    } catch {
      return this.parseCSV(content);
    }
  }

  /**
   * Auto-detect and parse any format
   * @param {string} content - File content
   * @param {string} filename - Original filename
   * @returns {array} Parsed words
   */
  parseAuto(content, filename) {
    const ext = path.extname(filename).toLowerCase();

    if (ext === '.csv') {
      return this.parseCSV(content);
    }
    if (ext === '.tsv' || ext === '.txt') {
      return this.parseTSV(content);
    }
    if (ext === '.json') {
      return this.parseJSON(content);
    }
    if (ext === '.apkg') {
      return this.parseAnki(content);
    }

    // Try to auto-detect
    if (content.includes('\t')) {
      return this.parseTSV(content);
    }
    if (content.includes(',')) {
      return this.parseCSV(content);
    }
    if (content.startsWith('{') || content.startsWith('[')) {
      return this.parseJSON(content);
    }

    throw new Error('Unable to determine format');
  }

  /**
   * Export words to CSV
   * @param {array} words - Word objects
   * @returns {string} CSV content
   */
  exportCSV(words) {
    const headers = ['word', 'definition', 'example', 'partOfSpeech', 'difficulty', 'notes'];
    const rows = words.map((w) => [
      this.escapeCSV(w.word),
      this.escapeCSV(w.definition),
      this.escapeCSV(w.example || ''),
      w.partOfSpeech,
      w.difficulty || 3,
      this.escapeCSV(w.notes || ''),
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }

  /**
   * Export words to JSON
   * @param {array} words
   * @returns {string} JSON content
   */
  exportJSON(words) {
    return JSON.stringify(words, null, 2);
  }

  /**
   * Export words to TSV (tab-separated)
   * @param {array} words
   * @returns {string} TSV content
   */
  exportTSV(words) {
    const headers = ['word', 'definition', 'example', 'partOfSpeech', 'difficulty'];
    const rows = words.map((w) => [w.word, w.definition, w.example || '', w.partOfSpeech, w.difficulty || 3]);

    return [headers.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n');
  }

  /**
   * Escape CSV special characters
   * @param {string} str
   * @returns {string}
   */
  escapeCSV(str) {
    if (!str) return '';
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  /**
   * Validate parsed words
   * @param {array} words
   * @returns {object} { valid: array, errors: array }
   */
  validateWords(words) {
    const valid = [];
    const errors = [];

    words.forEach((w, idx) => {
      const err = [];
      if (!w.word || w.word.trim().length === 0) err.push('missing word');
      if (!w.definition || w.definition.trim().length === 0) err.push('missing definition');
      if (w.word && w.word.length > 200) err.push('word too long');
      if (w.definition && w.definition.length > 1000) err.push('definition too long');

      if (err.length > 0) {
        errors.push({ row: idx + 2, errors: err, word: w.word || '(empty)' });
      } else {
        valid.push({
          word: w.word.trim(),
          definition: w.definition.trim(),
          example: (w.example || '').trim(),
          partOfSpeech: w.partOfSpeech || 'other',
          difficulty: Math.max(1, Math.min(5, parseInt(w.difficulty) || 3)),
          notes: (w.notes || '').trim(),
        });
      }
    });

    return { valid, errors };
  }
}

module.exports = new ImportExportService();
