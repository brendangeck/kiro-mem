/**
 * Fast-check arbitraries for the kiro-learn wire contract.
 *
 * These generators produce values that satisfy the Zod schemas in
 * `src/types/schemas.ts`. They are used by property-based tests to exercise
 * `parseEvent` / `parseMemoryRecord` and (in later tasks) the SQLite backend.
 *
 * Every generator here is the **positive** side of the schema: the output is
 * always valid. Tests that need invalid inputs mutate the output afterwards.
 *
 * @see .kiro/specs/event-schema-and-storage/design.md § Zod Schemas
 * @see .kiro/specs/event-schema-and-storage/requirements.md § Requirement 2
 */

import fc from 'fast-check';

import type { KiroMemEvent, MemoryRecord } from '../src/types/schemas.js';

/** Crockford base32 alphabet used in ULIDs (no I, L, O, U). */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_ALPHABET_LEN = ULID_ALPHABET.length;

/** Lowercase hex digits for sha256 content hashes. */
const HEX_ALPHABET = '0123456789abcdef';
const HEX_ALPHABET_LEN = HEX_ALPHABET.length;

/**
 * Arbitrary 26-character Crockford base32 ULID matching `ULID_RE`.
 *
 * Implemented by picking 26 indices into the explicit alphabet rather than
 * relying on `fc.stringMatching`, to keep the generator deterministic and
 * dependency-free.
 */
export function ulidArb(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0, max: ULID_ALPHABET_LEN - 1 }), {
      minLength: 26,
      maxLength: 26,
    })
    .map((indices) => {
      let out = '';
      for (const i of indices) {
        // `noUncheckedIndexedAccess` makes this `string | undefined`; the
        // generator bounds guarantee it is defined, but we guard to keep
        // the type-checker honest.
        const ch = ULID_ALPHABET[i];
        if (ch === undefined) {
          throw new Error(`ulidArb: alphabet index out of range: ${String(i)}`);
        }
        out += ch;
      }
      return out;
    });
}

/** Arbitrary `mr_<ULID>` record id matching `RECORD_ID_RE`. */
export function recordIdArb(): fc.Arbitrary<string> {
  return ulidArb().map((ulid) => `mr_${ulid}`);
}

/**
 * Arbitrary non-empty segment for `namespace`. No `/`, printable ASCII, and
 * small so the full namespace stays readable in test output.
 */
function namespaceSegmentArb(): fc.Arbitrary<string> {
  return fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => s.length > 0 && !s.includes('/'));
}

/**
 * Arbitrary namespace of the form `/actor/{actor}/project/{project}/`
 * matching `NAMESPACE_RE`.
 */
export function namespaceArb(): fc.Arbitrary<string> {
  return fc
    .tuple(namespaceSegmentArb(), namespaceSegmentArb())
    .map(([actor, project]) => `/actor/${actor}/project/${project}/`);
}

/**
 * Arbitrary ISO-8601 timestamp with offset (`Z`) accepted by
 * `z.string().datetime({ offset: true })`. Bounded to a plausible decade so
 * shrinking stays useful.
 */
export function isoDateArb(): fc.Arbitrary<string> {
  return fc
    .date({
      min: new Date('2020-01-01T00:00:00Z'),
      max: new Date('2030-01-01T00:00:00Z'),
      noInvalidDate: true,
    })
    .map((d) => d.toISOString());
}

/** Arbitrary `EventSource` value. */
export function eventSourceArb(): fc.Arbitrary<{
  surface: 'kiro-cli' | 'kiro-ide';
  version: string;
  client_id: string;
}> {
  return fc.record({
    surface: fc.constantFrom('kiro-cli' as const, 'kiro-ide' as const),
    version: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.length > 0),
    client_id: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.length > 0),
  });
}

/** Arbitrary text body. Content is capped well below the 1 MiB schema limit. */
function textBodyArb(): fc.Arbitrary<{ type: 'text'; content: string }> {
  return fc.record({
    type: fc.constant('text' as const),
    content: fc.string({ maxLength: 1000 }),
  });
}

