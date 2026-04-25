# Requirements Document

## Introduction

This document specifies the requirements for replacing the current JSON/`kiro-cli chat` extraction approach with an XML-based extraction pipeline using `kiro-cli acp` (Agent Client Protocol) over stdio. The new pipeline uses XML for both input framing (`<tool_observation>` tags) and output parsing (`<memory_record>` blocks), communicating over a clean JSON-RPC 2.0 transport with no terminal decoration. The change is scoped to the extraction stage of the collector pipeline — everything upstream (dedup, privacy scrub) and downstream (storage, retrieval) remains untouched.

### Implementation Evolution

An initial implementation hand-rolled the JSON-RPC 2.0 protocol layer (custom `JsonRpcRequest`/`JsonRpcResponse` types, bespoke readline-based message dispatch, guessed handshake params). During integration testing against a real `kiro-cli acp` process we discovered the guessed protocol did not match the actual ACP specification at several points:

- `initialize` requires a `protocolVersion`, `capabilities`, and `clientInfo` params object — not an empty `{}`.
- `session/new` requires `cwd` (absolute path) and `mcpServers` (an **array**, not an object) — not an empty `{}`.
- `session/prompt` requires a `sessionId` (returned by `session/new`) and a `prompt` field that is an **array of content blocks** (`[{ type: 'text', text: '...' }]`) — not a string.
- Streaming chunks arrive as `session/update` notifications with `params.update.sessionUpdate === "agent_message_chunk"` and text in `params.update.content.text` — not as `session/notification` with a `type: "AgentMessageChunk"` payload.
- Turn completion is signalled by the `session/prompt` **request response** resolving with `{ stopReason: "end_turn" }` — there is no separate `TurnEnd` notification.

Rather than maintain a hand-rolled protocol implementation that will drift from the spec as it evolves, the ACP_Client module SHALL use the official `@agentclientprotocol/sdk` npm package. The SDK provides `ClientSideConnection`, `ndJsonStream`, and generated TypeScript types for every ACP request/response/notification. This replaces our hand-rolled JSON-RPC plumbing with a spec-conformant, actively-maintained implementation.

## Glossary

- **ACP_SDK**: The official `@agentclientprotocol/sdk` npm package. Provides `ClientSideConnection` (the client-side protocol state machine), `ndJsonStream` (newline-delimited JSON stream over a Node `Readable`/`Writable` pair), and typed request/response schemas.
- **ACP_Client**: The module (`src/collector/pipeline/acp-client.ts`) that wraps the ACP_SDK. Spawns a `kiro-cli acp` child process, wires its stdio to an `ndJsonStream`, constructs a `ClientSideConnection`, runs the initialize + newSession handshake, and exposes a single-use `AcpSession` facade to the rest of the pipeline.
- **AcpSession**: The single-use session facade returned by `createAcpSession`. Exposes `sendPrompt(content: string): Promise<string>` and `destroy(): void`. Hides all ACP protocol details from the Extraction_Stage.
- **XML_Framer**: The module that converts a `KiroMemEvent` into a `<tool_observation>` XML string for the compressor agent.
- **XML_Parser**: The module that extracts `<memory_record>` blocks from the compressor agent's XML response text using regex-based parsing.
- **Extraction_Stage**: The pipeline stage that orchestrates event extraction by invoking the compressor agent via ACP, parsing the XML response, and storing the resulting memory records.
- **Compressor_Agent**: The `kiro-learn-compressor` agent configuration that instructs the LLM to produce structured XML memory records from tool observations.
- **Circuit_Breaker**: The retry mechanism that limits extraction attempts per event to a configurable maximum, preventing infinite retry loops on persistent failures.
- **Garbage_Response**: A non-empty compressor response that contains no `<memory_record>` or `<skip>` tags, indicating the model responded conversationally instead of with structured XML.
- **RawMemoryFields**: The intermediate parsed representation of a single `<memory_record>` block before enrichment with pipeline-managed fields.
- **ObservationType**: The classification of a memory record as one of: `tool_use`, `decision`, `error`, `discovery`, or `pattern`.

## Requirements

### Requirement 1: ACP Client Lifecycle Management

**User Story:** As a pipeline operator, I want the extraction stage to communicate with `kiro-cli` via the ACP protocol over stdio using the official SDK, so that extraction uses a clean, spec-conformant JSON-RPC 2.0 transport without ANSI decoration, conversational output parsing, or hand-rolled protocol code that drifts from the spec.

#### Acceptance Criteria

