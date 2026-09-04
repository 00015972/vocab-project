function evaluateGoalAlertState(goal, actual) {
  if (!goal || typeof goal !== 'object') {
    return { status: 'not_started', percent: 0, severity: 'info' };
  }

  const target = Number(goal.target || 0);
  const safeActual = Number(actual || 0);

  if (!Number.isFinite(target) || target <= 0) {
    return { status: 'not_started', percent: 0, severity: 'info' };
  }

  const percent = Math.min(Math.max((safeActual / target) * 100, 0), 1000);

  let status = 'behind';
  let severity = 'critical';

  if (percent >= 100) {
    status = 'achieved';
    severity = 'success';
  } else if (percent >= 75) {
    status = 'on_track';
    severity = 'info';
  } else if (percent >= 40) {
    status = 'at_risk';
    severity = 'warning';
  }

  return { status, percent: Number(percent.toFixed(1)), severity };
}

function buildGoalAlertPayload(goal, actual) {
  const state = evaluateGoalAlertState(goal, actual);
  const target = Number(goal?.target || 0);
  const safeActual = Number(actual || 0);

  return {
    id: goal?._id || `goal-${Date.now()}`,
    label: goal?.label || 'Untitled goal',
    metric: goal?.metric || 'accuracy',
    target,
    actual: safeActual,
    percent: state.percent,
    status: state.status,
    severity: state.severity,
    timeframe: goal?.timeframe || 'allTime',
  };
}

function buildGoalAlertMessages(goalAlert) {
  if (!goalAlert) return [];

  const messages = [];
  if (goalAlert.status === 'achieved') {
    messages.push({ type: 'achieved', text: `Goal achieved: ${goalAlert.label}` });
  } else if (goalAlert.status === 'at_risk') {
    messages.push({ type: 'at_risk', text: `At risk: ${goalAlert.label}` });
  } else if (goalAlert.status === 'behind') {
    messages.push({ type: 'behind', text: `Behind target: ${goalAlert.label}` });
  }

  return messages;
}

module.exports = {
  evaluateGoalAlertState,
  buildGoalAlertPayload,
  buildGoalAlertMessages,
};
