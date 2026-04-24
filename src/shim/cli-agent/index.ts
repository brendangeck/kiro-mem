/**
 * Kiro CLI agent hook shim (v1).
 *
 * Invoked by `hooks.*.command` entries in a `.kiro/agents/kiro-learn.json`
 * agent config. Reads Kiro's hook input from stdin/env, normalizes it into a
 * canonical Event, POSTs it to the collector, and returns any enrichment
 * context to the Kiro runtime for prompt injection.
 */
export {};
