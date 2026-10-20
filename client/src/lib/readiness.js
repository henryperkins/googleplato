// Readiness is a 0–10 score from the authoring agents. The bar uses the
// semantic OKLCH tokens instead of a generated hue so it stays inside the
// admin palette: not ready, ready enough to save, ready to publish.
export function readinessFill(readiness) {
  const score = Number(readiness) || 0;
  if (score >= 8) return 'var(--success-foreground)';
  if (score >= 3) return 'var(--warning-foreground)';
  return 'var(--danger-foreground)';
}
