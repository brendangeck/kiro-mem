/**
 * ACP Client — manages the lifecycle of a `kiro-cli acp` child process.
 *
 * This module is a thin adapter over the official
 * {@link https://www.npmjs.com/package/@agentclientprotocol/sdk @agentclientprotocol/sdk}.
 * All JSON-RPC 2.0 framing, request/response correlation, and notification
 * dispatch is delegated to the SDK's {@link ClientSideConnection}. Our job
 * here is simply to:
 *
 *   1. Spawn `kiro-cli acp --agent <agentName>` as a child process.
 *   2. Bridge its stdio to the SDK via {@link ndJsonStream}.
 *   3. Run the `initialize` → `newSession` handshake.
 *   4. Expose a domain-specific {@link AcpSession} facade that hides all
 *      ACP internals from the rest of the pipeline.
 *
 * An earlier iteration hand-rolled the JSON-RPC protocol layer and guessed
 * the handshake shape. Integration testing against a real `kiro-cli acp`
 * revealed five separate deviations from the actual ACP spec. Rather than
 * chase an evolving spec with bespoke code, we now use the SDK that the
 * spec maintainers publish.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Component 1
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirement 1
 * @see https://agentclientprotocol.com for the protocol specification
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';

// ── Public types ────────────────────────────────────────────────────────

/**
 * Options for creating an ACP client.
 *
 * @see Requirements 1.1, 1.6
 */
export interface AcpClientOptions {
  /** Name of the agent to load, e.g. `'kiro-learn-compressor'`. */
  agentName: string;
  /**
   * Per-prompt timeout in milliseconds. If the agent does not complete
   * its turn (i.e. `connection.prompt()` does not resolve) within this
   * window, the child process is killed and `sendPrompt` rejects.
   */
  timeoutMs: number;
}

/**
 * A single-use ACP session that sends one prompt and collects the response.
 *
 * This is a domain facade — it intentionally hides the underlying
 * {@link ClientSideConnection}, schema types, and streaming update
 * machinery so the rest of the pipeline does not need to know about ACP
 * internals.
 *
 * @see Requirements 1.4, 1.5, 1.7
 */
export interface AcpSession {
  /**
   * Send a prompt and collect the full text response. Resolves with the
   * concatenation of all `agent_message_chunk` text blocks streamed
   * during the turn.
   */
  sendPrompt(content: string): Promise<string>;
  /** Kill the child process and clean up. Safe to call multiple times. */
  destroy(): void;
}

// ── Implementation ──────────────────────────────────────────────────────

/** Package name/version reported in `clientInfo` during `initialize`. */
const CLIENT_NAME = 'kiro-learn';
const CLIENT_VERSION = '0.5.0';

/**
 * Spawn a `kiro-cli acp` process, wire its stdio to an ACP
 * {@link ClientSideConnection}, run the `initialize` + `newSession`
 * handshake, and return a session ready to accept a single prompt.
 *
 * The returned {@link AcpSession} is single-use: one `sendPrompt` call
 * per session. The caller MUST call `destroy()` when done (or on
 * error/timeout).
 *
 * @see Requirements 1.1, 1.2, 1.3, 1.8
 */
