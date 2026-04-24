/**
 * Property-based test: Scope detection correctness.
 *
 * Feature: installer, Property 6: Scope detection correctness
 *
 * For any directory hierarchy under a temp home with randomly placed project
 * markers, detectScope returns the nearest ancestor containing a marker as
 * projectRoot, or undefined if none found before $HOME. Walk never considers
 * $HOME itself. Throws for cwd above $HOME.
 *
 * **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8**
 *
 * @see .kiro/specs/installer/design.md § Property 6
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve symlinks (macOS /var → /private/var).
let tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-scope-prop-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Import after mock so vitest intercepts the module.
const { detectScope } = await import('../src/installer/index.js');

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** The 15 project markers used by detectScope. */
const PROJECT_MARKERS = [
  '.kiro',
  '.git',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'deno.json',
  'deno.jsonc',
] as const;

/** Markers that are directories (not files). */
const DIR_MARKERS = new Set(['.kiro', '.git']);

/**
 * Arbitrary for generating a directory hierarchy with optional markers.
 *
 * Generates:
 * - depth: 1-5 levels of directories
 * - dirNames: names for each level
 * - markerPlacements: optional marker at each level (index into PROJECT_MARKERS or null)
 */
function hierarchyArb(): fc.Arbitrary<{
  depth: number;
  dirNames: string[];
  markerPlacements: Array<number | null>;
}> {
  return fc
    .integer({ min: 1, max: 5 })
    .chain((depth) =>
      fc.record({
        depth: fc.constant(depth),
        dirNames: fc.array(
          fc
            .stringMatching(/^[a-zA-Z0-9_-]{1,10}$/)
            .filter(
              (s) =>
                s.length > 0 &&
                // Avoid names that match project markers
                !PROJECT_MARKERS.includes(s as (typeof PROJECT_MARKERS)[number]),
            ),
          { minLength: depth, maxLength: depth },
        ),
        markerPlacements: fc.array(
          fc.option(fc.integer({ min: 0, max: PROJECT_MARKERS.length - 1 }), {
            nil: null,
          }),
          { minLength: depth, maxLength: depth },
        ),
      }),
    );
}

describe('Installer — property: scope detection correctness (P6)', () => {
  beforeEach(() => {
    // detectScope uses homedir() which returns tmpHome via mock.
    // We create a fresh tmpHome for each test to avoid cross-contamination.
    tmpHome = realpathSync(
      mkdtempSync(join(tmpdir(), 'kiro-learn-scope-prop-')),
    );
  });

  it('detectScope returns nearest ancestor with marker, or undefined if none', () => {
    /**
     * **Validates: Requirements 15.1, 15.2, 15.3, 15.5, 15.6, 15.7, 15.8**
     *
     * Generate random directory hierarchies with markers at various levels.
     * Verify detectScope returns the correct projectRoot and detectedMarker.
     */
    fc.assert(
      fc.property(hierarchyArb(), ({ depth, dirNames, markerPlacements }) => {
        // Build the directory hierarchy
        const dirs: string[] = [];
        let current = tmpHome;
        for (let i = 0; i < depth; i++) {
          current = join(current, dirNames[i]!);
          dirs.push(current);
        }

        // Create all directories
        const deepest = dirs[dirs.length - 1]!;
        mkdirSync(deepest, { recursive: true });

        // Place markers at specified levels
        for (let i = 0; i < depth; i++) {
          const markerIdx = markerPlacements[i];
          if (markerIdx !== null && markerIdx !== undefined) {
            const marker = PROJECT_MARKERS[markerIdx]!;
            const markerPath = join(dirs[i]!, marker);
            if (DIR_MARKERS.has(marker)) {
              mkdirSync(markerPath, { recursive: true });
            } else {
              writeFileSync(markerPath, '');
            }
          }
        }

        // Call detectScope from the deepest directory
        const scope = detectScope(deepest);

        // Determine expected result: walk from deepest upward, find nearest marker
        // detectScope walks from cwd upward, checking each dir for markers
        let expectedProjectRoot: string | undefined;
        let expectedMarker: string | undefined;

        for (let i = depth - 1; i >= 0; i--) {
          const markerIdx = markerPlacements[i];
          if (markerIdx !== null && markerIdx !== undefined) {
            expectedProjectRoot = dirs[i];
            expectedMarker = PROJECT_MARKERS[markerIdx];
            break;
          }
        }

        expect(scope.global).toBe(true);
        expect(scope.projectRoot).toBe(expectedProjectRoot);
        expect(scope.detectedMarker).toBe(expectedMarker);

        // Clean up for next iteration
        rmSync(join(tmpHome, dirNames[0]!), { recursive: true, force: true });
      }),
      { numRuns: 100 },
    );
  });

  it('detectScope at $HOME returns global-only', () => {
    /**
     * **Validates: Requirements 15.5**
     */
    const scope = detectScope(tmpHome);
    expect(scope.global).toBe(true);
    expect(scope.projectRoot).toBeUndefined();
    expect(scope.detectedMarker).toBeUndefined();
  });

  it('detectScope throws for cwd above $HOME', () => {
    /**
     * **Validates: Requirements 15.4**
     */
    const parentOfHome = join(tmpHome, '..');
    const outsideHome = realpathSync(
      mkdtempSync(join(parentOfHome, 'outside-')),
    );

    try {
      expect(() => detectScope(outsideHome)).toThrow(
        'cannot install from outside the home directory tree',
      );
    } finally {
      rmSync(outsideHome, { recursive: true, force: true });
    }
  });

  it('walk never considers $HOME itself as a project root', () => {
    /**
     * **Validates: Requirements 15.3**
     *
     * Even if $HOME contains a project marker, detectScope from a
     * subdirectory should not detect it.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: PROJECT_MARKERS.length - 1 }),
        (markerIdx) => {
          const marker = PROJECT_MARKERS[markerIdx]!;

          // Place a marker in $HOME itself
          const markerPath = join(tmpHome, marker);
          if (DIR_MARKERS.has(marker)) {
            mkdirSync(markerPath, { recursive: true });
          } else {
            writeFileSync(markerPath, '');
          }

          // Create a subdirectory with no markers
          const subDir = join(tmpHome, 'empty-sub');
          mkdirSync(subDir, { recursive: true });

          const scope = detectScope(subDir);

          // Should be global-only because the walk stops before $HOME
          expect(scope.projectRoot).toBeUndefined();
          expect(scope.detectedMarker).toBeUndefined();

          // Clean up
          rmSync(subDir, { recursive: true, force: true });
          if (DIR_MARKERS.has(marker)) {
            rmSync(markerPath, { recursive: true, force: true });
          } else {
            rmSync(markerPath, { force: true });
          }
        },
      ),
      { numRuns: 15 }, // One per marker
    );
  });
});
