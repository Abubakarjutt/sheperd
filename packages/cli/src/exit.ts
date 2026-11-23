/** 0 only for a verified run; 2 for any escalation; 1 for anything unrecognised (never 0). */
export function exitCodeFor(outcome: { status: string }): number {
  if (outcome.status === "verified") return 0;
  if (outcome.status === "escalated") return 2;
  return 1;
}
