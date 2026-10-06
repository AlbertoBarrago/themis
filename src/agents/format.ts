import type { Question } from "./questions.js";

/** Questions grouped by severity, as printed at every gate. Empty string when there are none. */
export function formatQuestions(questions: readonly Question[]): string {
  const lines: string[] = [];
  const blocking = questions.filter((q) => q.severity === "blocking");
  const minor = questions.filter((q) => q.severity === "minor");
  if (blocking.length > 0) {
    lines.push("", "Blocking questions (fix the spec and redo this step):");
    for (const q of blocking) lines.push(`  ! ${q.text}`);
  }
  if (minor.length > 0) {
    lines.push("", "Minor questions (left to the workers, who decide and record the choice):");
    for (const q of minor) lines.push(`  ? ${q.text}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
