/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/collector/storage/` mentions the
 * token `<private>`. The privacy-scrub boundary contract (design.md §
 * Handoff contract; requirements.md § Requirement 10) says that scrubbing
 * of `<private>…</private>` spans is the collector-pipeline's responsibility,
 * not storage's. A reference to `<private>` inside the storage tree would
 * indicate drift — someone trying to push scrubbing into the wrong layer.
 *
 * The check is a simple recursive read of every `.ts` file under the
 * storage tree. It intentionally does not delegate to eslint or a regex
 * rule: keeping it here, as a test, puts the guard on the same CI surface
 * as everything else and makes the failure mode ("storage references
 * <private>") legible without knowing the repo's lint config.
 *
 * Validates: Requirement 10.3
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Storage tree root, resolved relative to this test file. */
const STORAGE_ROOT = fileURLToPath(
  new URL('../src/collector/storage', import.meta.url),
);

/** Recursively collect every `.ts` file under `dir`. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (stat.isFile() && entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip TypeScript comments from `source` so the scan only sees executable
 * code. The requirement (10.3) forbids scrubbing *logic* in the storage
 * layer, not documentation that explains the contract. The TSDoc in
 * `src/collector/storage/index.ts` deliberately mentions
 * `<private>…</private>` when describing the pipeline's scrub boundary,
 * and that prose is exactly what we want to allow.
 *
 * The stripper handles the two comment forms TypeScript uses:
 *   - block comments `/* … *\/` (any length, including TSDoc `/** … *\/`);
 *   - line comments `// …` to end of line.
 *
 * It is intentionally regex-level — a full TS parser would be overkill for
 * a lint-style guard and would add a dependency. False negatives (a
 * `<private>` inside a string that contains `//`) are irrelevant: the
 * requirement is about keeping scrub logic out of the storage tree, and
 * no such code exists for this to mis-fire on.
 */
function stripComments(source: string): string {
  // Block comments first, to avoid `//` inside `/* ... // ... */` being
  // treated as the start of a line comment.
  let withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  withoutBlocks = withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return withoutBlocks;
}

describe('storage layer — privacy-scrub boundary', () => {
  it('does not reference "<private>" in executable code under src/collector/storage', () => {
    /**
     * **Validates: Requirement 10.3**
     *
     * Storage is the sink, not the scrubber. Privacy-scrub logic for
     * `<private>…</private>` spans lives in the collector-pipeline.
     * Any reference to the `<private>` token inside executable storage
     * code (string literals, regex patterns, identifiers) indicates
     * drift — someone is pushing scrubbing into the wrong layer. TSDoc
     * and line comments that *describe* the contract are explicitly
     * allowed; the stripper removes them before the scan.
     */
    const files = collectTsFiles(STORAGE_ROOT);

    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the storage tree) would otherwise
    // produce a silently-passing vacuous test.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes('<private>')) {
          offenders.push({
            file,
            line: i + 1,
            text: lines[i]!.trim(),
          });
        }
      }
    }

    expect(
      offenders,
      `found <private> references in executable storage code: ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });
});
