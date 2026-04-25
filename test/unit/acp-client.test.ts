/**
 * Unit tests for the ACP client module.
 *
 * Our ACP client is a thin adapter over the official
 * `@agentclientprotocol/sdk`. These tests exercise the adapter's
 * behaviour — handshake orchestration, chunk accumulation, timeout,
 * and process cleanup — by mocking the SDK's `ClientSideConnection`
 * and `ndJsonStream` exports. We do not test the SDK itself.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Component 1
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirement 1
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AcpSession,
} from '../../src/collector/pipeline/acp-client.js';

// ── Test doubles ────────────────────────────────────────────────────────

/**
 * A fake child process that captures SIGTERM/SIGKILL calls and exposes
 * stdin/stdout/stderr streams. We only care about `kill` — the SDK
 * handles stdio via the mocked `ndJsonStream`.
 */
interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

let fakeChild: FakeChild;

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

/**
 * The mocked `ClientSideConnection`. Each test controls how
 * `initialize`, `newSession`, and `prompt` resolve. The `Client` handler
 * passed in by the adapter is captured so tests can drive
 * `sessionUpdate` notifications manually.
 */
interface MockConnection {
  initialize: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  clientHandler: {
    sessionUpdate: (params: unknown) => Promise<void>;
    requestPermission: (params: unknown) => Promise<unknown>;
  } | null;
}

let mockConnection: MockConnection;

// ── Mocks ───────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => fakeChild),
}));

vi.mock('@agentclientprotocol/sdk', () => ({
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn(() => ({
    writable: new WritableStream(),
    readable: new ReadableStream(),
  })),
  ClientSideConnection: vi.fn((toClient: (agent: unknown) => unknown) => {
    // Capture the Client handler the adapter passes in so tests can
    // drive sessionUpdate notifications.
    mockConnection.clientHandler = toClient({}) as MockConnection['clientHandler'];
    return {
      initialize: mockConnection.initialize,
      newSession: mockConnection.newSession,
      prompt: mockConnection.prompt,
    };
  }),
}));

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Create a session with a successful handshake. Returns the session plus
 * convenient references to the mocks for further assertions.
 */
async function createSession(
  opts = { agentName: 'test-agent', timeoutMs: 5000 },
): Promise<AcpSession> {
  mockConnection.initialize.mockResolvedValueOnce({
    protocolVersion: 1,
    agentCapabilities: {},
    authMethods: [],
  });
  mockConnection.newSession.mockResolvedValueOnce({ sessionId: 'sess-123' });

  const { createAcpSession } = await import(
    '../../src/collector/pipeline/acp-client.js'
  );
  return createAcpSession(opts);
}

/** Drive a streaming agent_message_chunk notification through the handler. */
async function emitChunk(text: string): Promise<void> {
  if (!mockConnection.clientHandler) {
    throw new Error('clientHandler not captured yet');
  }
  await mockConnection.clientHandler.sessionUpdate({
    sessionId: 'sess-123',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  });
}