export async function createAcpSession(
  opts: AcpClientOptions,
): Promise<AcpSession> {
  const child: ChildProcess = spawn(
    'kiro-cli',
    ['acp', '--agent', opts.agentName],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  // The SDK's ndJsonStream expects Web Streams over Uint8Array. Node's
  // child stdio is Node streams, so we adapt via the built-in bridge.
  const input = Writable.toWeb(child.stdin!);
  const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  // Per-turn accumulator for streaming agent_message_chunk text.
  // Reset at the start of each sendPrompt call.
  let accumulated = '';

  /**
   * The minimal `Client` handler we expose to the SDK:
   *
   * - `sessionUpdate` accumulates text from `agent_message_chunk` updates.
   *   All other update kinds (`tool_call`, `plan`, `current_mode_update`,
   *   etc.) are silently ignored — the compressor agent has no tools and
   *   we don't surface progress.
   * - `requestPermission` returns `cancelled` as a defensive default.
   *   The compressor has no tools configured, so permission requests
   *   should never occur in practice.
   * - `extNotification` silently accepts any vendor-specific notification
   *   the agent emits (e.g. Kiro's `_kiro.dev/metadata`,
   *   `_kiro.dev/commands/available`, `_kiro.dev/subagent/list_update`).
   *   Without this handler the SDK logs a "Method not found" error for
   *   every vendor notification, which is noisy and misleading.
   */
  const clientHandler: Client = {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      if (
        params.update.sessionUpdate === 'agent_message_chunk' &&
        params.update.content.type === 'text'
      ) {
        accumulated += params.update.content.text;
      }
    },
    async requestPermission(
      _params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
      return { outcome: { outcome: 'cancelled' } };
    },
    async extNotification(
      _method: string,
      _params: Record<string, unknown>,
    ): Promise<void> {
      // Swallow vendor extensions (e.g. Kiro's `_kiro.dev/*` notifications).
      // We don't use any of them for extraction.
    },
  };

  const connection = new ClientSideConnection(() => clientHandler, stream);

  /**
   * Kill the child process. SIGTERM first, then SIGKILL after 2s if the
   * process has not exited. Safe to call multiple times; errors from
   * killing an already-dead process are swallowed.
   *
   * The 2-second SIGKILL is scheduled via `setTimeout`; on normal exit
   * we clear that timer so it does not keep the event loop alive.
   * A single `child.on('exit')` handler fires once per process lifetime
   * (Node guarantees `exit` emits exactly once) and cancels any pending
   * kill timer regardless of which path triggered exit — SIGTERM
   * acknowledged by the child, SIGKILL eventually landing, or the
   * child exiting on its own.
   *
   * @see Requirements 1.7
   */
  let killTimer: NodeJS.Timeout | null = null;
  child.on('exit', () => {
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  });

  function destroy(): void {
    // If the child has already exited (e.g. the ACP process crashed on
    // its own, or a previous destroy() already ran), skip both signals.
    // Both `exitCode` and `signalCode` start as `null` on a live child
    // and become non-null on exit. We treat `undefined` (observed only
    // in test doubles that don't emulate these fields) as "still alive"
    // so destroy remains safe against minimal mocks.
    const hasExited =
      (child.exitCode !== null && child.exitCode !== undefined) ||
      (child.signalCode !== null && child.signalCode !== undefined);
    if (hasExited) return;

    try {
      child.kill('SIGTERM');
    } catch {
      /* already dead */
    }

    // Only arm SIGKILL if one isn't already scheduled. Multiple destroy()
    // calls should not stack timers.
    if (killTimer === null) {
      killTimer = setTimeout(() => {
        killTimer = null;
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 2000);
    }
  }

  // ── Handshake ────────────────────────────────────────────────────────
  // Per ACP spec: initialize negotiates protocol version and capabilities;
  // newSession creates a session bound to a cwd and (possibly empty) set
  // of MCP servers. If either step fails we destroy the child and
  // re-throw so no process is leaked.
  //
  // @see Requirements 1.2, 1.3, 1.8
  let sessionId: string;
  try {
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });
    const sessionResult = await connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    sessionId = sessionResult.sessionId;
  } catch (err: unknown) {
    destroy();
    throw err instanceof Error ? err : new Error(String(err));
  }

  return {
    /**
     * Send a prompt and collect the full text response.
     *
     * Under ACP, streaming text arrives via `session/update` notifications
     * with `sessionUpdate === 'agent_message_chunk'` (handled above in
     * `clientHandler.sessionUpdate`). The `connection.prompt()` promise
     * resolves with a `PromptResponse` carrying a `stopReason` when the
     * agent's turn ends — that's our completion signal.
     *
     * We race the prompt against a timeout so a stuck agent can't hang
     * the pipeline.
     *
     * @see Requirements 1.4, 1.5, 1.6
     */
    async sendPrompt(content: string): Promise<string> {
      // Reset per-turn accumulator in case this session is reused.
      accumulated = '';

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          destroy();
          reject(
            new Error(
              `ACP session timed out after ${String(opts.timeoutMs)}ms`,
            ),
          );
        }, opts.timeoutMs);
      });

      try {
        await Promise.race([
          connection.prompt({
            sessionId,
            prompt: [{ type: 'text', text: content }],
          }),
          timeout,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      return accumulated;
    },

    destroy,
  };
}
