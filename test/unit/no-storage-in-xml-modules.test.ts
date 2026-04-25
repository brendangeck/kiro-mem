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

import { readFileSync } from 'node:fs';
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
 * Regex that matches `import ... from '<path>'` and
 * `export ... from '<path>'` statements. We only want to flag real
 * dependency edges, not incidental mentions of a forbidden path inside
 * string literals, variable names, or error messages.
 *
 * The pattern is intentionally loose on the middle (matching anything
 * up to `from`) so it catches default, namespace, named, and type-only
 * imports / re-exports in a single pass.
 */
const IMPORT_LIKE_RE = /^\s*(?:import|export)\b[^;]*\bfrom\s+['"]/;

/**
 * Scan a single file for import/export-from lines matching a forbidden
 * import pattern. Returns an array of offending lines (empty if clean).
 *
 * A line is an offender only when BOTH conditions hold:
 *   1. It is an `import ... from '<path>'` or `export ... from '<path>'`.
 *   2. Its text matches the forbidden `pattern` (e.g. /storage\//).
 *
 * This dual check avoids false positives when the forbidden substring
 * appears inside a comment, a variable name, a diagnostic message, or
 * an inline regex literal in unrelated code.
 */
function findOffenders(
  filePath: string,
  pattern: RegExp,
): Array<{ file: string; line: number; text: string }> {
  const stripped = stripComments(readFileSync(filePath, 'utf8'));
  const lines = stripped.split('\n');
  const offenders: Array<{ file: string; line: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (IMPORT_LIKE_RE.test(line) && pattern.test(line)) {
      offenders.push({ file: filePath, line: i + 1, text: line.trim() });
    }
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
