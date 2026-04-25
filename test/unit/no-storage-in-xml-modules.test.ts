/**
 * Lint-style guard test.
 *
 * Asserts that the three new XML extraction pipeline modules respect
 * their import boundaries as defined in the design document
 * (§ Modularity Boundary):
 *
 * | Module                                      | May import from                                     | Must NOT import from        |
 * |---------------------------------------------|-----------------------------------------------------|-----------------------------|
 * | `src/collector/pipeline/acp-client.ts`      | `node:child_process`, `node:stream`, ACP SDK        | `src/collector/storage/`    |
 * | `src/collector/pipeline/xml-framer.ts`      | `src/types/`                                        | `src/collector/storage/`    |
 * | `src/collector/pipeline/xml-parser.ts`      | `src/types/`                                        | `src/collector/storage/`    |
 *
 * The ACP client bridges `kiro-cli acp` to the pipeline via the official
 * `@agentclientprotocol/sdk`; it has no business importing storage
 * internals. The XML framer and parser are pure transformation modules
 * that depend only on `src/types/`.
 *
 * Validates: Requirements 9.1, 9.2, 9.3
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Strip TypeScript comments from `source` so the scan only sees executable
 * code. TSDoc and line comments that *describe* the modularity boundary
 * are explicitly allowed; only executable import statements are violations.
 *
 * The stripper handles the two comment forms TypeScript uses:
 *   - block comments `/* … *\/` (any length, including TSDoc `/** … *\/`);
 *   - line comments `// …` to end of line.
 */
function stripComments(source: string): string {
  let withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  withoutBlocks = withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return withoutBlocks;
}

/**
 * Regex that matches the start of any TypeScript module specifier line:
 *
 *   - `import ...`                   (named/default/namespace/side-effect/dynamic)
 *   - `export ...`                   (including `export ... from ...`)
 *
 * A positive match just means "this line begins an import/export
 * statement"; it does not assert the statement is complete. Multi-line
 * imports are handled by {@link findOffenders} which keeps accumulating
 * lines after a start-match until the statement terminates.
 */
const IMPORT_START_RE = /^\s*(?:import|export)\b/;

/**
 * Regex that matches a complete single-line module-specifier statement.
 * Used as a fast path — if a single physical line is already a complete
 * import/export-from or side-effect import, we don't need to accumulate
 * further lines.
 *
 * Covers:
 *   - `import ... from '<path>'`     (named/default/namespace/type-only)
 *   - `import '<path>'`              (side-effect)
 *   - `import('<path>')`             (dynamic)
 *   - `export ... from '<path>'`     (re-exports)
 */
