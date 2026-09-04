/**
 * Export Service - Handles CSV and PDF export for cohort analytics
 * Provides formatting and data serialization for analytics snapshots
 */

/**
 * Format cohort analytics data as CSV
 * @param {Object} cohortData - The cohort analytics data from backend
 * @param {Object} creator - Creator information {name, creatorCode}
 * @returns {string} CSV formatted string (RFC 4180 compliant)
 */
function formatAnalyticsAsCSV(cohortData, creator) {
  if (!cohortData || !cohortData.overview) {
    throw new Error('Invalid cohort data for CSV export');
  }

  const rows = [];
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0];

  // Section: Header
  rows.push('CLASS ANALYTICS SNAPSHOT');
  rows.push(`Export Date,"${dateStr} ${timeStr}"`);
  rows.push(`Creator Class,"${creator?.creatorCode || 'N/A'}"`);
  rows.push('Period,"All Time"');
  rows.push('');

  // Section: Overview Metrics
  rows.push('OVERVIEW METRICS');
  rows.push('Metric,Value,Note');
  
  const overview = cohortData.overview;
  rows.push(`Total Students,${overview.totalStudents},`);
  
  const activePercentage = overview.totalStudents > 0 
    ? Math.round((overview.activeStudents / overview.totalStudents) * 100)
    : 0;
  rows.push(`Active Students,${overview.activeStudents},"${activePercentage}% engagement"`);
  
  rows.push(`Average XP,${overview.avgXP},"Per student"`);
  rows.push(`Class Accuracy,${overview.avgAccuracy}%,"Average across sessions"`);
  rows.push(`Avg Sessions per Student,${overview.avgSessions},`);
  rows.push(`Total Sessions,${overview.totalSessionsAll},"Across entire class"`);
  rows.push('');

  // Section: Skill Gaps
  if (cohortData.classSkillGaps && cohortData.classSkillGaps.length > 0) {
    rows.push('CLASS SKILL GAPS');
    rows.push('Exercise Type,Accuracy,Severity,Notes');
    
    cohortData.classSkillGaps.forEach(gap => {
      const notes = gap.severity === 'high' 
        ? 'Requires immediate attention'
        : gap.severity === 'medium'
        ? 'Review recommended'
        : 'Good performance';
      
      rows.push(`"${escapeCSV(gap.type)}",${gap.avgAccuracy}%,"${gap.severity.toUpperCase()}","${notes}"`);
    });
    rows.push('');
  }

  // Section: Top Performers
  if (cohortData.topPerformers && cohortData.topPerformers.length > 0) {
    rows.push('TOP PERFORMERS');
    rows.push('Rank,Student Name,Total XP');
    
    cohortData.topPerformers.forEach((student, idx) => {
      rows.push(`${idx + 1},"${escapeCSV(student.name)}",${student.totalXP || 0}`);
    });
    rows.push('');
  }

  // Section: Struggling Students
  if (cohortData.struggling && cohortData.struggling.length > 0) {
    rows.push('STRUGGLING STUDENTS');
    rows.push('Student Name,Status,Last Activity');
    
    cohortData.struggling.forEach(student => {
      const status = student.sessionsCompleted === 0 
        ? 'No activity'
        : `Low accuracy (${student.avgAccuracy}%)`;
      
      const lastActivity = student.lastActivityTime 
        ? new Date(student.lastActivityTime).toLocaleDateString()
        : 'N/A';
      
      rows.push(`"${escapeCSV(student.name)}","${status}","${lastActivity}"`);
    });
    rows.push('');
  }

  // Section: Vocabulary Metadata
  rows.push('VOCABULARY METADATA');
  rows.push('Metric,Value');
  
  const avgDifficulty = cohortData.vocabularyMetadata?.avgDifficulty;
  const avgDiffValue = typeof avgDifficulty === 'string' 
    ? avgDifficulty 
    : (avgDifficulty || 0).toFixed(1);
  
  rows.push(`Average Word Difficulty,${avgDiffValue}`);
  rows.push(`Words Added This Week,${cohortData.vocabularyMetadata?.wordsThisWeek || 0}`);
  rows.push(`Best Student Streak,${cohortData.vocabularyMetadata?.bestStreak || 0}`);
  rows.push('');

  // Section: Footer
  rows.push('EXPORT INFORMATION');
  rows.push(`Generated,"${new Date().toISOString()}"`);
  rows.push(`VocabMaster Analytics Export,v1.0`);

  return rows.join('\n');
}

/**
 * Escape CSV field values (RFC 4180)
 * @param {string} value - The value to escape
 * @returns {string} Escaped value safe for CSV
 */
function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  
  const str = String(value);
  
  // If contains comma, quote, or newline, wrap in quotes and escape internal quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  
  return str;
}

/**
 * Prepare cohort data for PDF export
 * Organizes data into sections with formatting hints
 * @param {Object} cohortData - The cohort analytics data
 * @param {Object} creator - Creator information
 * @returns {Object} Structured data for PDF rendering
 */
