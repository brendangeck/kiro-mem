/**
 * HTTP receiver — the collector's public ingest surface.
 *
 * Exposes `POST /v1/events` for shims to submit canonical Events, and the
 * enrichment path (`POST /v1/events?enrich=1` or similar) for synchronous
 * context retrieval. Validates schema, delegates everything else to the
 * pipeline.
 */
export {};
