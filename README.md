# @cortexkit/opencode-interceptor

Local OpenCode plugin scaffold for the `/intercept` command family and safe, session-scoped provider dump capture.

## Current scope

This repository now ships the hardened S03 runtime contract without changing the user-facing command forms:

- `/intercept`
- `/intercept on`
- `/intercept off`

The plugin installs a single long-lived `globalThis.fetch` wrapper when it loads, refreshes active session context from OpenCode chat hooks, and keeps capture fail-open. If matching capture, serialization, dump writing, or startup cleanup fails, provider traffic still proceeds.

## Hardened runtime contract

### Matching and persistence

When interception is enabled, LLM provider traffic is detected by request body shape rather than URL. Any `POST` request with a JSON body containing a `messages` array is captured. The plugin distinguishes between Anthropic, OpenAI, and generic LLM request shapes.

Matching captures are written under temp storage only:

```text
/tmp/opencode-interceptor/<session-id>
```

Each captured request writes an ordered trio with a shared basename:

- `001-anthropic-<timestamp>.request.json`
- `001-anthropic-<timestamp>.response.json`
- `001-anthropic-<timestamp>.meta.json`

### Safety and redaction

Persisted artifacts are intentionally safe-by-default:

- request JSON bodies are recursively scrubbed for obvious secret-bearing keys such as `api_key`, `token`, `password`, `authorization`, and `secret_*`
- response JSON bodies, including HTTP-error payloads, are scrubbed through the same recursive redactor
- streamed SSE responses are persisted only as replay-friendly assistant text, not raw `event:` / `data:` frame payloads
- unsafe plain-text bodies are omitted instead of being written raw
- request headers are persisted with best-effort redaction (`authorization`, `x-api-key`, `cookie`, etc. are replaced with `[REDACTED]`)

### Startup retention cleanup

On plugin startup, the interceptor runs one best-effort cleanup pass over the fixed temp root:

```text
/tmp/opencode-interceptor
```

Cleanup behavior:

- only direct child session directories under that root are eligible for deletion
- only expired session directories are pruned (current retention window: 24 hours)
- fresh session directories stay in place
- unknown files, nested paths, and anything outside the interceptor root are not deleted
- cleanup failures remain non-fatal and surface as anomalies through `/intercept`

## `/intercept` summary contract

`/intercept` is the authoritative operator surface. The summary reports:

- `Enabled`
- `Dump root`
- `Captures`
- `Total bytes`
- `Anomalies`
- `Latest anomaly phase`
- `Latest anomaly message`

The anomaly surface is shared by capture-time and startup-cleanup failures. Example phases include:

- `capture/response-read`
- `capture/response-parse`
- `capture/dump-write`
- `cleanup/root-read`
- `cleanup/entry-stat`
- `cleanup/entry-delete`
- `cleanup/path-safety`

## Dump payload shape

`*.meta.json` records truthful byte accounting and request metadata:

- `timestamp`
- `url`
- `method`
- `status`
- `contentType`
- `durationMs`
- `requestBytes`
- `responseBytes`
- `capturedBytes`

`*.response.json` records one of the following safe body states:

- `empty`
- `json`
- `replay-text`
- `omitted`
- `read-error`

When the body is omitted or unreadable, the dump tells the truth through `bodyOmittedReason` or `bodyReadError` instead of inventing success.

## Load the plugin locally

1. Install dependencies:

   ```bash
   bun install
   ```

2. Add this plugin to your local OpenCode config as a file URL that points at this repo's entrypoint.

   Either load the TypeScript source directly (Bun compiles it at runtime — no build step needed for local dev):

   ```json
   {
     "plugin": [
       "file:///absolute/path/to/opencode-interceptor/src/index.ts"
     ]
   }
   ```

   Or, after running `bun run build`, load the compiled ESM bundle:

   ```json
   {
     "plugin": [
       "file:///absolute/path/to/opencode-interceptor/dist/index.js"
     ]
   }
   ```

   Example from this checkout:

   ```json
   {
     "plugin": [
       "file:///Users/ufukaltinok/Work/OSS/opencode-interceptor/src/index.ts"
     ]
   }
   ```

3. Start or restart OpenCode after updating the config.

Expected replies:

- `/intercept` → `## Interceptor Status`
- `/intercept on` → `## Interceptor Enabled`
- `/intercept off` → `## Interceptor Disabled`
- invalid forms such as `/intercept bogus` → `## Interceptor Usage`

## Verification

Use these commands as the authoritative verification flow:

```bash
bun test tests/e2e/serve-toggle-proof.test.ts
bun run check
```

Focused suites remain available when you need to localize a failure before rerunning the root gate:

```bash
bun test tests/e2e/serve-command.test.ts
bun test tests/e2e/serve-capture.test.ts
```

What each suite proves:

- `tests/e2e/serve-toggle-proof.test.ts` is the milestone-level assembly proof: one real `opencode serve` session stays inert while disabled, captures truthfully while enabled, and stops again after disable.
- `tests/e2e/serve-command.test.ts` isolates the `/intercept` command seam: status, toggles, repeated forms, malformed input handling, restart behavior, and missing-plugin/startup diagnostics.
- `tests/e2e/serve-capture.test.ts` is the hardening and negative-regression suite: startup cleanup, replay-text persistence, scrubbed HTTP-error capture, stalled providers, malformed event streams, and failure diagnostics.
- the unit suites keep the deny-by-default matcher, redaction, retention, and command-state contracts covered underneath the real-runtime proofs.
- `bun run check` remains the authoritative repo gate because it reruns lint, typecheck, and the entire test suite with the milestone proof included.

## Troubleshooting

If `/intercept` or dump capture does not behave truthfully:

1. Run the canonical milestone proof first: `bun test tests/e2e/serve-toggle-proof.test.ts`.
2. Inspect the failure output for:
   - `latestInterceptSummary=`
   - `dumpInspection=`
   - `mockRequests=`
   - `--- stdout ---`
   - `--- stderr ---`
3. Parse the reported `Dump root` from `/intercept` and inspect the request/response/meta trio files for that session.
4. Check `Enabled`, `Captures`, `Total bytes`, `Anomalies`, `Latest anomaly phase`, and `Latest anomaly message` in `/intercept` before assuming capture is silently broken.
5. If the failure looks command-specific, rerun `bun test tests/e2e/serve-command.test.ts`; if it looks like capture hardening or malformed-provider behavior, rerun `bun test tests/e2e/serve-capture.test.ts`.
6. After the focused proof is green again, rerun `bun run check` to confirm the repository-wide gate still passes.
7. Inspect the shared temp root (`/tmp/opencode-interceptor`) if you suspect stale artifacts or startup cleanup behavior.
8. Confirm the plugin path in OpenCode config still points at `src/index.ts` in this repo.
9. Confirm the `opencode` CLI is available on `PATH`, because the real-runtime proofs start `opencode serve` directly.

## Slice boundary

S03 establishes the hardened dump/runtime baseline: curated provider matching, scrubbed request/response artifacts, replay-text stream persistence, startup retention cleanup, and shared anomaly visibility through `/intercept`. S04 closes the milestone proof path by making `tests/e2e/serve-toggle-proof.test.ts` the canonical end-to-end verification surface while keeping `serve-command.test.ts` and `serve-capture.test.ts` as narrower diagnostic suites.
