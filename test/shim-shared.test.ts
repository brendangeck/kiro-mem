/**
 * Unit tests for the shared shim module (`src/shim/shared/index.ts`).
 *
 * This file covers `loadConfig` (task 4.1). Subsequent tasks (4.2–4.5)
 * add session management, buildEvent, truncateBody, and postEvent tests.
 *
 * Validates: Requirements 9.1, 9.2, 9.3
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpDir,
  };
});

// Import after mock declaration so vitest intercepts the module.
const {
  loadConfig,
  DEFAULT_SHIM_CONFIG,
  sessionFilePath,
  createSession,
  readSession,
  buildEvent,
  truncateBody,
  postEvent,
} = await import('../src/shim/shared/index.js');

const { parseEvent, ULID_RE } = await import('../src/types/index.js');

// ── loadConfig ──────────────────────────────────────────────────────────

describe('loadConfig', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kiro-learn-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when settings file does not exist', () => {
    /**
     * Validates: Requirements 9.1, 9.3
     *
     * When ~/.kiro-learn/settings.json is missing, loadConfig returns
     * DEFAULT_SHIM_CONFIG unchanged.
     */
    const config = loadConfig();

    expect(config).toEqual(DEFAULT_SHIM_CONFIG);
    expect(config.collectorHost).toBe('127.0.0.1');
    expect(config.collectorPort).toBe(21100);
    expect(config.timeoutMs).toBe(2000);
    expect(config.maxBodyBytes).toBe(524_288);
  });

  it('merges partial overrides from settings file', () => {
    /**
     * Validates: Requirements 9.2, 9.4
     *
     * When the settings file provides some keys, those override defaults
     * while unspecified keys retain their default values.
     */
    const settingsDir = join(tmpDir, '.kiro-learn');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, 'settings.json'),
      JSON.stringify({
        collector: { port: 9999 },
        shim: { timeoutMs: 5000 },
      }),
      'utf8',
    );

    const config = loadConfig();

    expect(config.collectorPort).toBe(9999);
    expect(config.timeoutMs).toBe(5000);
    // Unspecified keys keep defaults
    expect(config.collectorHost).toBe('127.0.0.1');
    expect(config.maxBodyBytes).toBe(524_288);
  });

  it('returns defaults when settings file contains invalid JSON', () => {
    /**
     * Validates: Requirements 9.3
     *
     * When the settings file exists but contains unparseable content,
     * loadConfig falls back to defaults without throwing.
     */
    const settingsDir = join(tmpDir, '.kiro-learn');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, 'settings.json'),
      'this is not valid json {{{',
      'utf8',
    );

    const config = loadConfig();

    expect(config).toEqual(DEFAULT_SHIM_CONFIG);
  });
});

// ── session management ──────────────────────────────────────────────────

describe('session management', () => {
  /**
   * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.6
   *
   * Session functions use `realpathSync` internally, so `cwd` must point
   * to a real directory. We create a fresh temp dir per test and track
   * any session files written to /tmp so they can be cleaned up.
   */

  let cwdDir: string;
  const sessionFiles: string[] = [];

  beforeEach(() => {
    cwdDir = mkdtempSync(join(tmpdir(), 'kiro-learn-session-test-'));
  });

  afterEach(() => {
    // Clean up the temp cwd directory
    rmSync(cwdDir, { recursive: true, force: true });

    // Clean up any session files created in /tmp
    for (const f of sessionFiles) {
      try {
        unlinkSync(f);
      } catch {
        // already removed or never created — fine
      }
    }
    sessionFiles.length = 0;
  });

  /** Helper: track a session file path for cleanup. */
  function tracked(cwd: string): string {
    const p = sessionFilePath(cwd);
    sessionFiles.push(p);
    return p;
  }

  it('createSession writes UUID to expected path and returns it', () => {
    /**
     * Validates: Requirements 2.1, 2.2
     *
     * createSession generates a UUID, writes it to the session file
     * derived from cwd, and returns the same UUID.
     */
    const filePath = tracked(cwdDir);
    const id = createSession(cwdDir);

    // Returned value is a valid UUID v4 shape
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // The file on disk contains exactly that UUID
    const ondisk = readFileSync(filePath, 'utf8');
    expect(ondisk).toBe(id);
  });

  it('readSession returns the UUID written by createSession', () => {
    /**
     * Validates: Requirements 2.2, 2.3
     *
     * After createSession writes a session ID, readSession for the same
     * cwd returns the identical value.
     */
    tracked(cwdDir);
    const written = createSession(cwdDir);
    const read = readSession(cwdDir);

    expect(read).toBe(written);
  });

  it('readSession generates fallback UUID when session file is missing', () => {
    /**
     * Validates: Requirements 2.4
     *
     * When no session file exists for the given cwd, readSession creates
     * a fallback UUID, writes it, and returns it.
     */
    const filePath = tracked(cwdDir);
    const id = readSession(cwdDir);

    // Should be a valid UUID
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // The fallback should have been persisted
    const ondisk = readFileSync(filePath, 'utf8');
    expect(ondisk).toBe(id);

    // A second read returns the same fallback (not a new one)
    expect(readSession(cwdDir)).toBe(id);
  });

  it('sessionFilePath produces deterministic path from cwd', () => {
    /**
     * Validates: Requirements 2.2, 2.6
     *
     * Calling sessionFilePath twice with the same cwd returns the same
     * path, and the path matches the expected /tmp/kiro-learn-session-<hash>
     * pattern.
     */
    const p1 = sessionFilePath(cwdDir);
    const p2 = sessionFilePath(cwdDir);

    expect(p1).toBe(p2);
    expect(p1).toMatch(/^\/tmp\/kiro-learn-session-[0-9a-f]{16}$/);
  });

  it('sessionFilePath resolves symlinks before hashing', () => {
    /**
     * Validates: Requirements 2.6
     *
     * A symlink pointing to a real directory should produce the same
     * session file path as the real directory itself, because
     * sessionFilePath resolves via realpathSync before hashing.
     */
    const link = join(cwdDir, 'symlink-to-self');
    symlinkSync(cwdDir, link);

    const fromReal = sessionFilePath(cwdDir);
    const fromLink = sessionFilePath(link);

    expect(fromLink).toBe(fromReal);
  });
});

