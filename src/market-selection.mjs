const BINARY_OUTCOMES = Object.freeze(["YES", "NO"]);

export function selectAvailableOutcome(outcomes, currentOutcome = undefined) {
  const available = BINARY_OUTCOMES.filter((outcome) => outcomes?.[outcome]?.available === true);
  const current = String(currentOutcome || "").trim().toUpperCase();
  if (available.includes(current)) return current;
  return available[0] || null;
}
