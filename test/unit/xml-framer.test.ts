/**
 * Unit tests for the XML framer module.
 *
 * Tests `escapeXml` and `frameEvent` with all three body types, edge cases
 * for missing fields, XML escaping of special characters, and conditional
 * `<output>` inclusion.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Component 2
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 2, 3
 */

import { describe, expect, it } from 'vitest';

import {
  escapeXml,
  frameEvent,
} from '../../src/collector/pipeline/xml-framer.js';
import { makeValidEvent } from '../helpers/fixtures.js';

// ── escapeXml ───────────────────────────────────────────────────────────

describe('escapeXml', () => {
  it('replaces all five XML special characters', () => {
    const input = `<div class="a" data-x='b'>Tom & Jerry</div>`;
    const escaped = escapeXml(input);

    expect(escaped).toBe(
      '&lt;div class=&quot;a&quot; data-x=&apos;b&apos;&gt;Tom &amp; Jerry&lt;/div&gt;',
    );
  });

  it('returns the same string when no special characters are present', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });

  it('handles string with only special characters', () => {
    expect(escapeXml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&apos;');
  });
});

// ── frameEvent — json body ──────────────────────────────────────────────

describe('frameEvent — json body', () => {
  it('frames json body with tool_name, tool_input, and tool_response', () => {
    const event = makeValidEvent({
      kind: 'tool_use',
      body: {
        type: 'json',
        data: {
          tool_name: 'fs_write',
          tool_input: { path: 'src/auth.ts', content: '...' },
          tool_response: { success: true },
        },
      },
    });

    const xml = frameEvent(event);

    expect(xml).toContain('<tool_name>fs_write</tool_name>');
    expect(xml).toContain('<timestamp>');
    expect(xml).toContain('<input>');
    expect(xml).toContain('<output>');
    expect(xml.startsWith('<tool_observation>')).toBe(true);
    expect(xml.endsWith('</tool_observation>')).toBe(true);
  });

  it('defaults tool_name to "unknown" when missing from json body', () => {
    const event = makeValidEvent({
      kind: 'tool_use',
      body: {
        type: 'json',
        data: {
          tool_input: 'some input',
        },
      },
    });

    const xml = frameEvent(event);

    expect(xml).toContain('<tool_name>unknown</tool_name>');
  });

  it('omits <output> when tool_response is not present', () => {
    const event = makeValidEvent({
      kind: 'tool_use',
      body: {
        type: 'json',
        data: {
          tool_name: 'read_file',
          tool_input: { path: 'README.md' },
        },
      },
    });

    const xml = frameEvent(event);

    expect(xml).toContain('<tool_name>read_file</tool_name>');
    expect(xml).not.toContain('<output>');
  });

  it('serializes object tool_input as JSON', () => {
    const event = makeValidEvent({
      kind: 'tool_use',
      body: {
        type: 'json',
        data: {
          tool_name: 'exec',
          tool_input: { cmd: 'ls', args: ['-la'] },
        },
      },
    });

    const xml = frameEvent(event);

    // The JSON-serialized input should be XML-escaped
    expect(xml).toContain(
      `<input>${escapeXml(JSON.stringify({ cmd: 'ls', args: ['-la'] }))}</input>`,
    );
  });

  it('converts non-object tool_input to string', () => {
    const event = makeValidEvent({
      kind: 'tool_use',
      body: {
        type: 'json',
        data: {
          tool_name: 'echo',
          tool_input: 42,
        },
      },
    });

    const xml = frameEvent(event);

    expect(xml).toContain('<input>42</input>');
  });
});

// ── frameEvent — text body ──────────────────────────────────────────────

describe('frameEvent — text body', () => {
  it('wraps text content as <input>', () => {
    const event = makeValidEvent({
      kind: 'prompt',
      body: { type: 'text', content: 'Hello, world!' },
    });

    const xml = frameEvent(event);

    expect(xml).toContain('<tool_name>unknown</tool_name>');
    expect(xml).toContain('<input>Hello, world!</input>');
    expect(xml).not.toContain('<output>');
  });
});

// ── frameEvent — message body ───────────────────────────────────────────

describe('frameEvent — message body', () => {
  it('concatenates turns as <input>', () => {
    const event = makeValidEvent({
      kind: 'prompt',
      body: {
        type: 'message',
        turns: [
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: 'The answer is 4.' },
        ],
      },
    });

    const xml = frameEvent(event);

    expect(xml).toContain(
      '<input>user: What is 2+2?\nassistant: The answer is 4.</input>',
    );
    expect(xml).toContain('<tool_name>unknown</tool_name>');
    expect(xml).not.toContain('<output>');
  });
});

// ── frameEvent — XML escaping ───────────────────────────────────────────

describe('frameEvent — XML escaping', () => {
  it('escapes special characters in text body content', () => {
    const event = makeValidEvent({
      kind: 'prompt',
      body: { type: 'text', content: 'x < 5 && y > 3 "quoted" \'apos\'' },
    });

    const xml = frameEvent(event);

    // The content should be escaped
    expect(xml).toContain(
      '<input>x &lt; 5 &amp;&amp; y &gt; 3 &quot;quoted&quot; &apos;apos&apos;</input>',
    );
  });

  it('escapes special characters in json body tool_name', () => {
    const event = makeValidEvent({
      kind: 'tool_use',
      body: {
        type: 'json',
        data: {
          tool_name: 'tool<with>&special"chars\'',
          tool_input: 'input',
        },
      },
    });

    const xml = frameEvent(event);

    expect(xml).toContain(
      '<tool_name>tool&lt;with&gt;&amp;special&quot;chars&apos;</tool_name>',
    );
  });

  it('escapes special characters in message body turns', () => {
    const event = makeValidEvent({
      kind: 'prompt',
      body: {
        type: 'message',
        turns: [{ role: 'user', content: 'a < b & c > d' }],
      },
    });

    const xml = frameEvent(event);

    expect(xml).toContain(
      '<input>user: a &lt; b &amp; c &gt; d</input>',
    );
  });
});