const IMPORT_LIKE_RE =
  /^\s*(?:import\s+(?:[^;'"]*\bfrom\s+)?|import\s*\(\s*|export\b[^;]*\bfrom\s+)['"]/;

/**
 * A module-specifier statement terminates on the first line that
 * contains an opening quote for the path. Once we see the quote, we
 * know the `from '...'` (or side-effect / dynamic) specifier is on
 * this line and the statement ends here. Accumulating any further
 * lines would over-capture the next statement.
 *
 * This heuristic is intentionally loose: we do not try to handle a
 * path that spans multiple lines (illegal in TypeScript) or a
 * template-literal specifier (not valid for static imports anyway).
 */
const SPECIFIER_TERMINATOR_RE = /['"]/;

/**
 * Scan a single file for import/export statements matching a forbidden
 * import pattern. Returns an array of offending statements (empty if
 * clean).
 *
 * A statement is an offender only when BOTH conditions hold:
 *   1. It is an `import` or `export` statement (single- or multi-line).
 *   2. Its full text matches the forbidden `pattern` (e.g. /storage\//).
 *
 * Multi-line imports are handled by accumulating lines starting with
 * `import` / `export` until the module specifier's closing quote is
 * reached, then matching the combined string. This catches regressions
 * like:
 *
 *     import {
 *       openSqliteStorage,
 *     } from '../storage/sqlite/index.js';
 *
 * that a per-line check would let through because no single line
 * contains both `import` AND `storage/`.
 *
 * The dual check (start-of-statement + pattern) also avoids false
 * positives when the forbidden substring appears inside a comment, a
 * variable name, a diagnostic message, or an inline regex literal in
 * unrelated code.
 */
function findOffenders(
  filePath: string,
  pattern: RegExp,
): Array<{ file: string; line: number; text: string }> {
  const stripped = stripComments(readFileSync(filePath, 'utf8'));
  const lines = stripped.split('\n');
  const offenders: Array<{ file: string; line: number; text: string }> = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Fast path: a complete single-line import/export whose specifier
    // is on the same line. We can match directly without accumulating.
    if (IMPORT_LIKE_RE.test(line)) {
      if (pattern.test(line)) {
        offenders.push({ file: filePath, line: i + 1, text: line.trim() });
      }
      i += 1;
      continue;
    }

    // Slow path: the line *starts* an import/export statement but the
    // module specifier is on a later line. Accumulate lines until we
    // encounter the opening quote of the specifier (which, for a
    // well-formed statement, is the single-line form's terminator too).
    if (IMPORT_START_RE.test(line)) {
      const startLine = i + 1;
      const buf: string[] = [line];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j]!;
        buf.push(next);
        if (SPECIFIER_TERMINATOR_RE.test(next)) {
          break;
        }
        j += 1;
      }
      const combined = buf.join(' ');
      if (pattern.test(combined)) {
        offenders.push({
          file: filePath,
          line: startLine,
          text: combined.trim(),
        });
      }
      i = j + 1;
      continue;
    }

    i += 1;
  }

  return offenders;
}

describe('XML pipeline modules — import boundary guards', () => {
  const ACP_CLIENT = fileURLToPath(
    new URL('../../src/collector/pipeline/acp-client.ts', import.meta.url),
  );
  const XML_FRAMER = fileURLToPath(
    new URL('../../src/collector/pipeline/xml-framer.ts', import.meta.url),
  );
  const XML_PARSER = fileURLToPath(
    new URL('../../src/collector/pipeline/xml-parser.ts', import.meta.url),
  );

  it('acp-client.ts does not import from storage/', () => {
    /**
     * **Validates: Requirement 9.1**
     *
     * The ACP client imports only from `node:child_process`, `node:stream`,
     * and `@agentclientprotocol/sdk`. A direct import from `storage/`
     * (any path under it) would couple the transport layer to storage
     * internals.
     */
    const offenders = findOffenders(ACP_CLIENT, /storage\//);

    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from storage/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('xml-framer.ts does not import from storage/', () => {
    /**
     * **Validates: Requirement 9.2**
     *
     * The XML framer imports only from `src/types/`. A direct import
     * from `storage/` (any path under it) would couple the framing
     * logic to persistence internals.
     */
    const offenders = findOffenders(XML_FRAMER, /storage\//);

    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from storage/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('xml-parser.ts does not import from storage/', () => {
    /**
     * **Validates: Requirement 9.3**
     *
     * The XML parser imports only from `src/types/`. A direct import
     * from `storage/` (any path under it) would couple the parsing
     * logic to persistence internals.
     */
    const offenders = findOffenders(XML_PARSER, /storage\//);

    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from storage/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});

/**
 * Self-test for the `IMPORT_LIKE_RE` guard. Documents which forms the
 * regex is expected to catch and which it should let through. If the
 * regex is loosened (false positives on prose lines) or tightened
 * (misses side-effect or dynamic imports), one of these cases fails.
 */
describe('IMPORT_LIKE_RE — recognised vs ignored lines', () => {
  const tmpRoot = fileURLToPath(new URL('./', import.meta.url));

  function matches(line: string): boolean {
    // Write the line to a scratch file, run the offenders scan against
    // a "storage/" pattern, and see whether the line was flagged. A
    // line that is recognised as import-like AND contains `storage/`
    // produces exactly one offender; an ignored line produces zero.
    const scratch = `${tmpRoot}__boundary-regex-scratch.ts`;
    writeFileSync(scratch, line + '\n', 'utf8');
    try {
      const offenders = findOffenders(scratch, /storage\//);
      return offenders.length > 0;
    } finally {
      unlinkSync(scratch);
    }
  }

  it.each([
    ["import '../../src/collector/storage/foo.js';", true],
    ["import foo from '../../src/collector/storage/foo.js';", true],
    ["import { foo } from '../../src/collector/storage/foo.js';", true],
    ["import * as S from '../../src/collector/storage/foo.js';", true],
    ["import type { X } from '../../src/collector/storage/foo.js';", true],
    ["export { foo } from '../../src/collector/storage/foo.js';", true],
    ["export * from '../../src/collector/storage/foo.js';", true],
    ["  import('../../src/collector/storage/foo.js');", true],
    ["const msg = 'storage/ reference in a string';", false],
    ["const importStorage = 1;", false],
    ["throw new Error('cannot import from storage/ here');", false],
  ])('classifies %j → flagged=%s', (line, expected) => {
    expect(matches(line)).toBe(expected);
  });
});

/**
 * Multi-line import coverage. A `import { ... } from '...'` block that
 * wraps across several lines must still be recognised as an import
 * statement so the guard's per-statement check sees the module
 * specifier. Historically `findOffenders` tested each physical line
 * independently and missed these entirely.
 */
describe('findOffenders — multi-line import/export coverage', () => {
  const tmpRoot = fileURLToPath(new URL('./', import.meta.url));

  function scanContent(source: string): Array<{ line: number; text: string }> {
    const scratch = `${tmpRoot}__boundary-multiline-scratch.ts`;
    writeFileSync(scratch, source, 'utf8');
    try {
      return findOffenders(scratch, /storage\//).map((o) => ({
        line: o.line,
        text: o.text,
      }));
    } finally {
      unlinkSync(scratch);
    }
  }

  it('flags a multi-line named import from storage/', () => {
    const src = [
      'import {',
      '  openSqliteStorage,',
      "} from '../storage/sqlite/index.js';",
      '',
    ].join('\n');

    const offenders = scanContent(src);
    expect(offenders).toHaveLength(1);
    // The reported line number is the statement's FIRST line, which
    // is the one starting with `import {`.
    expect(offenders[0]!.line).toBe(1);
    expect(offenders[0]!.text).toContain('storage/');
  });

  it('flags a multi-line re-export from storage/', () => {
    const src = [
      'export {',
      '  openSqliteStorage,',
      '  type SqliteStorageOptions,',
      "} from '../storage/sqlite/index.js';",
    ].join('\n');

    const offenders = scanContent(src);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]!.line).toBe(1);
  });

  it('does not flag a multi-line import from an allowed path', () => {
    const src = [
      'import {',
      '  KiroMemEvent,',
      '  MemoryRecord,',
      "} from '../../types/index.js';",
    ].join('\n');

    expect(scanContent(src)).toEqual([]);
  });

  it('handles adjacent multi-line imports independently', () => {
    const src = [
      'import {',
      '  frameEvent,',
      "} from './xml-framer.js';",
      'import {',
      '  openSqliteStorage,',
      "} from '../storage/sqlite/index.js';",
    ].join('\n');

    const offenders = scanContent(src);
    expect(offenders).toHaveLength(1);
    // The offender must be the second block (starting at line 4),
    // not the first — the first imports from a clean path.
    expect(offenders[0]!.line).toBe(4);
  });

  it('still handles a single-line import after a multi-line one', () => {
    const src = [
      'import {',
      '  foo,',
      "} from './clean.js';",
      "import bar from '../storage/sqlite/foo.js';",
    ].join('\n');

    const offenders = scanContent(src);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]!.line).toBe(4);
  });
});
