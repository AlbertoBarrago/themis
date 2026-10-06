import type { Spec } from "../spec/types.js";
import { ACCEPTANCE_DIR, FORBIDDEN_MARKERS } from "../stack/node-ts/contract.js";
import type { GeneratedTestFile } from "./schema.js";

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const MAX_FILE_BYTES = 256 * 1024;
const AC_DESCRIBE = /\bdescribe\s*\(\s*(["'`])AC-([1-9]\d*):/g;
/** `describe("AC-1 title"` or `describe("AC-01: ...` : close to the convention but wrong. */
const AC_DESCRIBE_MALFORMED = /\bdescribe\s*\(\s*(["'`])AC-(?![1-9]\d*:)/g;

/**
 * Checks acceptance test files against the spec before they reach the human gate, and again
 * at approval (the human may have edited them). Returns every problem found.
 */
export function validateTestFiles(spec: Spec, files: readonly GeneratedTestFile[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const covered = new Map<string, string[]>();

  for (const file of files) {
    const { path, content } = file;
    if (!isSafeAcceptancePath(path)) {
      errors.push(
        `${path}: must be a relative path under ${ACCEPTANCE_DIR}/ using only letters, digits, ".", "_", "-" and "/"`,
      );
      continue;
    }
    if (seen.has(path)) {
      errors.push(`${path}: listed more than once`);
      continue;
    }
    seen.add(path);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
      errors.push(`${path}: larger than ${MAX_FILE_BYTES} bytes`);
    }
    if (!/\.(?:[cm]?ts|json)$/.test(path)) {
      errors.push(`${path}: only TypeScript (and JSON fixtures) are allowed`);
    }

    content.split("\n").forEach((line, i) => {
      for (const [name, pattern] of FORBIDDEN_MARKERS) {
        if (pattern.test(line)) errors.push(`${path}:${i + 1}: forbidden marker "${name}"`);
      }
    });
    for (const match of content.matchAll(AC_DESCRIBE_MALFORMED)) {
      const line = content.slice(0, match.index).split("\n").length;
      errors.push(`${path}:${line}: criterion describe blocks must be named "AC-<n>: <title>"`);
    }
    for (const match of content.matchAll(AC_DESCRIBE)) {
      const id = `AC-${match[2]}`;
      covered.set(id, [...(covered.get(id) ?? []), path]);
    }
  }

  const ids = new Set(spec.criteria.map((c) => c.id as string));
  for (const id of covered.keys()) {
    if (!ids.has(id)) errors.push(`${id}: tests describe a criterion that is not in the spec`);
  }
  for (const id of ids) {
    if (!covered.has(id))
      errors.push(`${id}: no describe("${id}: ...") block; every criterion needs tests`);
  }
  if (![...seen].some((p) => p.endsWith(".test.ts"))) {
    errors.push(`no *.test.ts file under ${ACCEPTANCE_DIR}/`);
  }
  return errors;
}

/** Map from criterion id to the files that test it, in spec order. */
export function coverage(
  spec: Spec,
  files: readonly GeneratedTestFile[],
): Array<[string, string[]]> {
  return spec.criteria.map((c) => [
    c.id,
    files
      .filter((f) => [...f.content.matchAll(AC_DESCRIBE)].some((m) => `AC-${m[2]}` === c.id))
      .map((f) => f.path),
  ]);
}

export function isSafeAcceptancePath(path: string): boolean {
  if (!path.startsWith(`${ACCEPTANCE_DIR}/`) || !SAFE_PATH.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
