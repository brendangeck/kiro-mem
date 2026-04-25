/**
 * Unit tests for the updated XML-based compressor agent prompt.
 *
 * Verifies the prompt written by writeAgentConfigs() instructs the model
 * to accept <tool_observation> XML input and respond with <memory_record>
 * XML output, and does not reference the old JSON output format.
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve symlinks so paths are consistent with realpathSync inside the module.
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-compressor-prompt-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Import after mock so vitest intercepts the module.
const { writeAgentConfigs, INSTALL_DIR } = await import(
  '../../src/installer/index.js'
);

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Read the compressor config prompt from the temp agents directory. */
function readCompressorPrompt(): string {
  const configPath = join(tmpHome, '.kiro', 'agents', 'kiro-learn-compressor.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { prompt: string };
  return config.prompt;
}

describe('compressor agent XML prompt', () => {
  beforeEach(() => {
    mkdirSync(join(INSTALL_DIR, 'bin'), { recursive: true });
    mkdirSync(join(tmpHome, '.kiro', 'agents'), { recursive: true });
    writeAgentConfigs({
      global: true,
      projectRoot: undefined,
      detectedMarker: undefined,
    });
  });

  afterEach(() => {
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });
  });

  it('instructs the model to accept <tool_observation> XML input', () => {
    /**
     * Validates: Requirement 7.1
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toContain('<tool_observation>');
  });

  it('instructs the model to respond with <memory_record> XML output', () => {
    /**
     * Validates: Requirement 7.1
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toContain('<memory_record');
    expect(prompt).toContain('</memory_record>');
  });

  it('specifies all allowed type attribute values', () => {
    /**
     * Validates: Requirement 7.2
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toContain('tool_use');
    expect(prompt).toContain('decision');
    expect(prompt).toContain('error');
    expect(prompt).toContain('discovery');
    expect(prompt).toContain('pattern');
  });

  it('specifies required child elements', () => {
    /**
     * Validates: Requirement 7.3
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toContain('<title>');
    expect(prompt).toContain('<summary>');
    expect(prompt).toContain('<facts>');
    expect(prompt).toContain('<fact>');
    expect(prompt).toContain('<concepts>');
    expect(prompt).toContain('<concept>');
    expect(prompt).toContain('<files>');
    expect(prompt).toContain('<file>');
  });

  it('instructs that empty responses are valid skip signals', () => {
    /**
     * Validates: Requirement 7.4
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toMatch(/empty response.*skip/i);
  });

  it('instructs that non-XML text is discarded', () => {
    /**
     * Validates: Requirement 7.5
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toContain('Non-XML text is discarded');
  });

  it('does not reference JSON output format', () => {
    /**
     * Validates: Requirements 7.1, 7.5
     *
     * The old prompt instructed the model to output JSON. The new prompt
     * must not contain any JSON output instructions.
     */
    const prompt = readCompressorPrompt();
    expect(prompt).not.toMatch(/JSON object/i);
    expect(prompt).not.toMatch(/Required JSON fields/i);
    expect(prompt).not.toMatch(/markdown fencing/i);
    expect(prompt).not.toContain('Just the JSON');
  });
});