// ── Lifecycle ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  fakeChild = createFakeChild();
  mockConnection = {
    initialize: vi.fn(),
    newSession: vi.fn(),
    prompt: vi.fn(),
    clientHandler: null,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('ACP Client — createAcpSession (handshake)', () => {
  /**
   * @see Requirements 1.1, 1.2, 1.3
   */
  it('performs initialize → newSession handshake and returns a session', async () => {
    const session = await createSession();

    expect(session).toBeDefined();
    expect(typeof session.sendPrompt).toBe('function');
    expect(typeof session.destroy).toBe('function');

    // Verify handshake calls were made with correct params
    expect(mockConnection.initialize).toHaveBeenCalledTimes(1);
    expect(mockConnection.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: expect.objectContaining({
          name: 'kiro-learn',
        }) as unknown,
      }),
    );

    expect(mockConnection.newSession).toHaveBeenCalledTimes(1);
    expect(mockConnection.newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: expect.any(String) as unknown,
        mcpServers: [],
      }),
    );

    session.destroy();
  });

  /**
   * @see Requirements 1.8
   */
  it('rejects and kills child process when initialize fails', async () => {
    mockConnection.initialize.mockRejectedValueOnce(
      new Error('Invalid request'),
    );

    const { createAcpSession } = await import(
      '../../src/collector/pipeline/acp-client.js'
    );

    await expect(
      createAcpSession({ agentName: 'test-agent', timeoutMs: 5000 }),
    ).rejects.toThrow('Invalid request');

    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
    // newSession should not have been called since initialize failed
    expect(mockConnection.newSession).not.toHaveBeenCalled();
  });

  /**
   * @see Requirements 1.8
   */
  it('rejects and kills child process when newSession fails', async () => {
    mockConnection.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [],
    });
    mockConnection.newSession.mockRejectedValueOnce(
      new Error('Session creation failed'),
    );

    const { createAcpSession } = await import(
      '../../src/collector/pipeline/acp-client.js'
    );

    await expect(
      createAcpSession({ agentName: 'test-agent', timeoutMs: 5000 }),
    ).rejects.toThrow('Session creation failed');

    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  /**
   * @see Requirements 1.1, 1.8
   *
   * If `kiro-cli` isn't on PATH (or fails to exec for any reason),
   * `spawn` returns a ChildProcess that asynchronously emits `error`.
   * Without a listener, Node would treat that as an unhandled error
   * event. We attach a listener that translates it into a rejection
   * on `childFailed`, which the handshake race surfaces as a thrown
   * error from `createAcpSession`.
   */
  it('rejects when the child process emits a spawn error', async () => {
    // Make initialize hang forever so the race is won by childFailed.
    mockConnection.initialize.mockImplementationOnce(
      () => new Promise(() => { /* never */ }),
    );

    const { createAcpSession } = await import(
      '../../src/collector/pipeline/acp-client.js'
    );

    const sessionPromise = createAcpSession({
      agentName: 'test-agent',
      timeoutMs: 5000,
    });

    // Let microtasks run so the handshake gets into Promise.race.
    await Promise.resolve();

    // Simulate a spawn/exec failure (e.g. kiro-cli not on PATH).
    fakeChild.emit('error', new Error('ENOENT: kiro-cli not found'));

    await expect(sessionPromise).rejects.toThrow(/failed to spawn/);
    await expect(sessionPromise).rejects.toThrow(/ENOENT/);
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  /**
   * @see Requirements 1.1, 1.8
   *
   * If the child process exits cleanly during the handshake (for
   * example because the agent name is invalid and kiro-cli prints
   * an error and terminates), the SDK call will never resolve —
   * its stdio pipe is closed. `childFailed` notices the exit and
   * surfaces it as a specific error rather than hanging forever.
   */
  it('rejects when the child process exits during the handshake', async () => {
    mockConnection.initialize.mockImplementationOnce(
      () => new Promise(() => { /* never */ }),
    );

    const { createAcpSession } = await import(
      '../../src/collector/pipeline/acp-client.js'
    );

    const sessionPromise = createAcpSession({
      agentName: 'test-agent',
      timeoutMs: 5000,
    });

    await Promise.resolve();

    // Simulate a premature exit (code 1, no signal).
    fakeChild.emit('exit', 1, null);

    await expect(sessionPromise).rejects.toThrow(/exited with code 1/);
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('ACP Client — sendPrompt', () => {
  /**
   * @see Requirements 1.4, 1.5
   */
  it('accumulates agent_message_chunk text and resolves when prompt() resolves', async () => {
    const session = await createSession();

    // The prompt promise resolves *after* chunks have been delivered.
    // We simulate this by making prompt() wait on a manually-controlled
    // promise, streaming chunks in between.
    let resolvePrompt!: (value: { stopReason: string }) => void;
    mockConnection.prompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }),
    );

    const promptPromise = session.sendPrompt('Hello, world!');

    // Let the sendPrompt microtask run so prompt() is invoked
    await Promise.resolve();

    // Stream some chunks via the captured Client handler
    await emitChunk('<memory_record ');
    await emitChunk('type="tool_use">');
    await emitChunk('</memory_record>');

    // Now resolve the prompt (turn ends)
    resolvePrompt({ stopReason: 'end_turn' });

    const result = await promptPromise;
    expect(result).toBe('<memory_record type="tool_use"></memory_record>');

    // Verify prompt was called with the correct shape
    expect(mockConnection.prompt).toHaveBeenCalledWith({
      sessionId: 'sess-123',
      prompt: [{ type: 'text', text: 'Hello, world!' }],
    });

    session.destroy();
  });

  /**
   * @see Requirements 1.4, 1.5
   */
  it('resolves with empty string when prompt completes with no chunks', async () => {
    const session = await createSession();

    mockConnection.prompt.mockResolvedValueOnce({ stopReason: 'end_turn' });

    const result = await session.sendPrompt('skip this');
    expect(result).toBe('');

    session.destroy();
  });

  /**
   * @see Requirements 1.9
   */
  it('ignores non-agent_message_chunk session updates', async () => {
    const session = await createSession();

    let resolvePrompt!: (value: { stopReason: string }) => void;
    mockConnection.prompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }),
    );

    const promptPromise = session.sendPrompt('anything');
    await Promise.resolve();

    // Send various update kinds that should be ignored
    await mockConnection.clientHandler!.sessionUpdate({
      sessionId: 'sess-123',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_001',
        title: 'ignored',
        kind: 'other',
        status: 'pending',
      },
    });
    await mockConnection.clientHandler!.sessionUpdate({
      sessionId: 'sess-123',
      update: { sessionUpdate: 'plan', entries: [] },
    });

    // Then one real chunk
    await emitChunk('only this counts');

    resolvePrompt({ stopReason: 'end_turn' });
    expect(await promptPromise).toBe('only this counts');

    session.destroy();
  });

  /**
   * @see Requirements 1.6
   */
  it('rejects with timeout error and kills child process when timeout expires', async () => {
    const session = await createSession({
      agentName: 'test-agent',
      timeoutMs: 3000,
    });

    // prompt() never resolves
    mockConnection.prompt.mockImplementationOnce(
      () => new Promise(() => { /* never resolves */ }),
    );

    const promptPromise = session.sendPrompt('slow prompt');

    // Let sendPrompt run
    await Promise.resolve();

    // Advance time past the timeout
    vi.advanceTimersByTime(3001);

    await expect(promptPromise).rejects.toThrow(
      'ACP session timed out after 3000ms',
    );

    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  /**
   * @see Requirements 1.6
   *
   * Without the childFailed race, a mid-turn child crash would stall
   * sendPrompt until the user-configured timeout (default 30s) fired.
   * With the race, the exit event surfaces immediately as a rejection,
   * keeping the extraction stage's retry loop snappy.
   */
  it('rejects quickly when the child process exits during a prompt turn', async () => {
    const session = await createSession({
      agentName: 'test-agent',
      timeoutMs: 30_000,
    });

    // prompt() never resolves on its own; only the child exit should end it.
    mockConnection.prompt.mockImplementationOnce(
      () => new Promise(() => { /* never */ }),
    );

    const promptPromise = session.sendPrompt('something');

    await Promise.resolve();

    // Simulate the child crashing mid-turn.
    fakeChild.emit('exit', null, 'SIGSEGV');

    // No timer advance — the rejection must come from the exit event,
    // not from the 30-second timeout.
    await expect(promptPromise).rejects.toThrow(
      /killed by signal SIGSEGV/,
    );
  });

  /**
   * Verify that each sendPrompt call resets the accumulator. Even though
   * the current architecture uses a session for exactly one prompt, the
   * reset guards against accidental reuse.
   */
  it('resets the accumulator on each sendPrompt call', async () => {
    const session = await createSession();

    // First turn
    let resolveFirst!: (value: { stopReason: string }) => void;
    mockConnection.prompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const firstPromise = session.sendPrompt('first');
    await Promise.resolve();
    await emitChunk('first-response');
    resolveFirst({ stopReason: 'end_turn' });
    expect(await firstPromise).toBe('first-response');

    // Second turn — accumulator should start fresh
    let resolveSecond!: (value: { stopReason: string }) => void;
    mockConnection.prompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
    const secondPromise = session.sendPrompt('second');
    await Promise.resolve();
    await emitChunk('second-response');
    resolveSecond({ stopReason: 'end_turn' });
    expect(await secondPromise).toBe('second-response');

    session.destroy();
  });
});