/** Arbitrary message body: 1–5 role/content turns. */
function messageBodyArb(): fc.Arbitrary<{
  type: 'message';
  turns: Array<{ role: string; content: string }>;
}> {
  return fc.record({
    type: fc.constant('message' as const),
    turns: fc.array(
      fc.record({
        role: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.length > 0),
        content: fc.string({ maxLength: 500 }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
  });
}

/**
 * Arbitrary json body. `data` is any JSON-representable value.
 *
 * `fc.jsonValue()` may yield `-0`, which the wire contract cannot
 * preserve: `JSON.stringify(-0)` is `'0'`, so a round-trip through the
 * SQLite backend (which serialises `body` via `JSON.stringify` and
 * deserialises via `JSON.parse`) returns `0`, not `-0`. That breaks the
 * P1 round-trip property (`test/sqlite-backend.property.test.ts`) on the
 * occasional iteration where fast-check shrinks into a `-0` leaf.
 *
 * We normalise `-0` → `0` post-generation to sidestep the issue. This
 * matches the actual on-wire behaviour: every other caller on the write
 * path (collector pipeline, storage backend, enrichment) observes the
 * `JSON.stringify` normalisation too, so fixing the generator — rather
 * than relaxing the property — keeps both ends of the contract honest.
 */
function jsonBodyArb(): fc.Arbitrary<{ type: 'json'; data: unknown }> {
  return fc.record({
    type: fc.constant('json' as const),
    data: fc.jsonValue().map(normaliseJsonValue),
  });
}

/**
 * Recursively replace `-0` with `0` inside a JSON-representable value so
 * the output matches what `JSON.parse(JSON.stringify(value))` would
 * produce. No other transformations — every other value JSON can encode
 * round-trips unchanged.
 */
function normaliseJsonValue(value: unknown): unknown {
  if (typeof value === 'number' && Object.is(value, -0)) {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.map(normaliseJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => [k, normaliseJsonValue(v)] as const,
    );
    return Object.fromEntries(entries);
  }
  return value;
}

/** Arbitrary `EventBody` across all three variants. */
export function eventBodyArb(): fc.Arbitrary<
  | { type: 'text'; content: string }
  | { type: 'message'; turns: Array<{ role: string; content: string }> }
  | { type: 'json'; data: unknown }
> {
  return fc.oneof(textBodyArb(), messageBodyArb(), jsonBodyArb());
}

/** Arbitrary `sha256:<64-hex>` content hash matching `CONTENT_HASH_RE`. */
export function contentHashArb(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0, max: HEX_ALPHABET_LEN - 1 }), {
      minLength: 64,
      maxLength: 64,
    })
    .map((indices) => {
      let hex = '';
      for (const i of indices) {
        const ch = HEX_ALPHABET[i];
        if (ch === undefined) {
          throw new Error(`contentHashArb: hex index out of range: ${String(i)}`);
        }
        hex += ch;
      }
      return `sha256:${hex}`;
    });
}

/** Arbitrary non-empty id string (≤ 128 chars) for `session_id` / `actor_id`. */
function boundedIdArb(): fc.Arbitrary<string> {
  return fc.string({ minLength: 1, maxLength: 128 }).filter((s) => s.length > 0);
}

/** Arbitrary `EventKind`. */
function kindArb(): fc.Arbitrary<KiroMemEvent['kind']> {
  return fc.constantFrom(
    'prompt' as const,
    'tool_use' as const,
    'session_summary' as const,
    'note' as const,
  );
}

/**
 * Arbitrary valid `KiroMemEvent`.
 *
 * Produces events both with and without `parent_event_id` and `content_hash`
 * so `fc.option` handles the optionality. Optional fields are added to the
 * output only when they are defined, so the shape satisfies the
 * `exactOptionalPropertyTypes` rule in tsconfig.
 */
