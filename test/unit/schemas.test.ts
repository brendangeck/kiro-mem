/**
 * Example-level unit tests for the Zod schema surface in
 * `src/types/schemas.ts`.
 *
 * Scope: exercise the Event / MemoryRecord validators via `parseEvent` and
 * `parseMemoryRecord`, covering every body variant, every `kind` enum value,
 * optional `content_hash` presence/absence, and `ZodError.issues[0].path`
 * correctness for each top-level field violation.
 *
 * Property-based generators and round-trip tests land in tasks 2.3 and 2.4.
 *
 * @see .kiro/specs/event-schema-and-storage/requirements.md
 *      § Requirement 1 and Requirement 2
 * @see .kiro/specs/event-schema-and-storage/design.md § Zod Schemas
 */

import { describe, expect, it } from 'vitest';
import { ZodError, type ZodIssue } from 'zod';

import {
  parseEvent,
  parseMemoryRecord,
  type KiroMemEvent,
  type MemoryRecord,
} from '../../src/types/schemas.js';

const validEventBase: KiroMemEvent = {
  event_id: '01JF8ZS4Y00000000000000000',
  session_id: 'sess-1',
  actor_id: 'alice',
  namespace: '/actor/alice/project/abc/',
  schema_version: 1,
  kind: 'prompt',
  body: { type: 'text', content: 'hi' },
  valid_time: '2026-04-23T20:00:00Z',
  source: { surface: 'kiro-cli', version: '0.1.0', client_id: 'client-1' },
};

/**
 * Minimal-valid event as a plain `unknown` value so tests can apply targeted
 * mutations without TypeScript fighting them. Returns a deep clone so caller
 * mutations never leak back to the base.
 */
function validEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    ...structuredClone(validEventBase),
    ...overrides,
  };
}

/**
 * Helper that runs `parseEvent` on input it expects to fail, and returns the
 * first `ZodIssue` so tests can assert on `path`. Throws if parsing
 * unexpectedly succeeds, or if the raised error has no issues.
 */
function firstIssueFor(input: unknown): ZodIssue {
  try {
    parseEvent(input);
  } catch (err) {
    expect(err).toBeInstanceOf(ZodError);
    const issues = (err as ZodError).issues;
    expect(issues.length).toBeGreaterThan(0);
    const first = issues[0];
    if (first === undefined) {
      throw new Error('ZodError has no issues');
    }
    return first;
  }
  throw new Error('parseEvent unexpectedly succeeded');
}

describe('parseEvent — body variants (Requirement 1.3, 2.6)', () => {
  it('accepts body: { type: "text", content }', () => {
    const input = validEvent({ body: { type: 'text', content: 'hello' } });
    const result = parseEvent(input);
    expect(result.body).toEqual({ type: 'text', content: 'hello' });
  });

  it('accepts body: { type: "message", turns }', () => {
    const body = {
      type: 'message' as const,
      turns: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };
    const input = validEvent({ body });
    const result = parseEvent(input);
    expect(result.body).toEqual(body);
  });

  it('accepts body: { type: "json", data }', () => {
    const body = { type: 'json' as const, data: { foo: 42, bar: ['a', 'b'] } };
    const input = validEvent({ body });
    const result = parseEvent(input);
    expect(result.body).toEqual(body);
  });
});

describe('parseEvent — kind enum values (Requirement 1.2, 2.5)', () => {
  const kinds = ['prompt', 'tool_use', 'session_summary', 'note'] as const;

  for (const kind of kinds) {
    it(`accepts kind: "${kind}"`, () => {
      const input = validEvent({ kind });
      const result = parseEvent(input);
      expect(result.kind).toBe(kind);
    });
  }
});

describe('parseEvent — optional content_hash (Requirement 1.1, 2.9)', () => {
  it('accepts an event without content_hash and leaves it undefined', () => {
    const input = validEvent();
    // Defensive: ensure the base does not carry a content_hash.
    expect((input as Record<string, unknown>).content_hash).toBeUndefined();

    const result = parseEvent(input);
    expect(result.content_hash).toBeUndefined();
  });

  it('accepts an event with a well-formed sha256 content_hash', () => {
    const hash = 'sha256:' + '0'.repeat(64);
    const input = validEvent({ content_hash: hash });
    const result = parseEvent(input);
    expect(result.content_hash).toBe(hash);
  });
});

describe('parseEvent — ZodError.issues[0].path pinpoints the broken field (Requirement 2.11)', () => {
  it('bad event_id → path includes "event_id"', () => {
    const bad = validEvent({ event_id: 'not-a-ulid' });
    expect(() => parseEvent(bad)).toThrow(ZodError);

    const issue = firstIssueFor(bad);
    expect(issue.path).toContain('event_id');
  });

  it('bad namespace → path includes "namespace"', () => {
    const bad = validEvent({ namespace: 'not-a-namespace' });
    expect(() => parseEvent(bad)).toThrow(ZodError);

    const issue = firstIssueFor(bad);
    expect(issue.path).toContain('namespace');
  });

  it('bad schema_version → path includes "schema_version"', () => {
    const bad = validEvent({ schema_version: 2 });
    expect(() => parseEvent(bad)).toThrow(ZodError);

    const issue = firstIssueFor(bad);
    expect(issue.path).toContain('schema_version');
  });

  it('bad kind → path includes "kind"', () => {
    const bad = validEvent({ kind: 'not-a-kind' });
    expect(() => parseEvent(bad)).toThrow(ZodError);

    const issue = firstIssueFor(bad);
    expect(issue.path).toContain('kind');
  });

  it('bad body.type → path includes "body"', () => {
    const bad = validEvent({ body: { type: 'bogus', content: 'x' } });
    expect(() => parseEvent(bad)).toThrow(ZodError);

    const issue = firstIssueFor(bad);
    expect(issue.path).toContain('body');
  });

  it('bad valid_time → path includes "valid_time"', () => {
    const bad = validEvent({ valid_time: 'not-a-timestamp' });
    expect(() => parseEvent(bad)).toThrow(ZodError);

    const issue = firstIssueFor(bad);
    expect(issue.path).toContain('valid_time');
  });

  it('bad content_hash → path includes "content_hash"', () => {
    const bad = validEvent({ content_hash: 'not-a-hash' });
    expect(() => parseEvent(bad)).toThrow(ZodError);

    const issue = firstIssueFor(bad);
    expect(issue.path).toContain('content_hash');
  });

  it('bad source.surface → path includes "source" and "surface"', () => {
    const bad = validEvent({
      source: { surface: 'not-a-surface', version: '0.1.0', client_id: 'c' },
    });
    expect(() => parseEvent(bad)).toThrow(ZodError);

    const issue = firstIssueFor(bad);
    expect(issue.path).toContain('source');
    expect(issue.path).toContain('surface');
  });
});

describe('parseMemoryRecord — minimal happy path (Requirement 3.1, 3.2)', () => {
  it('accepts a valid memory record and returns it', () => {
    const record: MemoryRecord = {
      record_id: 'mr_01JF8ZS4Z00000000000000000',
      namespace: '/actor/alice/project/abc/',
      strategy: 'llm-summary',
      title: 'Example',
      summary: 'A one-line summary of what happened.',
      facts: ['fact one', 'fact two'],
      source_event_ids: ['01JF8ZS4Y00000000000000000'],
      created_at: '2026-04-23T20:00:00Z',
    };

    const result = parseMemoryRecord(record);
    expect(result).toEqual(record);
  });
});
