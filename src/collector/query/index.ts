/**
 * Query — the retrieval surface over stored memory records.
 *
 * v1: lexical search against FTS5, scoped by namespace.
 * v2+: hybrid retrieval (lexical + vector + recency) with reranking.
 */

import type { MemoryRecord, StorageBackend } from '../../types/index.js';

/**
 * The query layer interface. Delegates to the storage backend for
 * memory record search. Exists as a seam for v2's hybrid retrieval.
 */
export interface QueryLayer {
  search(namespace: string, query: string, limit: number): Promise<MemoryRecord[]>;
}

/**
 * Create a query layer backed by the given storage.
 *
 * v1 is a thin pass-through to {@link StorageBackend.searchMemoryRecords}.
 * Results are returned in storage backend order (FTS5 rank for v1).
 * An empty result set is returned as an empty array, never an error.
 */
export function createQueryLayer(storage: StorageBackend): QueryLayer {
  return {
    async search(namespace: string, query: string, limit: number): Promise<MemoryRecord[]> {
      const results = await storage.searchMemoryRecords({ namespace, query, limit });
      return results;
    },
  };
}
