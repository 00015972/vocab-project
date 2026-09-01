// Test export service directly
try {
  console.log('Loading export service...');
  const { formatAnalyticsAsCSV, preparePdfData, generatePdfHtml } = require('./src/services/exportService.js');
  console.log('✓ Export service loaded successfully');
  
  // Test with minimal data
  const testData = {
    overview: {
      totalStudents: 1,
      activeStudents: 1,
      avgXP: 250,
      avgAccuracy: 87,
      avgSessions: 3,
      totalSessionsAll: 3,
    },
    students: [],
    classSkillGaps: [],
    topPerformers: [],
    struggling: [],
    vocabularyMetadata: {
      avgDifficulty: 5.0,
      wordsThisWeek: 12,
      bestStreak: 4,
    }
  };

  console.log('\nTesting formatAnalyticsAsCSV...');
  const csv = formatAnalyticsAsCSV(testData, { name: 'Demo Creator', creatorCode: 'DEMO01' });
  console.log('✓ CSV generated successfully');
  console.log(`  CSV length: ${csv.length} bytes`);
  console.log(`  First 200 chars: ${csv.substring(0, 200)}`);

  console.log('\nTesting preparePdfData...');
  const pdfData = preparePdfData(testData, { name: 'Demo Creator', creatorCode: 'DEMO01' });
  console.log('✓ PDF data prepared successfully');
  
  console.log('\nTesting generatePdfHtml...');
  const html = generatePdfHtml(pdfData);
  console.log('✓ PDF HTML generated successfully');
  console.log(`  HTML length: ${html.length} bytes`);
  console.log(`  Contains "Class Analytics Report": ${html.includes('Class Analytics Report')}`);

  console.log('\n✓ ALL EXPORT SERVICE TESTS PASSED');
} catch (err) {
  console.error('✗ ERROR:', err.message);
  console.error('Stack:', err.stack);
  process.exit(1);
}
