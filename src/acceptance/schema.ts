import { z } from "zod";
import { question, storedQuestions, toAgentJsonSchema } from "../agents/questions.js";

const generatedFile = z.strictObject({
  path: z.string().min(1),
  content: z.string().min(1),
});
export type GeneratedTestFile = z.infer<typeof generatedFile>;

/** What the test-author agent must return. Ordito writes the files itself (ADR 0011). */
export const testAuthorOutput = z.strictObject({
  files: z.array(generatedFile).min(1),
  questions: z.array(question),
});
export type TestAuthorOutput = z.infer<typeof testAuthorOutput>;

export const testAuthorOutputJsonSchema = toAgentJsonSchema(testAuthorOutput);

/** `.ordito/tests.json`: the state of the acceptance-test gate. */
export const testsFile = z.strictObject({
  ordito: z.literal("0.1"),
  spec: z.string(),
  specDigest: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["draft", "approved"]),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
  files: z.array(z.string()),
  questions: storedQuestions,
});
export type TestsFile = z.output<typeof testsFile>;

export const TESTS_PATH = ".ordito/tests.json";

/** `.ordito/lock.json`, read by `.ordito/guard.mjs`; format fixed in ADR 0007. */
export const lockFile = z.strictObject({
  ordito: z.literal("0.1"),
  lockedAt: z.string(),
  base: z.string().nullable(),
  dirs: z.array(z.string()),
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type LockFile = z.infer<typeof lockFile>;
