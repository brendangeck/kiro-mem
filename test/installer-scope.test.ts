/**
 * Unit tests for `detectScope` in `src/installer/index.ts`.
 *
 * Uses real temp directories with mkdirSync/writeFileSync for markers.
 * Overrides `homedir()` via vi.mock to point at a temp directory.
 *
 * Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8
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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve symlinks (macOS /var → /private/var) so that realpathSync
// inside detectScope produces paths consistent with our mock homedir.
let tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-scope-init-')),
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

// The initial tmpHome created at module scope needs cleanup.
const initialTmpHome = tmpHome;

describe('detectScope', () => {
  beforeEach(() => {
    tmpHome = realpathSync(
      mkdtempSync(join(tmpdir(), 'kiro-learn-scope-test-')),
    );
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(initialTmpHome, { recursive: true, force: true });
  });

  it('returns global-only when cwd is $HOME', () => {
    /**
     * Validates: Requirements 15.5
     */
    const scope = detectScope(tmpHome);

    expect(scope.global).toBe(true);
    expect(scope.projectRoot).toBeUndefined();
    expect(scope.detectedMarker).toBeUndefined();
  });

  it('returns project scope when .git/ found in cwd', () => {
    /**
     * Validates: Requirements 15.2, 15.6
     */
    const projectDir = join(tmpHome, 'my-project');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, '.git'));

    const scope = detectScope(projectDir);

    expect(scope.global).toBe(true);
    expect(scope.projectRoot).toBe(projectDir);
    expect(scope.detectedMarker).toBe('.git');
  });

  it('returns project scope when package.json found in ancestor', () => {
    /**
     * Validates: Requirements 15.1, 15.6
     *
     * The walk goes upward from cwd. A package.json in an ancestor
     * directory should be detected.
     */
    const projectDir = join(tmpHome, 'workspace');
    const subDir = join(projectDir, 'src', 'components');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), '{}');

    const scope = detectScope(subDir);

    expect(scope.global).toBe(true);
    expect(scope.projectRoot).toBe(projectDir);
    expect(scope.detectedMarker).toBe('package.json');
  });

  it('returns global-only when no markers found before $HOME', () => {
    /**
     * Validates: Requirements 15.7
     *
     * A subdirectory of $HOME with no project markers should result
     * in global-only scope.
     */
    const emptyDir = join(tmpHome, 'some', 'deep', 'path');
    mkdirSync(emptyDir, { recursive: true });

    const scope = detectScope(emptyDir);

    expect(scope.global).toBe(true);
    expect(scope.projectRoot).toBeUndefined();
    expect(scope.detectedMarker).toBeUndefined();
  });

  it('throws when cwd is above $HOME', () => {
    /**
     * Validates: Requirements 15.4
     *
     * Passing a path outside the home directory tree should throw.
     */
    // Create a sibling directory of tmpHome (same parent, different name)
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

  it('nearest-marker-wins when multiple markers in walk path', () => {
    /**
     * Validates: Requirements 15.8
     *
     * When markers exist at multiple levels, the nearest one (closest
     * to cwd) wins.
     */
    const outerProject = join(tmpHome, 'outer');
    const innerProject = join(outerProject, 'inner');
    const deepDir = join(innerProject, 'src');
    mkdirSync(deepDir, { recursive: true });

    // Outer has .git, inner has package.json
    mkdirSync(join(outerProject, '.git'));
    writeFileSync(join(innerProject, 'package.json'), '{}');

    const scope = detectScope(deepDir);

    // Inner project (package.json) is nearer than outer (.git)
    expect(scope.projectRoot).toBe(innerProject);
    expect(scope.detectedMarker).toBe('package.json');
  });

  it('all 15 project markers are recognized', () => {
    /**
     * Validates: Requirements 15.2
     *
     * Each of the 15 project markers should be individually detected
     * when present in a directory.
     */
    const markers = [
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
    ];

    for (const marker of markers) {
      // Create a fresh project directory for each marker
      const projectDir = join(tmpHome, `project-${marker.replace(/\./g, '_')}`);
      mkdirSync(projectDir, { recursive: true });

      // Create the marker — directories for .kiro and .git, files for the rest
      const markerPath = join(projectDir, marker);
      if (marker === '.kiro' || marker === '.git') {
        mkdirSync(markerPath);
      } else {
        writeFileSync(markerPath, '');
      }

      const scope = detectScope(projectDir);

      expect(scope.projectRoot, `marker "${marker}" should be detected`).toBe(
        projectDir,
      );
      expect(
        scope.detectedMarker,
        `detectedMarker should be "${marker}"`,
      ).toBe(marker);
    }
  });
});
