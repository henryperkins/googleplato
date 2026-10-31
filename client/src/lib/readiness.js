// Readiness is a 0–10 score from the authoring agents. The bar uses the
// semantic OKLCH tokens instead of a generated hue so it stays inside the
// admin palette: early definition, developing, and well specified. The score
// estimates the authoring conversation; preview validation governs saving.
export function readinessFill(readiness) {
  const score = Number(readiness) || 0;
  if (score >= 8) return 'var(--success-foreground)';
  if (score >= 3) return 'var(--warning-foreground)';
  return 'var(--danger-foreground)';
}
