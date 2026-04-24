/**
 * Kiro CLI agent hook shim (v1).
 *
 * Invoked by `hooks.*.command` entries in a `.kiro/agents/kiro-learn.json`
 * agent config. Reads Kiro's hook input from stdin/env, normalizes it into a
 * canonical Event, POSTs it to the collector, and returns any enrichment
 * context to the Kiro runtime for prompt injection.
 *
 * @see Requirements 1.1–1.5, 7.1–7.3, 7.5, 11.2
 */

import { readFileSync } from 'node:fs';

import type { KiroMemEvent } from '../../types/index.js';
import {
  buildEvent,
  createSession,
  loadConfig,
  postEvent,
  readSession,
  truncateBody,
} from '../shared/index.js';

// ── Hook input types ────────────────────────────────────────────────────

/** Base fields present in all hook inputs from the Kiro runtime. */
export interface HookInputBase {
  hook_event_name: string;
  cwd: string;
}

/** Input shape for the `agentSpawn` hook — no extra fields. */
export interface AgentSpawnInput extends HookInputBase {
  hook_event_name: 'agentSpawn';
}

/** Input shape for the `userPromptSubmit` hook. */
export interface UserPromptSubmitInput extends HookInputBase {
  hook_event_name: 'userPromptSubmit';
  prompt?: string;
}

/** Input shape for the `postToolUse` hook. */
export interface PostToolUseInput extends HookInputBase {
  hook_event_name: 'postToolUse';
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: {
    success?: boolean;
    result?: unknown;
  };
}

/** Input shape for the `stop` hook. */
export interface StopInput extends HookInputBase {
  hook_event_name: 'stop';
  assistant_response?: string;
}

/** Discriminated union of all recognized hook inputs. */
export type HookInput =
  | AgentSpawnInput
  | UserPromptSubmitInput
  | PostToolUseInput
  | StopInput;

// ── Handler stubs (implemented in tasks 3.2–3.5) ───────────────────────

/**
 * Handle the `agentSpawn` hook.
 *
 * Creates a new session, builds a "note" event, POSTs to the collector,
 * and writes the session ID to stdout.
 *
 * @see Requirements 2.1, 4.1, 6.1
 */
export async function handleSpawn(input: AgentSpawnInput): Promise<void> {
  const config = loadConfig();
  const sessionId = createSession(input.cwd);

  const body = { type: 'text' as const, content: 'session started' };

  const event = buildEvent({
    kind: 'note',
    body,
    sessionId,
    cwd: input.cwd,
  });

  await postEvent(event, { retrieve: false }, config);

  process.stdout.write('kiro-learn session ' + sessionId + '\n');
}

/**
 * Handle the `userPromptSubmit` hook.
 *
 * Reads the session, builds a "prompt" event, POSTs with `retrieve=true`,
 * and writes retrieval context to stdout when available.
 *
 * @see Requirements 2.3, 4.2, 4.5, 5.2, 6.2, 6.3
 */
export async function handlePrompt(
  input: UserPromptSubmitInput,
): Promise<void> {
  const config = loadConfig();
  const sessionId = readSession(input.cwd);

  const promptText = input.prompt ?? '';
  let body: KiroMemEvent['body'] = { type: 'text', content: promptText };
  body = truncateBody(body, config.maxBodyBytes);

  const event = buildEvent({
    kind: 'prompt',
    body,
    sessionId,
    cwd: input.cwd,
  });

  const response = await postEvent(event, { retrieve: true }, config);

  if (
    response !== null &&
    response.retrieval !== undefined &&
    response.retrieval.context !== ''
  ) {
    process.stdout.write(response.retrieval.context);
  }
}

/**
 * Handle the `postToolUse` hook.
 *
 * Reads the session, builds a "tool_use" event, POSTs to the collector.
 * No stdout output.
 *
 * @see Requirements 2.3, 4.3, 4.5, 6.4
 */
export async function handleObserve(input: PostToolUseInput): Promise<void> {
  const config = loadConfig();
  const sessionId = readSession(input.cwd);

  const data = {
    tool_name: input.tool_name ?? 'unknown',
    tool_input: input.tool_input ?? {},
    tool_response: input.tool_response ?? {},
  };

  let body: KiroMemEvent['body'] = { type: 'json', data };
  body = truncateBody(body, config.maxBodyBytes);

  const event = buildEvent({
    kind: 'tool_use',
    body,
    sessionId,
    cwd: input.cwd,
  });

  await postEvent(event, { retrieve: false }, config);
  // No stdout output
}

/**
 * Handle the `stop` hook.
 *
 * Reads the session, builds a "session_summary" event, POSTs to the
 * collector. No stdout output.
 *
 * @see Requirements 2.3, 4.4, 4.5, 6.4
 */
export async function handleSummarize(input: StopInput): Promise<void> {
  const config = loadConfig();
  const sessionId = readSession(input.cwd);

  const responseText = input.assistant_response ?? '';
  let body: KiroMemEvent['body'] = { type: 'text', content: responseText };
  body = truncateBody(body, config.maxBodyBytes);

  const event = buildEvent({
    kind: 'session_summary',
    body,
    sessionId,
    cwd: input.cwd,
  });

  await postEvent(event, { retrieve: false }, config);
  // No stdout output
}

// ── Main entry point ────────────────────────────────────────────────────

/**
 * Main entry point for the CLI agent shim.
 *
 * Reads stdin synchronously, parses as JSON, validates required fields,
 * and dispatches to the appropriate handler based on `hook_event_name`.
 * Wrapped in a top-level try/catch — always exits cleanly, never throws.
 *
 * @see Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 7.1, 7.2, 7.3, 7.5
 */
export async function main(): Promise<void> {
  try {
    loadConfig();

    let raw: string;
    try {
      raw = readFileSync(0, 'utf8');
    } catch {
      return;
    }

    if (raw.trim() === '') {
      return;
    }

    let input: Record<string, unknown>;
    try {
      input = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      process.stderr.write('[kiro-learn] failed to parse stdin JSON\n');
      return;
    }

    if (typeof input['cwd'] !== 'string' || input['cwd'] === '') {
      process.stderr.write('[kiro-learn] missing cwd in hook input\n');
      return;
    }

    const hookName = input['hook_event_name'];

    switch (hookName) {
      case 'agentSpawn':
        await handleSpawn(input as unknown as AgentSpawnInput);
        break;
      case 'userPromptSubmit':
        await handlePrompt(input as unknown as UserPromptSubmitInput);
        break;
      case 'postToolUse':
        await handleObserve(input as unknown as PostToolUseInput);
        break;
      case 'stop':
        await handleSummarize(input as unknown as StopInput);
        break;
      default:
        process.stderr.write(
          `[kiro-learn] unrecognized hook: ${String(hookName)}\n`,
        );
        break;
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    process.stderr.write(`[kiro-learn] unexpected error: ${message}\n`);
  }
}
