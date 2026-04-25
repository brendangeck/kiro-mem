/**
 * Integration test: extraction pipeline with real kiro-cli.
 *
 * Requires:
 * - kiro-cli installed and on PATH
 * - kiro-learn-compressor agent config at ~/.kiro/agents/kiro-learn-compressor.json
 * - Network access to Amazon Bedrock (via kiro-cli)
 *
 * Run with: npm run test:integ
 *
 * These tests are excluded from CI — they require a real kiro-cli installation
 * and Bedrock credentials. They verify the end-to-end extraction flow:
 * kiro-cli chat → ANSI stripping → JSON extraction → MemoryRecord validation.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseMemoryRecord } from '../../src/types/schemas.js';

// ── Precondition checks ─────────────────────────────────────────────────

/** Check if kiro-cli is available. */
function kiroCLiAvailable(): boolean {
  try {
    execSync('kiro-cli --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Check if the compressor agent config exists. */
function compressorConfigExists(): boolean {
  return existsSync(
    join(homedir(), '.kiro', 'agents', 'kiro-learn-compressor.json'),
  );
}

// ── Helper: spawn kiro-cli and capture output ───────────────────────────

/**
 * Run `kiro-cli chat --no-interactive --agent kiro-learn-compressor` with
 * the given input content. Returns the raw stdout and stderr.
 */
function runCompressor(
  content: string,
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'kiro-cli',
      ['chat', '--no-interactive', '--agent', 'kiro-learn-compressor', content],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      reject(new Error(`kiro-cli timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (killed) return;
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

/**
 * Strip ANSI escape codes and extract the first JSON object from
 * kiro-cli chat output. Mirrors the logic in spawnKiroCli.
 */
function extractJson(raw: string): unknown {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`No JSON object found in output:\n${clean.slice(0, 500)}`);
  }
  return JSON.parse(match[0]) as unknown;
}

// ── Tests ───────────────────────────────────────────────────────────────

const canRun = kiroCLiAvailable() && compressorConfigExists();

describe.skipIf(!canRun)(
  'Extraction pipeline — kiro-cli integration',
  () => {
    // Sample event content that simulates a real tool_use event
    const sampleContent = JSON.stringify({
      tool_name: 'fs_read',
      tool_input: { path: 'src/installer/index.ts' },
      tool_response: {
        success: true,
        result:
          'The file contains the installer module with functions for init, start, stop, status, and uninstall commands.',
      },
    });

    it('kiro-cli chat exits with code 0', async () => {
      const result = await runCompressor(sampleContent);
      expect(result.exitCode).toBe(0);
    }, 60_000);

    it('output contains a JSON object after ANSI stripping', async () => {
      const result = await runCompressor(sampleContent);
      expect(result.exitCode).toBe(0);

      const json = extractJson(result.stdout);
      expect(json).toBeDefined();
      expect(typeof json).toBe('object');
    }, 60_000);

    it('extracted JSON has the expected compressor fields', async () => {
      const result = await runCompressor(sampleContent);
      expect(result.exitCode).toBe(0);

      const json = extractJson(result.stdout) as Record<string, unknown>;

      // The compressor prompt asks for these fields
      expect(json).toHaveProperty('title');
      expect(json).toHaveProperty('summary');
      expect(json).toHaveProperty('facts');
      expect(json).toHaveProperty('observation_type');
      expect(json).toHaveProperty('files_touched');

      // Type checks
      expect(typeof json['title']).toBe('string');
      expect(typeof json['summary']).toBe('string');
      expect(Array.isArray(json['facts'])).toBe(true);
      expect(typeof json['observation_type']).toBe('string');
      expect(Array.isArray(json['files_touched'])).toBe(true);
    }, 60_000);

    it('enriched output passes parseMemoryRecord validation', async () => {
      const result = await runCompressor(sampleContent);
      expect(result.exitCode).toBe(0);

      const json = extractJson(result.stdout) as Record<string, unknown>;

      // Enrich with the fields that runExtraction adds
      // (these aren't in the compressor output — the pipeline adds them)
      const enriched = {
        ...json,
        record_id: 'mr_00000000000000000000000000',
        namespace: '/actor/test/project/test/',
        strategy: 'llm-summary',
        source_event_ids: ['00000000000000000000000000'],
        created_at: new Date().toISOString(),
      };

      // This should not throw — the enriched record must be schema-valid
      const record = parseMemoryRecord(enriched);

      expect(record.title.length).toBeGreaterThan(0);
      expect(record.title.length).toBeLessThanOrEqual(200);
      expect(record.summary.length).toBeGreaterThan(0);
      expect(record.summary.length).toBeLessThanOrEqual(4000);
      expect(record.strategy).toBe('llm-summary');
    }, 60_000);

    it('handles text body content', async () => {
      const textContent = 'The user asked how to configure the collector port.';
      const result = await runCompressor(textContent);
      expect(result.exitCode).toBe(0);

      const json = extractJson(result.stdout) as Record<string, unknown>;
      expect(json).toHaveProperty('title');
      expect(json).toHaveProperty('summary');
    }, 60_000);
  },
);