function preparePdfData(cohortData, creator) {
  if (!cohortData || !cohortData.overview) {
    throw new Error('Invalid cohort data for PDF export');
  }

  const now = new Date();
  
  return {
    header: {
      title: 'Class Analytics Report',
      creator: creator?.name || 'VocabMaster Creator',
      classCode: creator?.creatorCode || 'N/A',
      exportDate: now.toLocaleDateString(),
      exportTime: now.toLocaleTimeString(),
    },
    overview: {
      stats: [
        {
          label: 'Total Students',
          value: cohortData.overview.totalStudents,
          subtext: `${Math.round((cohortData.overview.activeStudents / (cohortData.overview.totalStudents || 1)) * 100)}% active`,
        },
        {
          label: 'Active Students',
          value: cohortData.overview.activeStudents,
          subtext: 'Engaged students',
        },
        {
          label: 'Avg XP per Student',
          value: cohortData.overview.avgXP,
          subtext: 'Experience points',
        },
        {
          label: 'Class Accuracy',
          value: `${cohortData.overview.avgAccuracy}%`,
          subtext: 'Average performance',
        },
        {
          label: 'Avg Sessions/Student',
          value: cohortData.overview.avgSessions,
          subtext: 'Learning sessions',
        },
        {
          label: 'Total Sessions',
          value: cohortData.overview.totalSessionsAll,
          subtext: 'Class wide',
        },
      ],
    },
    skillGaps: {
      title: 'Class Skill Gaps',
      data: cohortData.classSkillGaps || [],
      hasSevereGaps: (cohortData.classSkillGaps || []).some(g => g.severity !== 'ok'),
    },
    topPerformers: {
      title: 'Top Performers',
      data: cohortData.topPerformers || [],
      isEmpty: !cohortData.topPerformers || cohortData.topPerformers.length === 0,
    },
    strugglingStudents: {
      title: 'Struggling Students',
      data: cohortData.struggling || [],
      isEmpty: !cohortData.struggling || cohortData.struggling.length === 0,
    },
    metadata: {
      avgDifficulty: typeof cohortData.vocabularyMetadata?.avgDifficulty === 'string'
        ? cohortData.vocabularyMetadata.avgDifficulty
        : (cohortData.vocabularyMetadata?.avgDifficulty || 0).toFixed(1),
      wordsThisWeek: cohortData.vocabularyMetadata?.wordsThisWeek || 0,
      bestStreak: cohortData.vocabularyMetadata?.bestStreak || 0,
    },
  };
}

/**
 * Generate HTML template for PDF export
 * Creates a formatted HTML representation of analytics
 * @param {Object} pdfData - Prepared PDF data from preparePdfData()
 * @returns {string} HTML string ready for PDF conversion
 */