1. WHEN `createAcpSession` is called, THE ACP_Client SHALL spawn a `kiro-cli acp --agent <agentName>` child process with stdin, stdout, and stderr pipes
2. WHEN the child process is spawned, THE ACP_Client SHALL wrap its stdout/stdin in an `ndJsonStream` from the ACP_SDK and construct a `ClientSideConnection` with a `Client` handler that processes incoming `session/update` notifications
3. WHEN the `ClientSideConnection` is constructed, THE ACP_Client SHALL call `connection.initialize({ protocolVersion: 1, capabilities: {}, clientInfo: { name, version } })` and wait for the response, then call `connection.newSession({ cwd: absolutePath, mcpServers: [] })` and capture the returned `sessionId`
4. WHEN `sendPrompt` is called, THE ACP_Client SHALL call `connection.prompt({ sessionId, prompt: [{ type: 'text', text: content }] })`, accumulating text from `session/update` notifications whose `update.sessionUpdate === 'agent_message_chunk'` via the `Client.sessionUpdate` handler
5. WHEN the `connection.prompt` promise resolves with a `PromptResponse`, THE ACP_Client SHALL resolve the `sendPrompt` promise with the accumulated text from all `agent_message_chunk` updates received during that turn
6. IF the `connection.prompt` promise does not resolve within `timeoutMs` milliseconds, THEN THE ACP_Client SHALL kill the child process and reject `sendPrompt` with a timeout error
7. WHEN `destroy` is called, THE ACP_Client SHALL send SIGTERM to the child process and send SIGKILL after 2 seconds if the process has not exited
8. IF the `initialize` or `newSession` call rejects, THEN THE ACP_Client SHALL reject the `createAcpSession` promise and leave no child process running
9. THE ACP_Client SHALL ignore `session/update` notifications whose `update.sessionUpdate` is not `agent_message_chunk` (e.g. `tool_call`, `tool_call_update`, `plan`) since the compressor agent has no tools configured
10. THE ACP_Client SHALL implement a minimal `Client` interface per the ACP_SDK contract — `sessionUpdate` accumulates chunks, and `requestPermission` returns `{ outcome: 'denied' }` (defensive: the compressor agent has no tools, so permission requests are not expected)

### Requirement 2: XML Input Framing

**User Story:** As a pipeline developer, I want events to be framed as `<tool_observation>` XML before being sent to the compressor, so that the compressor receives structured input in a deterministic format.

#### Acceptance Criteria

1. WHEN `frameEvent` is called with a `KiroMemEvent`, THE XML_Framer SHALL return a string starting with `<tool_observation>` and ending with `</tool_observation>`
2. THE XML_Framer SHALL always include `<tool_name>`, `<timestamp>`, and `<input>` elements in the output
3. WHEN the event body type is `json` and contains a `tool_name` field, THE XML_Framer SHALL use the structured `tool_name`, `tool_input`, and `tool_response` fields directly
4. WHEN the event body type is `text`, THE XML_Framer SHALL wrap the entire content as the `<input>` element
5. WHEN the event body type is `message`, THE XML_Framer SHALL concatenate all turns as the `<input>` element
6. THE XML_Framer SHALL XML-escape all text content using entity references for `<`, `>`, `&`, `"`, and `'` characters
7. WHEN the event body contains a `tool_response` field, THE XML_Framer SHALL include an `<output>` element in the result

### Requirement 3: XML Escape and Unescape

**User Story:** As a pipeline developer, I want XML special characters to be properly escaped and unescaped, so that event content survives the XML round-trip without corruption or injection.

#### Acceptance Criteria

1. WHEN `escapeXml` is called with any string, THE XML_Framer SHALL replace all occurrences of `<`, `>`, `&`, `"`, and `'` with their corresponding XML entity references
2. WHEN `escapeXml` is called, THE XML_Framer SHALL produce output containing zero raw `<`, `>`, `&`, `"`, or `'` characters that were present in the input
3. FOR ALL strings that do not contain XML entity references, applying `escapeXml` then `unescapeXml` SHALL produce the original string (round-trip property)

### Requirement 4: XML Output Parsing

**User Story:** As a pipeline developer, I want the compressor's XML response to be parsed into structured memory record fields, so that extraction produces validated data for storage.

#### Acceptance Criteria

1. WHEN `parseMemoryXml` is called with text containing N well-formed `<memory_record>` blocks with valid `type` attributes and non-empty `title` and `summary`, THE XML_Parser SHALL return exactly N `RawMemoryFields` objects
2. THE XML_Parser SHALL extract `type`, `title`, `summary`, `facts`, `concepts`, and `files` from each `<memory_record>` block
3. THE XML_Parser SHALL validate the `type` attribute against the allowed ObservationType values: `tool_use`, `decision`, `error`, `discovery`, `pattern`
4. IF a `<memory_record>` block has an invalid `type` attribute, THEN THE XML_Parser SHALL skip that block
5. IF a `<memory_record>` block has an empty `title` or empty `summary`, THEN THE XML_Parser SHALL skip that block
6. WHEN the `<title>` content exceeds 200 characters, THE XML_Parser SHALL truncate the value to 200 characters
7. WHEN the `<summary>` content exceeds 4000 characters, THE XML_Parser SHALL truncate the value to 4000 characters
8. THE XML_Parser SHALL XML-unescape all extracted text content, converting entity references back to their original characters

