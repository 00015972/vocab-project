/**
 * FSRS (Free Spaced Repetition System) v4 Algorithm
 * Simplified implementation for VocabMaster
 * Based on https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler
 */

class FSRSScheduler {
  constructor() {
    // FSRS constants (tuned for English vocabulary)
    this.INIT_STABILITY = [0.8, 2.0]; // Min/max initial stability
    this.INIT_DIFFICULTY = 5.83; // Initial difficulty
    this.MEAN_REVERSION = 0.31; // How much difficulty reverts to mean
    this.DIFFICULTY_WEIGHT = 6.2;
    this.DIFFICULTY_MULT = 1 - this.DIFFICULTY_WEIGHT * 0.02; // Changes based on responses
    this.STABILITY_WEIGHT = [1.26, 1.73, 1.96, 2.23]; // How stability changes
    this.RETRIEVE_ABILITY = 0.9; // How well users typically retrieve
    this.FORGETTING_CURVE_BASE = 0.5; // Exponential decay
  }

  /**
   * Calculate next review interval (in days)
   * @param {number} stability - Current card stability
   * @param {number} difficulty - Current card difficulty (0-10)
   * @param {string} grade - User response: 'again' (1), 'hard' (2), 'good' (3), 'easy' (4)
   * @returns {object} { nextInterval, newStability, newDifficulty, state }
   */
  calculateNextInterval(stability, difficulty, grade, state = 'new') {
    const gradeValue = parseInt(grade);
    
    // New card handling
    if (state === 'new') {
      if (gradeValue === 1) return { nextInterval: 1, newStability: 0.5, newDifficulty: Math.min(difficulty + 1, 10), state: 'learning' };
      if (gradeValue === 2) return { nextInterval: 1, newStability: 1.0, newDifficulty: Math.max(difficulty + 0.5, 0), state: 'learning' };
      if (gradeValue === 3) return { nextInterval: 3, newStability: 3.0, newDifficulty: difficulty, state: 'review' };
      if (gradeValue === 4) return { nextInterval: 5, newStability: 5.0, newDifficulty: Math.max(difficulty - 0.5, 0), state: 'review' };
    }

    // Learning state
    if (state === 'learning') {
      if (gradeValue <= 2) return { nextInterval: 1, newStability: Math.max(stability * 0.3, 0.5), newDifficulty: Math.min(difficulty + 0.5, 10), state: 'learning' };
      if (gradeValue === 3) return { nextInterval: 3, newStability: stability * 1.5, newDifficulty: difficulty, state: 'review' };
      if (gradeValue === 4) return { nextInterval: 7, newStability: stability * 2.0, newDifficulty: Math.max(difficulty - 1, 0), state: 'review' };
    }

    // Review state
    if (state === 'review' || state === 'relearning') {
      const retentionFactor = 1 - Math.pow(this.FORGETTING_CURVE_BASE, stability / 36); // Predict retention
      
      if (gradeValue === 1) {
        // Failed - restart learning
        return {
          nextInterval: 1,
          newStability: Math.max(stability * 0.2, 0.5),
          newDifficulty: Math.min(difficulty + 1, 10),
          state: 'relearning',
        };
      }
      
      if (gradeValue === 2) {
        // Hard - increase interval less
        const interval = stability * 1.5;
        return {
          nextInterval: Math.ceil(interval),
          newStability: stability * 0.7,
          newDifficulty: Math.min(difficulty + 0.5, 10),
          state: 'review',
        };
      }
      
      if (gradeValue === 3) {
        // Good - standard increase
        const interval = stability * 2.5;
        return {
          nextInterval: Math.ceil(interval),
          newStability: stability * 1.1,
          newDifficulty: difficulty,
          state: 'review',
        };
      }
      
      if (gradeValue === 4) {
        // Easy - increase more aggressively
        const interval = stability * 4.0;
        return {
          nextInterval: Math.ceil(interval),
          newStability: stability * 1.3,
          newDifficulty: Math.max(difficulty - 0.5, 0),
          state: 'review',
        };
      }
    }

    // Fallback
    return { nextInterval: 1, newStability: stability, newDifficulty: difficulty, state };
  }

  /**
   * Get cards due for review
   * @param {array} cardStates - Array of card state documents
   * @returns {array} Cards where nextReview <= now
   */
  getCardsDue(cardStates) {
    const now = new Date();
    return cardStates.filter((card) => new Date(card.nextReview) <= now);
  }

  /**
   * Calculate retention rate (0-100%)
   * @param {array} cardStates - Array of card states
   * @returns {number} Percentage of cards well-retained
   */
  calculateRetention(cardStates) {
    if (cardStates.length === 0) return 0;
    const wellRetained = cardStates.filter((c) => c.state === 'review' && c.stability > 10).length;
    return Math.round((wellRetained / cardStates.length) * 100);
  }
}

module.exports = new FSRSScheduler();
