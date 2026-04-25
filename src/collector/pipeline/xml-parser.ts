/**
 * XML Parser — extracts `<memory_record>` blocks from the compressor
 * agent's XML response text using regex-based parsing.
 *
 * The parser handles zero or more `<memory_record>` blocks per response,
 * validates the `type` attribute against allowed {@link ObservationType}
 * values, extracts child elements (`title`, `summary`, `facts`, `concepts`,
 * `files`), and XML-unescapes all text content.
 *
 * Also provides {@link isGarbageResponse} to detect conversational (non-XML)
 * output from the compressor, enabling the extraction stage's retry logic.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Component 3
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 4, 5
 */

// ── Regex patterns ──────────────────────────────────────────────────────

/** Matches `<memory_record type="...">...</memory_record>` blocks. */
const RECORD_RE =
  /<memory_record\s+type="([^"]+)">([\s\S]*?)<\/memory_record>/g;

/** Factory: matches all `<tag>...</tag>` occurrences for a given tag name. */
const TAG_RE = (tag: string): RegExp =>
  new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');

/** Factory: matches the first `<tag>...</tag>` occurrence for a given tag name. */
const SINGLE_TAG_RE = (tag: string): RegExp =>
  new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);

// ── Valid observation types ─────────────────────────────────────────────

const VALID_TYPES = new Set<string>([
  'tool_use',
  'decision',
  'error',
  'discovery',
  'pattern',
]);

// ── Public types ────────────────────────────────────────────────────────

/** The observation_type values the compressor may return. */
export type ObservationType =
  | 'tool_use'
  | 'decision'
  | 'error'
  | 'discovery'
  | 'pattern';

/**
 * Raw parsed fields from a single `<memory_record>` block.
 *
 * This is the intermediate representation before enrichment with
 * pipeline-managed fields (`record_id`, `namespace`, etc.).
 */
export interface RawMemoryFields {
  type: ObservationType;
  title: string;
  summary: string;
  facts: string[];
  concepts: string[];
  files: string[];
}

// ── XML unescape ────────────────────────────────────────────────────────

/**
 * Convert XML entity references back to their original characters.
 *
 * Order matters: `&amp;` must be replaced **last** to avoid prematurely
 * converting `&amp;lt;` → `&lt;` → `<`.
 *
 * @see Requirements 4.8
 */
export function unescapeXml(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Extract all `<tag>...</tag>` occurrences from `text`, returning an array
 * of trimmed, unescaped inner content. Empty inner content is skipped.
 */
function extractAll(text: string, tag: string): string[] {
  const results: string[] = [];
  const re = TAG_RE(tag);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const content = match[1]?.trim();
    if (content) results.push(unescapeXml(content));
  }
  return results;
}

/**
 * Extract the first `<tag>...</tag>` occurrence from `text`, returning the
 * trimmed, unescaped inner content. Returns empty string if not found or
 * if the inner content is empty after trimming.
 */
function extractOne(text: string, tag: string): string {
  const match = SINGLE_TAG_RE(tag).exec(text);
  return match?.[1]?.trim() ? unescapeXml(match[1].trim()) : '';
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Parse XML text containing zero or more `<memory_record>` blocks.
 *
 * Returns an array of raw parsed fields. Returns empty array for
 * empty/whitespace-only input (valid skip signal).
 *
 * Records with invalid `type` attributes, empty `title`, or empty
 * `summary` are silently skipped. Title is truncated to 200 chars and
 * summary to 4000 chars.
 *
 * @see Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8
 */
export function parseMemoryXml(text: string): RawMemoryFields[] {
  const records: RawMemoryFields[] = [];
  let match: RegExpExecArray | null;

  // Reset lastIndex for the global regex
  RECORD_RE.lastIndex = 0;

  while ((match = RECORD_RE.exec(text)) !== null) {
    const type = match[1]?.trim() ?? '';
    const body = match[2] ?? '';

    if (!VALID_TYPES.has(type)) continue;

    const title = extractOne(body, 'title');
    const summary = extractOne(body, 'summary');

    if (!title || !summary) continue;

    records.push({
      type: type as ObservationType,
      title: title.slice(0, 200),
      summary: summary.slice(0, 4000),
      facts: extractAll(body, 'fact'),
      concepts: extractAll(body, 'concept'),
      files: extractAll(body, 'file'),
    });
  }

  return records;
}

/**
 * Detect garbage output: non-empty text that contains no `<memory_record`
 * or `<skip` tags. Indicates the model responded conversationally.
 *
 * Returns `false` for empty/whitespace strings (valid skip signal).
 * Returns `false` for strings containing valid XML tags.
 * Returns `true` only when text is non-empty and contains no recognized tags.
 *
 * @see Requirements 5.1, 5.2, 5.3, 5.4
 */
export function isGarbageResponse(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    !/<memory_record/.test(trimmed) &&
    !/<skip/.test(trimmed)
  );
}
