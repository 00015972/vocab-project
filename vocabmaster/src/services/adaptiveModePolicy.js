function resolveSafeMode(plan, requestedMode, fallbackMode = 'flashcards') {
  const normalizedRequested = String(requestedMode || '').toLowerCase();
  const normalizedFallback = String(fallbackMode || 'flashcards').toLowerCase();
  if (normalizedRequested && plan?.masteryGates?.[normalizedRequested]?.unlocked !== false) {
    return normalizedRequested;
  }

  const unlockedModes = Array.isArray(plan?.unlockedModes)
    ? plan.unlockedModes
        .map((value) => String(value || '').toLowerCase())
        .filter(Boolean)
    : [];

  const fallbackCandidates = [normalizedFallback, ...unlockedModes].filter(Boolean);
  const preferredFallback = fallbackCandidates.find((value) => value && value !== normalizedRequested && (plan?.masteryGates?.[value]?.unlocked !== false));
  if (preferredFallback) {
    return preferredFallback;
  }

  if (unlockedModes.length) {
    return unlockedModes.find((value) => value !== normalizedRequested) || unlockedModes[0];
  }

  return normalizedFallback;
}

function buildModeAccess(plan, requestedMode, fallbackMode = 'flashcards') {
  const normalizedRequested = String(requestedMode || '').toLowerCase();
  if (!normalizedRequested) return null;

  const gate = plan?.masteryGates?.[normalizedRequested];
  if (!gate) return null;
  if (gate.unlocked !== false) return null;

  const safeMode = resolveSafeMode(plan, normalizedRequested, fallbackMode);
  return {
    requestedMode: normalizedRequested,
    fallbackMode: safeMode,
    safeMode,
    reason: gate.reason || 'This mode is locked.',
  };
}

module.exports = {
  resolveSafeMode,
  buildModeAccess,
};
