/**
 * Lint-style guard test.
 *
 * Asserts that no source file under the four pipeline module directories
 * (`src/collector/receiver/`, `src/collector/pipeline/`,
 * `src/collector/retrieval/`, `src/collector/query/`) imports from
 * `src/collector/storage/sqlite/`.
 *
 * The design document (§ Modularity boundary) states that every collector
 * component interacts with persistence exclusively through the
 * `StorageBackend` interface. Only the top-level daemon wiring
 * (`src/collector/index.ts`) may import from the concrete SQLite backend.
 * A direct import from `storage/sqlite/` inside any pipeline module would
 * indicate a modularity violation — coupling the pipeline to a specific
 * storage implementation.
 *
 * The check recursively reads every `.ts` file under the four directories,
 * strips comments (so that prose describing the boundary is allowed), and
 * searches for import statements referencing `storage/sqlite`.
 *
 * Validates: Design § Modularity boundary
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Directories that must NOT import from storage/sqlite/. */
const GUARDED_DIRS = [
  fileURLToPath(new URL('../src/collector/receiver', import.meta.url)),
  fileURLToPath(new URL('../src/collector/pipeline', import.meta.url)),
  fileURLToPath(new URL('../src/collector/retrieval', import.meta.url)),
  fileURLToPath(new URL('../src/collector/query', import.meta.url)),
];

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

describe('pipeline modules — no direct SQLite imports', () => {
  it('does not import from storage/sqlite/ in receiver, pipeline, retrieval, or query modules', () => {
    /**
     * **Validates: Design § Modularity boundary**
     *
     * Only `src/collector/index.ts` (the daemon wiring) may import from
     * `src/collector/storage/sqlite/`. Every other pipeline module
     * receives a `StorageBackend` via dependency injection. A direct
     * import from `storage/sqlite` in any of the four guarded directories
     * is a modularity violation.
     */
    const files: string[] = [];
    for (const dir of GUARDED_DIRS) {
      files.push(...collectTsFiles(dir));
    }

    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the directories) would otherwise
    // produce a silently-passing vacuous test.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    // Match import statements that reference storage/sqlite in any form:
    //   - 'storage/sqlite'
    //   - './storage/sqlite'
    //   - '../storage/sqlite'
    //   - '../../storage/sqlite'
    //   - etc.
    const sqliteImportPattern = /storage\/sqlite/;

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (sqliteImportPattern.test(line)) {
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
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from storage/sqlite/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});