export function arbitraryEvent(): fc.Arbitrary<KiroMemEvent> {
  return fc
    .record({
      event_id: ulidArb(),
      parent_event_id: fc.option(ulidArb(), { nil: undefined }),
      session_id: boundedIdArb(),
      actor_id: boundedIdArb(),
      namespace: namespaceArb(),
      kind: kindArb(),
      body: eventBodyArb(),
      valid_time: isoDateArb(),
      source: eventSourceArb(),
      content_hash: fc.option(contentHashArb(), { nil: undefined }),
    })
    .map((r) => {
      const e: KiroMemEvent = {
        event_id: r.event_id,
        session_id: r.session_id,
        actor_id: r.actor_id,
        namespace: r.namespace,
        schema_version: 1,
        kind: r.kind,
        body: r.body,
        valid_time: r.valid_time,
        source: r.source,
      };
      if (r.parent_event_id !== undefined) {
        return { ...e, parent_event_id: r.parent_event_id };
      }
      return e;
    })
    .chain((e) =>
      // Second `chain` step attaches `content_hash` conditionally so the
      // final object only carries the key when a value was generated. This
      // preserves `exactOptionalPropertyTypes` compliance.
      fc.option(contentHashArb(), { nil: undefined }).map((hash) =>
        hash === undefined ? e : { ...e, content_hash: hash },
      ),
    );
}

/** Arbitrary non-empty bounded strategy name. */
function strategyArb(): fc.Arbitrary<string> {
  return fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.length > 0);
}

/**
 * Arbitrary valid `MemoryRecord`. Exported so the PBT in task 2.6 can reuse
 * it. Not required for task 2.3 but lives here to keep all arbitraries in one
 * module.
 */
export function arbitraryMemoryRecord(): fc.Arbitrary<MemoryRecord> {
  return fc.record({
    record_id: recordIdArb(),
    namespace: namespaceArb(),
    strategy: strategyArb(),
    title: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.length > 0),
    summary: fc.string({ minLength: 1, maxLength: 4000 }).filter((s) => s.length > 0),
    facts: fc.array(
      fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.length > 0),
      { minLength: 0, maxLength: 10 },
    ),
    source_event_ids: fc.array(ulidArb(), { minLength: 1, maxLength: 5 }),
    created_at: isoDateArb(),
  });
}

// ── Private-span generators (Task 2.6) ─────────────────────────────────

/**
 * Arbitrary string containing `<private>...</private>` spans.
 *
 * Generates three variants:
 * - **simple**: `<private>secret</private>`
 * - **nested**: `<private>outer <private>inner</private> more</private>`
 * - **unclosed**: `<private>secret with no close tag`
 *
 * The inner content and surrounding text are arbitrary strings that never
 * contain the literal `<private>` or `</private>` substrings themselves,
 * so the injected tags are the only ones present.
 */
function privateSpanArb(): fc.Arbitrary<string> {
  /** Safe content that does not contain private tags. */
  const safeStr = fc
    .string({ maxLength: 50 })
    .map((s) => s.replace(/<\/?private>/g, ''));

  const simple = fc
    .tuple(safeStr, safeStr, safeStr)
    .map(([before, secret, after]) => `${before}<private>${secret}</private>${after}`);

  const nested = fc
    .tuple(safeStr, safeStr, safeStr, safeStr)
    .map(
      ([before, outer, inner, after]) =>
        `${before}<private>${outer}<private>${inner}</private>${outer}</private>${after}`,
    );

  const unclosed = fc
    .tuple(safeStr, safeStr)
    .map(([before, secret]) => `${before}<private>${secret}`);

  return fc.oneof(simple, nested, unclosed);
}

/**
 * Arbitrary text body with `<private>` spans injected into `content`.
 */
function textBodyWithPrivateArb(): fc.Arbitrary<{ type: 'text'; content: string }> {
  return fc.record({
    type: fc.constant('text' as const),
    content: privateSpanArb(),
  });
}

/**
 * Arbitrary message body with `<private>` spans injected into at least one
 * turn's `content`.
 */