// ── buildEvent ──────────────────────────────────────────────────────────

describe('buildEvent', () => {
  /**
   * Validates: Requirements 3.1, 3.3, 3.4, 3.7, 8.3
   *
   * `buildEvent` calls `realpathSync(cwd)` internally, so `cwd` must
   * point to a real directory. We reuse the tmpDir pattern from session
   * management tests.
   */

  let cwdDir: string;

  beforeEach(() => {
    cwdDir = mkdtempSync(join(tmpdir(), 'kiro-learn-build-event-test-'));
  });

  afterEach(() => {
    rmSync(cwdDir, { recursive: true, force: true });
  });

  it('produced event passes parseEvent validation', () => {
    /**
     * Validates: Requirements 3.1, 3.3
     *
     * A buildEvent result must be a valid KiroMemEvent as defined by the
     * Zod EventSchema. parseEvent throws on any schema violation.
     */
    const event = buildEvent({
      kind: 'prompt',
      body: { type: 'text', content: 'hello world' },
      sessionId: 'test-session-id',
      cwd: cwdDir,
    });

    // Should not throw — the event is schema-compliant.
    expect(() => parseEvent(event)).not.toThrow();
  });

  it('namespace matches expected /actor/<user>/project/<sha256>/ pattern', () => {
    /**
     * Validates: Requirements 3.4, 8.3
     *
     * The namespace must follow the AgentCore convention:
     * /actor/<actor_id>/project/<project_id>/ where project_id is a
     * 64-char hex SHA-256 digest of the resolved cwd.
     */
    const event = buildEvent({
      kind: 'note',
      body: { type: 'text', content: 'session started' },
      sessionId: 'sess-1',
      cwd: cwdDir,
    });

    expect(event.namespace).toMatch(
      /^\/actor\/[^/]+\/project\/[0-9a-f]{64}\/$/,
    );
  });

  it('event_id matches ULID regex', () => {
    /**
     * Validates: Requirements 3.1
     *
     * event_id must be a valid ULID — 26 Crockford base32 characters.
     */
    const event = buildEvent({
      kind: 'prompt',
      body: { type: 'text', content: 'test' },
      sessionId: 'sess-2',
      cwd: cwdDir,
    });

    expect(event.event_id).toMatch(ULID_RE);
  });

  it('source.surface is kiro-cli', () => {
    /**
     * Validates: Requirements 3.7
     *
     * The shim always sets source.surface to 'kiro-cli'.
     */
    const event = buildEvent({
      kind: 'tool_use',
      body: {
        type: 'json',
        data: { tool_name: 'fs_read', tool_input: {}, tool_response: {} },
      },
      sessionId: 'sess-3',
      cwd: cwdDir,
    });

    expect(event.source.surface).toBe('kiro-cli');
  });

  it('parent_event_id is omitted when undefined', () => {
    /**
     * Validates: Requirements 3.1
     *
     * When parentEventId is not provided, the resulting event object must
     * not contain the parent_event_id key at all (not even as undefined),
     * to satisfy exactOptionalPropertyTypes.
     */
    const event = buildEvent({
      kind: 'note',
      body: { type: 'text', content: 'no parent' },
      sessionId: 'sess-4',
      cwd: cwdDir,
    });

    expect('parent_event_id' in event).toBe(false);
  });
});

