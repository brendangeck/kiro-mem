/**
 * Storage — the pluggable persistence layer.
 *
 * Any backend must implement {@link StorageBackend}. v1 ships SQLite only.
 * Future backends (pgvector, Bedrock AgentCore Memory) are added as sibling
 * modules without touching the pipeline.
 */
export type { StorageBackend } from '../../types/index.js';