### Requirement 5: Empty and Garbage Response Handling

**User Story:** As a pipeline operator, I want the parser to distinguish between valid skip signals, garbage responses, and valid XML, so that the extraction stage can retry on garbage and skip gracefully on empty responses.

#### Acceptance Criteria

1. WHEN `parseMemoryXml` is called with an empty or whitespace-only string, THE XML_Parser SHALL return an empty array
2. WHEN `isGarbageResponse` is called with a non-empty string that contains neither `<memory_record` nor `<skip`, THE XML_Parser SHALL return `true`
3. WHEN `isGarbageResponse` is called with a string containing `<memory_record` or `<skip`, THE XML_Parser SHALL return `false`
4. WHEN `isGarbageResponse` is called with an empty or whitespace-only string, THE XML_Parser SHALL return `false`

### Requirement 6: Extraction Stage with ACP and Circuit Breaker

**User Story:** As a pipeline operator, I want the extraction stage to use ACP-based XML extraction with retry logic, so that transient failures and garbage responses are handled gracefully without infinite loops.

#### Acceptance Criteria

1. WHEN an event is extracted, THE Extraction_Stage SHALL frame the event as XML via `frameEvent`, create an ACP session, send the XML prompt, and parse the response via `parseMemoryXml`
2. WHEN the compressor returns a Garbage_Response, THE Extraction_Stage SHALL retry extraction up to `maxRetries` times
3. IF all retry attempts are exhausted, THEN THE Extraction_Stage SHALL log a warning and skip the event without crashing the pipeline
4. WHEN extraction succeeds with one or more parsed records, THE Extraction_Stage SHALL enrich each record with `record_id`, `namespace`, `strategy`, `source_event_ids`, and `created_at` fields and store via `putMemoryRecord`
5. WHEN the compressor returns multiple `<memory_record>` blocks for a single event, THE Extraction_Stage SHALL generate unique record IDs for each record
6. THE Extraction_Stage SHALL destroy the ACP session in a `finally` block regardless of success, failure, or timeout
7. THE Extraction_Stage SHALL accept a `maxRetries` configuration option with a default value of 3
8. WHEN an ACP session times out or encounters a transient error, THE Extraction_Stage SHALL retry the extraction using a new ACP session

### Requirement 7: Compressor Agent XML Prompt

**User Story:** As a pipeline operator, I want the compressor agent to be configured with an XML-based prompt, so that it produces structured `<memory_record>` XML output instead of JSON.

#### Acceptance Criteria

1. THE Compressor_Agent prompt SHALL instruct the model to accept `<tool_observation>` XML input and respond with `<memory_record>` XML output
2. THE Compressor_Agent prompt SHALL specify the allowed `type` attribute values: `tool_use`, `decision`, `error`, `discovery`, `pattern`
3. THE Compressor_Agent prompt SHALL specify the required child elements: `title`, `summary`, `facts/fact`, `concepts/concept`, `files/file`
4. THE Compressor_Agent prompt SHALL instruct the model that empty responses are valid skip signals
5. THE Compressor_Agent prompt SHALL instruct the model to produce only XML with no prose, markdown, or explanation

### Requirement 8: MemoryRecord Schema Extension

**User Story:** As a pipeline developer, I want the MemoryRecord schema to include `concepts`, `files_touched`, and `observation_type` fields, so that the richer data from XML extraction is stored and available for retrieval.

#### Acceptance Criteria

1. THE MemoryRecordSchema SHALL include a required `concepts` field as an array of strings with each element having a minimum length of 1 and maximum length of 100
2. THE MemoryRecordSchema SHALL include a required `files_touched` field as an array of strings with each element having a minimum length of 1 and maximum length of 500
3. THE MemoryRecordSchema SHALL include a required `observation_type` field as an enum of `tool_use`, `decision`, `error`, `discovery`, `pattern`

### Requirement 9: Modularity Boundaries

**User Story:** As a maintainer, I want the new pipeline modules to respect strict import boundaries, so that the pipeline remains decoupled from storage internals and the installer.

#### Acceptance Criteria

1. THE ACP_Client module SHALL import only from `node:child_process`, `node:stream`, and `@agentclientprotocol/sdk`, and SHALL NOT import from `src/collector/storage/`
2. THE XML_Framer module SHALL import only from `src/types/` and SHALL NOT import from `src/collector/storage/`
3. THE XML_Parser module SHALL import only from `src/types/` and SHALL NOT import from `src/collector/storage/`
4. THE ACP_SDK (`@agentclientprotocol/sdk`) SHALL be a runtime dependency in `package.json`, pinned to an exact version (not a range), so protocol behavior is reproducible across installs
