/**
 * FTS5 query sanitisation helpers for the SQLite storage backend.
 *
 * FTS5's `MATCH` right-hand side is a query grammar, not a plain string:
 * unquoted tokens are matched as individual terms and symbols like `*`,
 * `(`, `)`, `:`, and the keywords `AND | OR | NOT | NEAR` have syntactic
 * meaning. Splicing a user-controlled string into that grammar is a
 * FTS5-equivalent of SQL injection — at best it produces surprising ranking,
 * at worst it throws a parse error and breaks the enrichment path.
 *
 * The v1 strategy is deliberately simple: treat every user query as a
 * single FTS5 phrase. A phrase is any string enclosed in double quotes;
 * inside a phrase, FTS5 operators are inert and only double-quote needs
 * escaping (by doubling, the SQL-quoting convention FTS5 inherits).
 *
 * Kept in its own file — rather than inlined in `index.ts` — so the PBT
 * for Task 6.6 ("FTS5 query sanitization is safe") can import it without
 * reaching into the backend.
 *
 * @see Requirements 8.5, 12.2
 * @see .kiro/specs/event-schema-and-storage/design.md § searchMemoryRecords
 *      (SQLite, FTS5 path) — the `sanitizeForFts5` pseudocode this
 *      implementation mirrors.
 * @module
 */

/**
 * Quote arbitrary user-supplied text as a single FTS5 phrase.
 *
 * Every interior double-quote is doubled, then the whole string is wrapped
 * in double-quotes. The resulting string is syntactically a phrase in FTS5
 * and contains no active operators regardless of the input.
 *
 * Examples:
 *   sanitizeForFts5('refresh tokens')   → '"refresh tokens"'
 *   sanitizeForFts5('a "b" c')          → '"a ""b"" c"'
 *   sanitizeForFts5('*)(NEAR:"foo"')    → '"*)(NEAR:""foo"""'
 *
 * @see Requirements 8.5, 12.2
 */
export function sanitizeForFts5(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}
