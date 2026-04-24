import { describe, expect, it } from 'vitest';
import type { KiroMemEvent } from '../src/index.js';

/**
 * Smoke test — proves the toolchain (TypeScript + vitest + NodeNext ESM
 * resolution) is wired up. Real tests land alongside implementation.
 */
describe('kiro-mem skeleton', () => {
  it('exports the KiroMemEvent type shape', () => {
    const event: KiroMemEvent = {
      event_id: '01JF8ZS4Y0000000000000000',
      session_id: 'kiro-1747000000',
      actor_id: 'alice',
      namespace: '/actor/alice/project/deadbeef/',
      schema_version: 1,
      kind: 'prompt',
      body: { type: 'text', content: 'hello' },
      valid_time: '2026-04-23T20:00:00Z',
      source: {
        surface: 'kiro-cli',
        version: '0.0.0',
        client_id: '00000000-0000-0000-0000-000000000000',
      },
    };

    expect(event.schema_version).toBe(1);
    expect(event.kind).toBe('prompt');
  });
});