describe('ACP Client — destroy', () => {
  /**
   * @see Requirements 1.7
   */
  it('sends SIGTERM immediately and SIGKILL after 2 seconds', async () => {
    const session = await createSession();

    session.destroy();

    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(fakeChild.kill).not.toHaveBeenCalledWith('SIGKILL');

    vi.advanceTimersByTime(2000);

    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
  });

  /**
   * @see Requirements 1.7
   */
  it('does not throw when child process is already dead', async () => {
    const session = await createSession();

    fakeChild.kill.mockImplementation((signal: string) => {
      throw new Error(`Process already dead (tried ${signal})`);
    });

    expect(() => session.destroy()).not.toThrow();

    vi.advanceTimersByTime(2000);

    // SIGTERM + SIGKILL both attempted, both errors swallowed
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
  });

  /**
   * @see Requirements 1.7
   *
   * The 2-second SIGKILL fallback must be cancelled when the child
   * exits cleanly, otherwise the pending timer keeps the Node event
   * loop alive for up to 2s per extraction. With retries and
   * concurrency that adds up.
   */
  it('clears the pending SIGKILL timer when the child exits before 2s', async () => {
    const session = await createSession();

    session.destroy();
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');

    // Simulate the child exiting in response to SIGTERM before the
    // 2-second SIGKILL fallback fires.
    fakeChild.emit('exit', 0, null);

    vi.advanceTimersByTime(2000);

    // SIGKILL should NOT have been sent — the exit handler cancelled it.
    expect(fakeChild.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  /**
   * @see Requirements 1.7
   *
   * Guards against a regression where concurrent `destroy()` calls
   * would stack overlapping SIGKILL timers.
   */
  it('does not stack SIGKILL timers across repeated destroy() calls', async () => {
    const session = await createSession();

    session.destroy();
    session.destroy();
    session.destroy();

    // Three destroys, but only one pending timer — advancing time
    // should fire SIGKILL exactly once.
    vi.advanceTimersByTime(2000);

    const sigkillCalls = fakeChild.kill.mock.calls.filter(
      (c) => c[0] === 'SIGKILL',
    );
    expect(sigkillCalls).toHaveLength(1);
  });
});
