// Pure counts for the Home session card's pending indicator.

/** Pending items as counts: choice cards and plain questions are questions, permission requests are approvals. */
export function pendingCounts(pending) {
  const counts = { approvals: 0, questions: 0 };
  for (const item of pending || []) {
    if (item.kind === "Approval" && !item.approval?.questions) counts.approvals += 1;
    else counts.questions += 1;
  }
  return counts;
}

/** "2 questions", "1 approval", or "1 approval · 1 question"; "" when nothing is pending. */
export function pendingLabel(pending) {
  const { approvals, questions } = pendingCounts(pending);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [approvals && plural(approvals, "approval"), questions && plural(questions, "question")].filter(Boolean).join(" · ");
}
