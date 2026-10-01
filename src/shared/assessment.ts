export type ContextualAssessment = { qualityScore: number; reason: string };

export function isContextualAssessment(value: unknown): value is ContextualAssessment {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.qualityScore === "number" &&
    Number.isInteger(candidate.qualityScore) &&
    candidate.qualityScore >= 0 &&
    candidate.qualityScore <= 100 &&
    typeof candidate.reason === "string" &&
    candidate.reason.trim().length > 0 &&
    candidate.reason.length <= 500
  );
}

export const unavailableAssessment: ContextualAssessment = {
  qualityScore: 50,
  reason: "Контекстная оценка недоступна; баланс оставлен без изменений.",
};