// ── truncateBody ────────────────────────────────────────────────────────

describe('truncateBody', () => {
  /**
   * Validates: Requirements 10.1, 10.2, 10.3, 10.4
   *
   * `truncateBody` is a pure function — no filesystem or network needed.
   * The truncation marker is ' [truncated by kiro-learn]' (26 bytes).
   */

  const MARKER = ' [truncated by kiro-learn]';

  it('returns body unchanged when under budget', () => {
    /**
     * Validates: Requirements 10.1
     *
     * When the serialized body fits within maxBytes, truncateBody returns
     * the original body object unchanged.
     */
    const body = { type: 'text' as const, content: 'hello world' };
    const maxBytes = 1024; // well over the ~35 bytes of the serialized body

    const result = truncateBody(body, maxBytes);

    expect(result).toEqual(body);
  });

  it('truncates text body content and appends marker', () => {
    /**
     * Validates: Requirements 10.2, 10.4
     *
     * When a text body exceeds maxBytes, the content is trimmed and the
     * truncation marker is appended.
     */
    const longContent = 'x'.repeat(10_000);
    const body = { type: 'text' as const, content: longContent };
    const maxBytes = 200;

    const result = truncateBody(body, maxBytes);

    expect(result.type).toBe('text');
    expect(result).toHaveProperty('content');
    const content = (result as { type: 'text'; content: string }).content;
    expect(content.endsWith(MARKER)).toBe(true);
    expect(content.length).toBeLessThan(longContent.length);
  });

  it('truncates json body tool_response.result first, preserving tool_name and tool_input', () => {
    /**
     * Validates: Requirements 10.3
     *
     * For json bodies with a string tool_response.result, truncation
     * targets that field first while preserving tool_name and tool_input.
     */
    const toolName = 'fs_read';
    const toolInput = { path: '/some/file.ts' };
    const largeResult = 'R'.repeat(10_000);
    const body = {
      type: 'json' as const,
      data: {
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: { success: true, result: largeResult },
      },
    };
    const maxBytes = 300;

    const result = truncateBody(body, maxBytes);

    expect(result.type).toBe('json');
    const data = (result as { type: 'json'; data: Record<string, unknown> })
      .data as {
      tool_name: string;
      tool_input: Record<string, unknown>;
      tool_response: { result: string };
    };
    expect(data.tool_name).toBe(toolName);
    expect(data.tool_input).toEqual(toolInput);
    expect(data.tool_response.result.endsWith(MARKER)).toBe(true);
    expect(data.tool_response.result.length).toBeLessThan(largeResult.length);
  });

  it('truncated body type matches original body type', () => {
    /**
     * Validates: Requirements 10.2, 10.3, 10.4
     *
     * Truncation never changes the body variant — the type field is
     * preserved for all body types.
     */
    const maxBytes = 100;

    const textBody = { type: 'text' as const, content: 'a'.repeat(5_000) };
    expect(truncateBody(textBody, maxBytes).type).toBe('text');

    const jsonBody = {
      type: 'json' as const,
      data: {
        tool_name: 'test',
        tool_input: {},
        tool_response: { result: 'b'.repeat(5_000) },
      },
    };
    expect(truncateBody(jsonBody, maxBytes).type).toBe('json');
  });

  it('truncated body serialized size is within budget (plus marker)', () => {
    /**
     * Validates: Requirements 10.1, 10.2, 10.3
     *
     * After truncation, the serialized body size must be ≤ maxBytes + 26
     * (the marker length). This holds for both text and json body types.
     */
    const maxBytes = 256;
    const markerLen = Buffer.byteLength(MARKER, 'utf8'); // 26

    // text body
    const textBody = { type: 'text' as const, content: 'z'.repeat(10_000) };
    const textResult = truncateBody(textBody, maxBytes);
    const textSize = Buffer.byteLength(JSON.stringify(textResult), 'utf8');
    expect(textSize).toBeLessThanOrEqual(maxBytes + markerLen);

    // json body with string tool_response.result
    const jsonBody = {
      type: 'json' as const,
      data: {
        tool_name: 'read',
        tool_input: {},
        tool_response: { result: 'q'.repeat(10_000) },
      },
    };
    const jsonResult = truncateBody(jsonBody, maxBytes);
    const jsonSize = Buffer.byteLength(JSON.stringify(jsonResult), 'utf8');
    expect(jsonSize).toBeLessThanOrEqual(maxBytes + markerLen);
  });
});

// ── postEvent ───────────────────────────────────────────────────────────

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { makeValidEvent } from './fixtures.js';
import type { ShimConfig } from '../src/shim/shared/index.js';
import type { AddressInfo } from 'node:net';

