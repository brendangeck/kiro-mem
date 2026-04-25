/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/installer/` imports from
 * `src/shim/`.
 *
 * The design document (§ Module Structure) states:
 *
 * | Module                    | May import from                              | Must NOT import from |
 * |---------------------------|----------------------------------------------|----------------------|
 * | src/installer/index.ts    | src/collector/index.ts, src/types/            | src/shim/            |
 * | src/installer/bin.ts      | src/installer/index.ts                        | src/shim/            |
 *
 * The installer invokes the shim via bin wrapper scripts at runtime,
 * not as a library import. A direct import from `src/shim/` in any
 * installer module is a modularity violation.
 *
 * Validates: Design § Module Structure
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
 * code. TSDoc and line comments that *describe* the modularity boundary
 * are explicitly allowed; only executable import statements are violations.
 *
 * The stripper handles the two comment forms TypeScript uses:
 *   - block comments `/* … *\/` (any length, including TSDoc `/** … *\/`);
 *   - line comments `// …` to end of line.
 */
function stripComments(source: string): string {
  // Block comments first, to avoid `//` inside `/* ... // ... */` being
  // treated as the start of a line comment.
  let withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  withoutBlocks = withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return withoutBlocks;
}

describe('installer modules — no shim imports', () => {
  const INSTALLER_DIR = fileURLToPath(
    new URL('../../src/installer', import.meta.url),
  );

  it('does not import from shim/ in any installer module', () => {
    /**
     * **Validates: Design § Module Structure**
     *
     * The installer invokes the shim via bin wrapper scripts, not as a
     * library call. A direct import from `shim/` in any installer module
     * is a modularity violation.
     */
    const files = collectTsFiles(INSTALLER_DIR);

    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the directories) would otherwise
    // produce a silently-passing vacuous test.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    // Match actual TypeScript import/export statements that reference shim/.
    // The pattern requires the line to start with `import` or `export`
    // (possibly with leading whitespace), which distinguishes real module
    // imports from string literals inside bin wrapper content (e.g.
    // `'import { main } from "../lib/shim/cli-agent/index.js";'`).
    //
    // We also match dynamic `import()` and `require()` with a quoted
    // string argument pointing at a shim path.
    const shimImportPattern =
      /^\s*(?:import|export)\b.*shim\/|(?:import|require)\s*\(\s*['"`].*shim\//;

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (shimImportPattern.test(line)) {
          offenders.push({
            file,
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from shim/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});
