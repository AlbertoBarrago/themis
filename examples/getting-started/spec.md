---
themis: 0.1
stack: node-ts
verify: [typecheck, lint, unit, acceptance]
limits: { max_iterations: 3, parallel: 2 }
models: { planner: strong, worker: fast, reviewer: strong }
---

# Slug library

A tiny library that turns titles into URL slugs. Small on purpose: it exercises every step of
Themis (plan, locked tests, parallel tasks, review, merge) in a few minutes.

## Decisions

- `src/slug.ts` exports `slugify(input: string, options?: SlugOptions): string` and the type
  `SlugOptions = { separator?: string }`. The default separator is `-`.
- No runtime dependencies. Unicode handling uses `String.prototype.normalize`.
- `slugify` is pure: it never throws for any string input, and an input with no letters or
  digits returns the empty string.

## AC-1 Lowercases and joins words
Depends: none
- Given the input "Hello World"
- When slugify is called without options
- Then it returns "hello-world"
- And runs of spaces, tabs and newlines between words produce a single separator
- And leading and trailing whitespace produce no separator

## AC-2 Uses a custom separator
Depends: AC-1
- Given the input "Hello World" and the option separator "_"
- When slugify is called
- Then it returns "hello_world"

## AC-3 Removes accents and punctuation
Depends: AC-1
- Given the input "Café, déjà vu!"
- When slugify is called without options
- Then it returns "cafe-deja-vu"
- And an input made only of punctuation, such as "?!", returns ""
