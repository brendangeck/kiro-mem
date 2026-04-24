import { describe, expect, it } from 'vitest';
import type {
  SearchParams,
  StorageBackend,
} from '../src/collector/storage/index.js';
import type { KiroMemEvent, MemoryRecord } from '../src/types/index.js';

/**
 * Type-level example test for the `StorageBackend` interface.
 *
 * The real verification work in this file is done at compile time: declaring
 * `class NoopStorageBackend implements StorageBackend` forces TypeScript to
 * prove the interface has exactly five methods with the signatures the spec
 * requires. If the interface drifts (a method is renamed, a parameter type
 * changes, a return type stops being `Promise<...>`), this file fails to
 * compile and `npm run typecheck` catches it before any runtime check runs.
 *
 * The runtime assertions below are a thin belt-and-braces check that each
 * member is a callable function on an instance. They do not invoke any
 * method; the bodies are trivial.
 *
 * Imports intentionally route through `src/collector/storage/index.js` to
 * exercise the re-export path, since the storage module is the canonical
 * entry point downstream code will use.
 *
 * @see Requirements 4.1–4.6, 11.3
 */
class NoopStorageBackend implements StorageBackend {
  async putEvent(_event: KiroMemEvent): Promise<void> {}

  async getEventById(_eventId: string): Promise<KiroMemEvent | null> {
    return null;
  }

  async putMemoryRecord(_record: MemoryRecord): Promise<void> {}

  async searchMemoryRecords(_params: SearchParams): Promise<MemoryRecord[]> {
    return [];
  }

  async close(): Promise<void> {}
}

describe('StorageBackend interface', () => {
  it('has the five required methods with the expected shape', () => {
    const be: StorageBackend = new NoopStorageBackend();

    expect(typeof be.putEvent).toBe('function');
    expect(typeof be.getEventById).toBe('function');
    expect(typeof be.putMemoryRecord).toBe('function');
    expect(typeof be.searchMemoryRecords).toBe('function');
    expect(typeof be.close).toBe('function');
  });
});
