(function (root) {
  function buildChartDataFromHistory(historyRows, metric) {
    const rows = Array.isArray(historyRows) ? historyRows : [];
    const metricKey = metric === 'accuracy' ? 'avgAccuracy' : 'xpEarned';

    return rows.map((row, index) => {
      const dateKey = String(row?.dateKey || row?.key || '');
      const label = typeof row?.label === 'string' && row.label
        ? row.label
        : (dateKey ? dateKey.slice(5) : `Day ${index + 1}`);
      const value = metric === 'accuracy'
        ? Number(row?.avgAccuracy ?? row?.accuracy ?? row?.value ?? 0)
        : Number(row?.xpEarned ?? row?.value ?? 0);

      return {
        dateKey,
        label,
        value,
        [metricKey]: value,
      };
    });
  }

  const api = { buildChartDataFromHistory };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.analyticsUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