describe('postEvent', () => {
  /**
   * Validates: Requirements 5.1, 5.2, 5.3, 5.5, 5.6, 5.7
   *
   * Uses a local HTTP server to verify request shape and response handling.
   * Each test starts its own server on a random port and tears it down
   * after the test completes.
   */

  /** Build a ShimConfig pointing at the given port. */
  function configForPort(port: number, timeoutMs = 2000): ShimConfig {
    return {
      ...DEFAULT_SHIM_CONFIG,
      collectorPort: port,
      timeoutMs,
    };
  }

  /** Start a server, return it and its port. Caller must close. */
  function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        resolve({ server, port });
      });
    });
  }

  /** Close a server, swallowing errors. */
  function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  it('sends POST with correct path, headers, and body', async () => {
    /**
     * Validates: Requirements 5.1, 5.3
     *
     * The request must be a POST to /v1/events with Content-Type
     * application/json and the JSON-serialized event as the body.
     */
    let capturedMethod = '';
    let capturedPath = '';
    let capturedContentType = '';
    let capturedBody = '';

    const { server, port } = await startServer((req, res) => {
      capturedMethod = req.method ?? '';
      capturedPath = req.url ?? '';
      capturedContentType = req.headers['content-type'] ?? '';

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        capturedBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ event_id: 'test-id', stored: true }));
      });
    });

    try {
      const event = makeValidEvent();
      await postEvent(event, { retrieve: false }, configForPort(port));

      expect(capturedMethod).toBe('POST');
      expect(capturedPath).toBe('/v1/events');
      expect(capturedContentType).toBe('application/json');
      expect(JSON.parse(capturedBody)).toEqual(event);
    } finally {
      await closeServer(server);
    }
  });

  it('appends ?retrieve=true when opts.retrieve is true', async () => {
    /**
     * Validates: Requirements 5.2
     *
     * When retrieve is true, the request path must include the query
     * parameter ?retrieve=true.
     */
    let capturedPath = '';

    const { server, port } = await startServer((req, res) => {
      capturedPath = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ event_id: 'test-id', stored: true }));
    });

    try {
      const event = makeValidEvent();
      await postEvent(event, { retrieve: true }, configForPort(port));

      expect(capturedPath).toBe('/v1/events?retrieve=true');
    } finally {
      await closeServer(server);
    }
  });

  it('returns null on connection refused (no stderr crash)', async () => {
    /**
     * Validates: Requirements 5.6
     *
     * When the collector is unreachable (nothing listening on the port),
     * postEvent returns null without throwing.
     */
    const event = makeValidEvent();

    // Use a port that nothing is listening on. Port 1 is almost certainly
    // unused and will trigger ECONNREFUSED on 127.0.0.1.
    const result = await postEvent(
      event,
      { retrieve: false },
      configForPort(1),
    );

    expect(result).toBeNull();
  });

  it('returns null on timeout', async () => {
    /**
     * Validates: Requirements 5.5
     *
     * When the server never responds within the timeout window,
     * postEvent returns null.
     */
    const { server, port } = await startServer((_req, _res) => {
      // Intentionally never respond — let the timeout fire.
    });

    try {
      const event = makeValidEvent();
      const result = await postEvent(
        event,
        { retrieve: false },
        configForPort(port, 50), // 50ms timeout
      );

      expect(result).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('returns null on non-2xx response', async () => {
    /**
     * Validates: Requirements 5.7
     *
     * When the collector returns a non-2xx status code, postEvent
     * returns null.
     */
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    });

    try {
      const event = makeValidEvent();
      const result = await postEvent(
        event,
        { retrieve: false },
        configForPort(port),
      );

      expect(result).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('returns parsed EventIngestResponse on success', async () => {
    /**
     * Validates: Requirements 5.1, 5.7
     *
     * When the collector returns 200 with a valid JSON body, postEvent
     * returns the parsed EventIngestResponse.
     */
    const responsePayload = {
      event_id: '01JF8ZS4Y00000000000000000',
      stored: true,
      retrieval: {
        context: 'Prior observations about auth module...',
        records: ['mr_01JF8ZS4Z00000000000000000'],
        latency_ms: 42,
      },
    };

    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    });

    try {
      const event = makeValidEvent();
      const result = await postEvent(
        event,
        { retrieve: true },
        configForPort(port),
      );

      expect(result).toEqual(responsePayload);
      expect(result!.event_id).toBe('01JF8ZS4Y00000000000000000');
      expect(result!.stored).toBe(true);
      expect(result!.retrieval).toBeDefined();
      expect(result!.retrieval!.context).toBe(
        'Prior observations about auth module...',
      );
      expect(result!.retrieval!.records).toEqual([
        'mr_01JF8ZS4Z00000000000000000',
      ]);
      expect(result!.retrieval!.latency_ms).toBe(42);
    } finally {
      await closeServer(server);
    }
  });
});
