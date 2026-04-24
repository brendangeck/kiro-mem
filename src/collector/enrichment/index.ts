/**
 * Enrichment — the synchronous context-assembly path.
 *
 * When a `prompt` event arrives with enrichment requested, this module
 * retrieves relevant memory records from the query layer, formats them into
 * injection-ready context, and returns before the hard latency budget
 * expires. Partial results are preferable to errors.
 */
export {};