function messageBodyWithPrivateArb(): fc.Arbitrary<{
  type: 'message';
  turns: Array<{ role: string; content: string }>;
}> {
  return fc.record({
    type: fc.constant('message' as const),
    turns: fc.array(
      fc.record({
        role: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.length > 0),
        content: privateSpanArb(),
      }),
      { minLength: 1, maxLength: 5 },
    ),
  });
}

/**
 * Arbitrary json body with `<private>` spans injected into string values.
 *
 * Generates a small object/array tree where every string leaf contains a
 * private span, ensuring the recursive walk is exercised.
 */
function jsonBodyWithPrivateArb(): fc.Arbitrary<{ type: 'json'; data: unknown }> {
  // Build a small JSON-like tree where string leaves contain private spans.
  const leaf = privateSpanArb();
  const jsonData: fc.Arbitrary<unknown> = fc.oneof(
    leaf,
    fc.array(leaf, { minLength: 1, maxLength: 3 }),
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.length > 0),
      leaf,
      { minKeys: 1, maxKeys: 3 },
    ),
  );

  return fc.record({
    type: fc.constant('json' as const),
    data: jsonData,
  });
}

/** Arbitrary `EventBody` with `<private>` spans across all three variants. */
function eventBodyWithPrivateArb(): fc.Arbitrary<
  | { type: 'text'; content: string }
  | { type: 'message'; turns: Array<{ role: string; content: string }> }
  | { type: 'json'; data: unknown }
> {
  return fc.oneof(
    textBodyWithPrivateArb(),
    messageBodyWithPrivateArb(),
    jsonBodyWithPrivateArb(),
  );
}

/**
 * Arbitrary valid `KiroMemEvent` with `<private>...</private>` spans
 * injected into the body content.
 *
 * Uses {@link arbitraryEvent} as a structural base and replaces the body
 * with one that contains private spans (simple, nested, or unclosed) for
 * all three body types (`text`, `message`, `json`).
 *
 * @see .kiro/specs/collector-pipeline/design.md § Property 1
 * @see .kiro/specs/collector-pipeline/tasks.md § Task 2.6
 */
export function arbitraryEventWithPrivateSpans(): fc.Arbitrary<KiroMemEvent> {
  return arbitraryEvent().chain((event) =>
    eventBodyWithPrivateArb().map((body) => ({ ...event, body })),
  );
}

// ── Clean-event generator (Task 2.9) ───────────────────────────────────

/**
 * Strip all occurrences of `<private>` from a string so it is guaranteed
 * clean. Also strips `</private>` for completeness.
 */
function stripPrivateTags(s: string): string {
  return s.replace(/<\/?private>/g, '');
}

/**
 * Recursively strip `<private>` / `</private>` substrings from every
 * string leaf inside a JSON-representable value.
 */
function stripPrivateFromJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return stripPrivateTags(value);
  }
  if (Array.isArray(value)) {
    return value.map(stripPrivateFromJson);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => [k, stripPrivateFromJson(v)] as const,
    );
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Arbitrary valid `KiroMemEvent` whose body contains **no** occurrence of
 * the substring `<private>`. Built from {@link arbitraryEvent} with a
 * `.map()` pass that strips any accidental `<private>` / `</private>`
 * substrings from generated string fields.
 *
 * @see .kiro/specs/collector-pipeline/design.md § Property 4
 * @see .kiro/specs/collector-pipeline/tasks.md § Task 2.9
 */
export function arbitraryCleanEvent(): fc.Arbitrary<KiroMemEvent> {
  return arbitraryEvent().map((event) => {
    const body = event.body;
    let cleanBody: KiroMemEvent['body'];

    switch (body.type) {
      case 'text': {
        cleanBody = { ...body, content: stripPrivateTags(body.content) };
        break;
      }
      case 'message': {
        cleanBody = {
          ...body,
          turns: body.turns.map((turn) => ({
            ...turn,
            content: stripPrivateTags(turn.content),
          })),
        };
        break;
      }
      case 'json': {
        cleanBody = { ...body, data: stripPrivateFromJson(body.data) };
        break;
      }
    }

    return { ...event, body: cleanBody };
  });
}