function generatePdfHtml(pdfData) {
  const { header, overview, skillGaps, topPerformers, strugglingStudents, metadata } = pdfData;
  
  const severityColor = (severity) => {
    switch(severity) {
      case 'high': return '#ef4444';
      case 'medium': return '#f59e0b';
      case 'ok': return '#10b981';
      default: return '#6b7280';
    }
  };

  const severityLabel = (severity) => {
    switch(severity) {
      case 'high': return '🔴 HIGH';
      case 'medium': return '🟡 MEDIUM';
      case 'ok': return '🟢 OK';
      default: return severity;
    }
  };

  let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1f2937; line-height: 1.6; }
    .page { width: 210mm; height: 297mm; padding: 20mm; background: white; }
    .header { text-align: center; border-bottom: 3px solid #6c63ff; padding-bottom: 15px; margin-bottom: 20px; }
    .header h1 { color: #6c63ff; font-size: 28px; margin: 10px 0; }
    .header-meta { color: #6b7280; font-size: 11px; margin: 5px 0; }
    .section { margin-bottom: 20px; page-break-inside: avoid; }
    .section-title { color: #1f2937; font-size: 16px; font-weight: bold; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 12px; }
    
    .overview-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 15px; }
    .stat-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; text-align: center; }
    .stat-value { font-size: 24px; font-weight: bold; color: #6c63ff; }
    .stat-label { font-size: 11px; color: #6b7280; text-transform: uppercase; margin: 5px 0; }
    .stat-subtext { font-size: 10px; color: #9ca3af; }
    
    .skills-table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 10px; }
    .skills-table th { background: #f3f4f6; padding: 8px; text-align: left; font-weight: bold; border-bottom: 1px solid #d1d5db; }
    .skills-table td { padding: 8px; border-bottom: 1px solid #e5e7eb; }
    .severity-badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold; }
    
    .performers-list { margin-top: 10px; }
    .performer-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-size: 11px; }
    .performer-rank { font-weight: bold; color: #6c63ff; margin-right: 10px; min-width: 20px; }
    .performer-name { flex: 1; }
    .performer-xp { color: #6b7280; font-weight: bold; }
    
    .struggling-list { margin-top: 10px; }
    .student-item { padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-size: 11px; }
    .student-name { font-weight: bold; color: #1f2937; }
    .student-status { color: #ef4444; font-size: 10px; margin-top: 2px; }
    
    .empty-state { color: #9ca3af; font-style: italic; text-align: center; padding: 20px 10px; }
    
    .metadata-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .metadata-item { background: #f9fafb; padding: 10px; border-radius: 4px; text-align: center; }
    .metadata-value { font-size: 18px; font-weight: bold; color: #6c63ff; }
    .metadata-label { font-size: 10px; color: #6b7280; text-transform: uppercase; margin-top: 3px; }
    
    .footer { margin-top: 20px; padding-top: 10px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 9px; color: #9ca3af; }
    
    @media print {
      body { margin: 0; padding: 0; }
      .page { width: auto; height: auto; padding: 20px; margin: 0; }
    }
  </style>
</head>
<body>
  <div class="page">
    <!-- Header -->
    <div class="header">
      <div style="font-weight: bold; font-size: 18px; color: #6c63ff;">VocabMaster</div>
      <h1>${header.title}</h1>
      <div class="header-meta">
        <div><strong>${header.creator}</strong> (Class: ${header.classCode})</div>
        <div>${header.exportDate} at ${header.exportTime}</div>
      </div>
    </div>

    <!-- Overview Stats -->
    <div class="section">
      <div class="section-title">Class Overview</div>
      <div class="overview-grid">
        ${overview.stats.map(stat => `
        <div class="stat-card">
          <div class="stat-value">${stat.value}</div>
          <div class="stat-label">${stat.label}</div>
          <div class="stat-subtext">${stat.subtext}</div>
        </div>
        `).join('')}
      </div>
    </div>

    <!-- Skill Gaps -->
    ${skillGaps.data.length > 0 ? `
    <div class="section">
      <div class="section-title">${skillGaps.title}</div>
      <table class="skills-table">
        <thead>
          <tr>
            <th>Exercise Type</th>
            <th>Accuracy</th>
            <th>Severity</th>
          </tr>
        </thead>
        <tbody>
          ${skillGaps.data.map(gap => `
          <tr>
            <td>${gap.type}</td>
            <td><strong>${gap.avgAccuracy}%</strong></td>
            <td><span class="severity-badge" style="background: ${severityColor(gap.severity)}; color: white;">${severityLabel(gap.severity)}</span></td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}

    <!-- Top Performers and Struggling Students (side by side) -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
      <!-- Top Performers -->
      ${topPerformers.data.length > 0 ? `
      <div class="section">
        <div class="section-title">${topPerformers.title}</div>
        <div class="performers-list">
          ${topPerformers.data.map((student, idx) => `
          <div class="performer-item">
            <span class="performer-rank">#${idx + 1}</span>
            <span class="performer-name">${student.name}</span>
            <span class="performer-xp">${student.totalXP} XP</span>
          </div>
          `).join('')}
        </div>
      </div>
      ` : `
      <div class="section">
        <div class="section-title">${topPerformers.title}</div>
        <div class="empty-state">No data available</div>
      </div>
      `}

      <!-- Struggling Students -->
      ${strugglingStudents.data.length > 0 ? `
      <div class="section">
        <div class="section-title">${strugglingStudents.title}</div>
        <div class="struggling-list">
          ${strugglingStudents.data.map(student => `
          <div class="student-item">
            <div class="student-name">${student.name}</div>
            <div class="student-status">${student.sessionsCompleted === 0 ? '⚠️ No activity' : '⚠️ Low accuracy: ' + student.avgAccuracy + '%'}</div>
          </div>
          `).join('')}
        </div>
      </div>
      ` : `
      <div class="section">
        <div class="section-title">${strugglingStudents.title}</div>
        <div class="empty-state">All students performing well</div>
      </div>
      `}
    </div>

    <!-- Vocabulary Metadata -->
    <div class="section" style="margin-top: 20px;">
      <div class="section-title">Vocabulary Metadata</div>
      <div class="metadata-grid">
        <div class="metadata-item">
          <div class="metadata-value">${metadata.avgDifficulty}</div>
          <div class="metadata-label">Avg Difficulty</div>
        </div>
        <div class="metadata-item">
          <div class="metadata-value">${metadata.wordsThisWeek}</div>
          <div class="metadata-label">Words This Week</div>
        </div>
        <div class="metadata-item">
          <div class="metadata-value">${metadata.bestStreak}</div>
          <div class="metadata-label">Best Streak</div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <p>Generated by VocabMaster Analytics Export | ${new Date().toISOString()}</p>
      <p>This report contains confidential class performance data. Handle with care.</p>
    </div>
  </div>
</body>
</html>
  `;

  return html;
}

// Export functions for use in backend and frontend
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatAnalyticsAsCSV,
    preparePdfData,
    generatePdfHtml,
    escapeCSV,
  };
}
