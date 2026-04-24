/**
 * Pipeline — the chain of processors an Event traverses between the receiver
 * and storage.
 *
 * Stages (v1):
 *   dedup → privacy scrub → memory strategy extraction → storage
 *
 * Each processor is a pure input → output transform.
 */
export {};
