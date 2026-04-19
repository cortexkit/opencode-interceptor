# HTTP Interceptor Plugin — PRD

## Why this exists

When an LLM provider rejects a request, OpenCode only surfaces the provider's error message. The actual on-wire request body — what the provider actually saw — is invisible to both users and plugin developers.

During the April 2026 investigation into Claude Opus 4.7's "thinking blocks in the latest assistant message cannot be modified" error, we had to monkey-patch `globalThis.fetch` to dump the real body. That hack revealed that `@ai-sdk/anthropic`'s `groupIntoBlocks` was merging consecutive assistants in a way that violated Anthropic's thinking-block validation — a finding that would have been impossible to prove without inspecting the raw request.

This PRD formalizes that capability as a first-class opt-in debug plugin for opencode.

The package name will be @cortexkit/opencode-interceptor.

Our other plugins under @cortexkit are under ~/Work/OSS/opencode-magic-context and ~/Work/OSS/opencode-aft you can look at those plugins to get some information.




## Goals

- Let a user toggle HTTP capture at runtime, without restarting OpenCode.
- Dump raw request bodies to a known path, tagged by session and provider.
- Capture the response body (incl. 4xx/5xx errors) alongside the request so the pair is always diffable.
- Zero overhead when disabled (no wrapped fetch).
- Never capture headers or any field that can leak API keys / auth tokens.

## Non-goals

- Modifying requests in flight.
- Capturing streaming WS/SSE framing details (we capture the final assembled body OpenCode sends + the full SSE replay received).
- Providing a UI beyond a single slash command toggle. Users open captured files with their own tools.

## Command surface

A single built-in command with three forms:

```
/intercept on            # Enable capture; prints dump directory
/intercept off           # Disable capture; print summary (N dumps since enable, size)
/intercept        # Print current state + dump directory + how many dumps exist
```

Additional flags (optional, can ship in v1.1):

```
/intercept on --providers anthropic,openai     # Capture only specific hosts
/intercept on --max-size 5MB                   # Skip bodies over N bytes
/intercept on --redact                         # Placeholder: redact known token shapes in body text
```

## File layout

```
${tmpdir}/opencode-interceptor/
  <session-id>/
    001-anthropic-2026-04-18T10-23-39-248Z.request.json
    001-anthropic-2026-04-18T10-23-39-248Z.response.json
    002-anthropic-2026-04-18T10-24-01-123Z.request.json
    002-anthropic-2026-04-18T10-24-01-123Z.response.json
```

- Session ID comes from the plugin context / most recent active session at the time of the call. If no session is bound, files land under `unknown-session/`.
- Sequence prefix ensures files sort chronologically even when two requests share a second.
- `.request.json` is the raw body serialized to JSON (or text if body wasn't JSON).
- `.response.json` contains `{ status, statusText, body }`. For SSE streams we store the concatenated event stream text.
- A sidecar `meta.json` per pair records: timestamp, url, method (never headers), request body size, response status, content-type, duration_ms.

## Implementation

### Enable / disable at runtime

Use a single module-level flag read before each wrap:

```ts
// debug-intercept/state.ts
let enabled = false;
export const isInterceptEnabled = () => enabled;
export function setInterceptEnabled(v: boolean): void {
    enabled = v;
    if (v) wrapFetchOnce();
    // Note: we never unwrap. When disabled, the wrap is a 1-line no-op that
    // calls the original fetch. This avoids edge cases where the wrap is
    // re-applied after some other plugin also wraps fetch.
}
```

### fetch wrap

```ts
function wrapFetchOnce(): void {
    if (wrapped) return;
    wrapped = true;
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        if (!isInterceptEnabled()) return original(input, init);
        const url = resolveUrl(input);
        const method = resolveMethod(input, init);
        if (method !== 'POST' || !shouldCapture(url)) return original(input, init);
        const seq = nextSeq();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const dir = dumpDirForActiveSession();
        await writeRequestFile(dir, seq, ts, url, method, init?.body);
        const started = performance.now();
        const response = await original(input, init);
        await writeResponseFile(dir, seq, ts, url, response.clone(), started);
        return response;
    };
}
```

Three details matter:
- **`response.clone()`** — the app consumes the original stream; we consume the clone to write the dump. For SSE streams we accumulate text off the clone.
- **`performance.now()` duration** — sidecar `meta.json` gets `duration_ms` so slow-request triage is easy.
- **Never log `init.headers`**. This is not configurable. The Anthropic/OpenAI auth headers are the most likely leak vector.

### Hooking the command

Register `/intercept` in `getMagicContextBuiltinCommands()` (or a separate `debug-intercept/commands.ts` if we want to keep concerns isolated). The command handler:

1. Parses the first argument (`on` / `off` / `status`).
2. Calls `setInterceptEnabled()`.
3. Returns a `noReply` reply to the user summarizing state.

## Security

- **Never persist** inside the project repo. Always under `os.tmpdir()`.
- **Never log** any `Authorization`, `X-Api-Key`, `x-goog-api-key`, cookie headers, OR anything from `init.headers`.
- **Never include** `api_key`, `token`, `password` in body dumps. Implement a best-effort scrubber that walks the JSON and replaces those keys' values with `"[REDACTED]"` before write.
- **Expire dumps**. On plugin startup, delete any `opencode-intercept/` dump older than 7 days. This is a belt-and-suspenders defense against forgotten dumps containing customer data.

## Telemetry

- On `/intercept on` emit a single log line: `intercept: enabled, dir=<path>`.
- On each dump write: `intercept: captured seq=<N> url=<url> status=<code> size=<bytes>`.
- On `/intercept off` emit a summary: `intercept: disabled, captures=<N>, total_size=<bytes>, dir=<path>`.


## Testing

Unit tests:
- Toggle enable/disable leaves fetch working.
- When disabled, wrapped fetch does no filesystem I/O.
- Redaction scrubs known token shapes from body JSON.
- Response dump matches request dump sequence number.
- SSE response streams are correctly accumulated into the response file.

E2E test (in `packages/e2e-tests`):
- Enable interceptor, make a request through `streamText`, assert request+response dump files exist and parse as JSON.
- Disable interceptor, make another request, assert no new dump files were written.


