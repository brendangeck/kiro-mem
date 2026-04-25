/**
 * Migration 0002 — XML extraction pipeline fields.
 *
 * Adds three columns to `memory_records` to persist the richer data the
 * XML-based compressor produces:
 *
 * - `concepts_json`       — JSON-encoded `string[]`, NOT NULL, default `'[]'`.
 * - `files_touched_json`  — JSON-encoded `string[]`, NOT NULL, default `'[]'`.
 * - `observation_type`    — one of the five allowed enum values; see the
 *                            `CHECK` constraint. Defaults to `'tool_use'`
 *                            for rows written under migration 0001 that
 *                            lack this information.
 *
 * Also backfills any rows inserted before 0002 so they satisfy the new
 * `NOT NULL` constraints.
 *
 * Design notes:
 *
 * - JSON columns use a `_json` suffix to match the existing convention
 *   (`facts_json`, `source_event_ids_json`). The application layer
 *   serialises with `JSON.stringify` on write and parses with
 *   `JSON.parse` on read.
 * - `observation_type` is stored as TEXT with a `CHECK` constraint rather
 *   than an enum (SQLite has no native enum). The allow-list here MUST
 *   stay in sync with `OBSERVATION_TYPES` in `src/types/schemas.ts`.
 * - The default values (`'[]'` / `'tool_use'`) exist only to satisfy the
 *   NOT NULL constraint on the ALTER TABLE for legacy rows. Fresh inserts
 *   always pass explicit values, so application code never relies on the
 *   default.
 * - FTS5 indexing is not extended in this migration. Concepts and files
 *   are discovery metadata, not primary retrieval keys; adding them to
 *   the FTS row would require a rebuild and is out of scope for v1.
 *
 * Validates: Requirements 8.1, 8.2, 8.3
 */

import type { Migration } from './types.js';

export const DDL = `
ALTER TABLE memory_records
  ADD COLUMN concepts_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE memory_records
  ADD COLUMN files_touched_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE memory_records
  ADD COLUMN observation_type TEXT NOT NULL DEFAULT 'tool_use'
  CHECK (observation_type IN ('tool_use','decision','error','discovery','pattern'));
`;

export const migration0002: Migration = {
  version: 2,
  name: '0002_xml_extraction_fields',
  up: (db) => db.exec(DDL),
};
