import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { buildInterceptDumpBasename } from "../../src/intercept/dump";
import { installInterceptFetch } from "../../src/intercept/fetch";
import { INTERCEPT_REDACTED_VALUE } from "../../src/intercept/redact";
import {
    clearActiveInterceptSession,
    getInterceptDumpRoot,
    getInterceptStateSnapshot,
    resetInterceptState,
    setActiveInterceptSession,
    setInterceptEnabled,
} from "../../src/intercept/state";

const REAL_FETCH = globalThis.fetch;
const TEST_PATHS = new Set<string>();

function toMockFetch(
    fetchLike: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
    return Object.assign(fetchLike, {
        preconnect: REAL_FETCH.preconnect,
    }) as typeof globalThis.fetch;
}

function cleanupPath(path: string) {
    TEST_PATHS.add(path);
}

function readJson(path: string) {
    return JSON.parse(readFileSync(path, "utf8"));
}

function buildAnthropicBody(prompt: string, extra: Record<string, unknown> = {}) {
    return {
        model: "mock-sonnet",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 64,
        ...extra,
    };
}

function buildAnthropicInit(prompt: string): RequestInit {
    return {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify(buildAnthropicBody(prompt)),
    };
}

function buildAnthropicInitWithBody(
    body: Record<string, unknown>,
    headers: HeadersInit = {},
): RequestInit {
    return {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...headers,
        },
        body: JSON.stringify(body),
    };
}

function buildAnthropicEventStreamText(text: string): string {
    return [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"mock-sonnet","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: message_stop\ndata: {"type":"message_stop"}',
        "",
    ].join("\n\n");
}

beforeEach(() => {
    resetInterceptState();
    globalThis.fetch = REAL_FETCH;
});

afterEach(() => {
    resetInterceptState();
    globalThis.fetch = REAL_FETCH;

    for (const path of TEST_PATHS) {
        rmSync(path, { recursive: true, force: true });
    }
    TEST_PATHS.clear();
});

describe("fetch interception core", () => {
    test("installInterceptFetch wraps global fetch only once and disabled mode does no filesystem work", async () => {
        const sessionRoot = getInterceptDumpRoot("unit-disabled");
        cleanupPath(sessionRoot);

        let originalCalls = 0;
        globalThis.fetch = toMockFetch(async () => {
            originalCalls += 1;
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: {
                    "content-type": "application/json",
                },
            });
        });

        const firstInstall = installInterceptFetch();
        const secondInstall = installInterceptFetch();

        expect(firstInstall).toBe(secondInstall);
        expect(globalThis.fetch).toBe(firstInstall);
        expect(getInterceptStateSnapshot().wrappedFetchInstalled).toBe(true);

        await globalThis.fetch("http://127.0.0.1:4010/v1/messages", buildAnthropicInit("disabled"));

        expect(originalCalls).toBe(1);
        expect(existsSync(sessionRoot)).toBe(false);
        expect(getInterceptStateSnapshot().captureCount).toBe(0);
        expect(getInterceptStateSnapshot().totalBytes).toBe(0);
        expect(getInterceptStateSnapshot().anomalyCount).toBe(0);
        expect(getInterceptStateSnapshot().latestAnomaly).toBeNull();
    });

    test("matching JSON requests write ordered trio files and truthful aggregate counters", async () => {
        const sessionId = `unit-session-${Date.now()}`;
        const sessionRoot = getInterceptDumpRoot(sessionId);
        cleanupPath(sessionRoot);

        const responses = [
            { id: "resp-1", text: "hello" },
            { id: "resp-2", text: "goodbye" },
        ];
        let callIndex = 0;
        let timestampIndex = 0;

        globalThis.fetch = toMockFetch(async () => {
            const responseBody = JSON.stringify(responses[callIndex] ?? responses.at(-1));
            callIndex += 1;
            return new Response(responseBody, {
                status: 200,
                headers: {
                    "content-type": "application/json",
                },
            });
        });

        installInterceptFetch({
            now: () => 100,
            timestamp: () => `2026-04-19T06:00:0${++timestampIndex}.000Z`,
        });

        setActiveInterceptSession(sessionId);
        setInterceptEnabled(true);

        await globalThis.fetch("http://127.0.0.1:4010/v1/messages", buildAnthropicInit("first"));
        await globalThis.fetch("http://127.0.0.1:4010/v1/messages", buildAnthropicInit("second"));

        const filenames = (await readdir(sessionRoot)).sort();
        expect(filenames).toHaveLength(6);
        expect(filenames[0]).toStartWith("001-anthropic-");
        expect(filenames[3]).toStartWith("002-anthropic-");

        const firstBase = filenames[0].replace(/\.(request|response|meta)\.json$/, "");
        const secondBase = filenames[3].replace(/\.(request|response|meta)\.json$/, "");

        expect(filenames.slice(0, 3)).toEqual([
            `${firstBase}.meta.json`,
            `${firstBase}.request.json`,
            `${firstBase}.response.json`,
        ]);
        expect(filenames.slice(3, 6)).toEqual([
            `${secondBase}.meta.json`,
            `${secondBase}.request.json`,
            `${secondBase}.response.json`,
        ]);

        const firstRequest = readJson(`${sessionRoot}/${firstBase}.request.json`);
        const firstResponse = readJson(`${sessionRoot}/${firstBase}.response.json`);
        const firstMeta = readJson(`${sessionRoot}/${firstBase}.meta.json`);
        const secondMeta = readJson(`${sessionRoot}/${secondBase}.meta.json`);

        expect(firstRequest).toEqual(buildAnthropicBody("first"));
        expect(firstResponse.status).toBe(200);
        expect(firstResponse.body).toEqual(responses[0]);
        expect(firstResponse.bodyFormat).toBe("json");
        expect(firstResponse.bodyReadError).toBeNull();
        expect(firstResponse.bodyOmittedReason).toBeNull();
        expect(firstMeta).toMatchObject({
            timestamp: "2026-04-19T06:00:01.000Z",
            url: "http://127.0.0.1:4010/v1/messages",
            method: "POST",
            status: 200,
            contentType: "application/json",
            durationMs: 0,
        });
        expect(secondMeta.timestamp).toBe("2026-04-19T06:00:02.000Z");

        const firstRequestBytes = Buffer.byteLength(JSON.stringify(buildAnthropicBody("first")));
        const firstResponseBytes = Buffer.byteLength(JSON.stringify(responses[0]));
        const secondRequestBytes = Buffer.byteLength(JSON.stringify(buildAnthropicBody("second")));
        const secondResponseBytes = Buffer.byteLength(JSON.stringify(responses[1]));
        const expectedTotalBytes =
            firstRequestBytes + firstResponseBytes + secondRequestBytes + secondResponseBytes;

        expect(firstMeta.requestBytes).toBe(firstRequestBytes);
        expect(firstMeta.responseBytes).toBe(firstResponseBytes);
        expect(firstMeta.capturedBytes).toBe(firstRequestBytes + firstResponseBytes);
        expect(getInterceptStateSnapshot()).toMatchObject({
            enabled: true,
            activeSessionId: sessionId,
            captureCount: 2,
            totalBytes: expectedTotalBytes,
            anomalyCount: 0,
            latestAnomaly: null,
            sessionSequenceById: {
                [sessionId]: 2,
            },
        });
    });

    test("streaming responses persist replay text instead of raw SSE frames", async () => {
        const sessionId = `unit-stream-${Date.now()}`;
        const sessionRoot = getInterceptDumpRoot(sessionId);
        cleanupPath(sessionRoot);
        const responseText = buildAnthropicEventStreamText("hello from stream");

        globalThis.fetch = toMockFetch(async () => {
            return new Response(responseText, {
                status: 200,
                headers: {
                    "content-type": "text/event-stream",
                },
            });
        });

        installInterceptFetch({
            now: () => 0,
            timestamp: () => "2026-04-19T06:03:00.000Z",
        });
        setActiveInterceptSession(sessionId);
        setInterceptEnabled(true);

        await globalThis.fetch("http://127.0.0.1:4010/v1/messages", buildAnthropicInit("stream"));

        const filenames = (await readdir(sessionRoot)).sort();
        const base = filenames[0].replace(/\.(request|response|meta)\.json$/, "");
        const responseDump = readJson(`${sessionRoot}/${base}.response.json`);
        const metaDump = readJson(`${sessionRoot}/${base}.meta.json`);

        expect(responseDump).toEqual({
            status: 200,
            statusText: "",
            body: "hello from stream",
            bodyFormat: "replay-text",
            bodyReadError: null,
            bodyOmittedReason: null,
        });
        expect(JSON.stringify(responseDump)).not.toContain("event:");
        expect(JSON.stringify(responseDump)).not.toContain("data:");
        expect(metaDump.responseBytes).toBe(Buffer.byteLength(responseText));
        expect(getInterceptStateSnapshot().anomalyCount).toBe(0);
    });

    test("JSON error responses stay diffable after recursive scrubbing", async () => {
        const sessionId = `unit-json-error-${Date.now()}`;
        const sessionRoot = getInterceptDumpRoot(sessionId);
        cleanupPath(sessionRoot);
        const errorBody = {
            error: {
                type: "provider_error",
                api_key: "resp-secret",
                nested: {
                    token: "nested-secret",
                    keep: "visible",
                },
            },
        };

        globalThis.fetch = toMockFetch(async () => {
            return new Response(JSON.stringify(errorBody), {
                status: 503,
                headers: {
                    "content-type": "application/json",
                },
            });
        });

        installInterceptFetch({
            now: () => 0,
            timestamp: () => "2026-04-19T06:04:00.000Z",
        });
        setActiveInterceptSession(sessionId);
        setInterceptEnabled(true);

        await globalThis.fetch(
            "http://127.0.0.1:4010/v1/messages",
            buildAnthropicInit("json error"),
        );

        const filenames = (await readdir(sessionRoot)).sort();
        const base = filenames[0].replace(/\.(request|response|meta)\.json$/, "");
        const responseDump = readJson(`${sessionRoot}/${base}.response.json`);
        const metaDump = readJson(`${sessionRoot}/${base}.meta.json`);

        expect(responseDump).toEqual({
            status: 503,
            statusText: "",
            body: {
                error: {
                    type: "provider_error",
                    api_key: INTERCEPT_REDACTED_VALUE,
                    nested: {
                        token: INTERCEPT_REDACTED_VALUE,
                        keep: "visible",
                    },
                },
            },
            bodyFormat: "json",
            bodyReadError: null,
            bodyOmittedReason: null,
        });
        expect(JSON.stringify(responseDump)).not.toContain("resp-secret");
        expect(JSON.stringify(responseDump)).not.toContain("nested-secret");
        expect(metaDump.status).toBe(503);
        expect(metaDump.responseBytes).toBe(Buffer.byteLength(JSON.stringify(errorBody)));
        expect(getInterceptStateSnapshot().anomalyCount).toBe(0);
    });

    test("non-JSON text responses are omitted instead of persisting raw unsafe text", async () => {
        const sessionId = `unit-text-omit-${Date.now()}`;
        const sessionRoot = getInterceptDumpRoot(sessionId);
        cleanupPath(sessionRoot);
        const responseText = "token=plain-text-secret";

        globalThis.fetch = toMockFetch(async () => {
            return new Response(responseText, {
                status: 500,
                headers: {
                    "content-type": "text/plain",
                },
            });
        });

        installInterceptFetch({
            now: () => 0,
            timestamp: () => "2026-04-19T06:05:00.000Z",
        });
        setActiveInterceptSession(sessionId);
        setInterceptEnabled(true);

        await globalThis.fetch(
            "http://127.0.0.1:4010/v1/messages",
            buildAnthropicInit("plain text"),
        );

        const filenames = (await readdir(sessionRoot)).sort();
        const base = filenames[0].replace(/\.(request|response|meta)\.json$/, "");
        const responseDump = readJson(`${sessionRoot}/${base}.response.json`);
        const metaDump = readJson(`${sessionRoot}/${base}.meta.json`);

        expect(responseDump).toEqual({
            status: 500,
            statusText: "",
            body: null,
            bodyFormat: "omitted",
            bodyReadError: null,
            bodyOmittedReason: "unsupported-text-response",
        });
        expect(JSON.stringify(responseDump)).not.toContain("plain-text-secret");
        expect(metaDump.responseBytes).toBe(Buffer.byteLength(responseText));
        expect(getInterceptStateSnapshot().anomalyCount).toBe(0);
    });

    test("missing active session falls back to unknown-session and per-session sequencing stays isolated", async () => {
        const unknownRoot = getInterceptDumpRoot();
        const namedRoot = getInterceptDumpRoot("unit-named-session");
        cleanupPath(unknownRoot);
        cleanupPath(namedRoot);

        globalThis.fetch = toMockFetch(async () => {
            return new Response(JSON.stringify({ ok: true }), {
                status: 201,
                headers: {
                    "content-type": "application/json",
                },
            });
        });

        installInterceptFetch({
            now: () => 0,
            timestamp: () => "2026-04-19T06:06:00.000Z",
        });
        setInterceptEnabled(true);

        clearActiveInterceptSession();
        await globalThis.fetch("http://127.0.0.1:4010/v1/messages", buildAnthropicInit("unknown"));

        setActiveInterceptSession("unit-named-session");
        await globalThis.fetch("http://127.0.0.1:4010/v1/messages", buildAnthropicInit("named"));

        const unknownFiles = (await readdir(unknownRoot)).sort();
        const namedFiles = (await readdir(namedRoot)).sort();

        expect(unknownFiles).toHaveLength(3);
        expect(namedFiles).toHaveLength(3);
        expect(unknownFiles[0]).toStartWith("001-anthropic-");
        expect(namedFiles[0]).toStartWith("001-anthropic-");
        expect(getInterceptStateSnapshot().sessionSequenceById).toEqual({
            "unknown-session": 1,
            "unit-named-session": 1,
        });
    });

    test("unsupported methods, unmatched urls, and malformed requests fail open without capture", async () => {
        const sessionRoot = getInterceptDumpRoot("unit-fail-open");
        cleanupPath(sessionRoot);

        const seenInputs: Array<RequestInfo | URL> = [];
        globalThis.fetch = toMockFetch(async (input) => {
            seenInputs.push(input);
            return new Response("fallback", {
                status: 202,
                headers: {
                    "content-type": "text/plain",
                },
            });
        });

        installInterceptFetch();
        setActiveInterceptSession("unit-fail-open");
        setInterceptEnabled(true);

        await globalThis.fetch("http://127.0.0.1:4010/health", buildAnthropicInit("miss"));
        await globalThis.fetch("http://127.0.0.1:4010/v1/messages", { method: "GET" });
        await globalThis.fetch("://bad-url", buildAnthropicInit("broken"));
        await globalThis.fetch("http://127.0.0.1:4010/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not-json}",
        });

        expect(seenInputs).toHaveLength(4);
        expect(seenInputs[2]).toBe("://bad-url");
        expect(existsSync(sessionRoot)).toBe(false);
        expect(getInterceptStateSnapshot().captureCount).toBe(0);
        expect(getInterceptStateSnapshot().totalBytes).toBe(0);
        expect(getInterceptStateSnapshot().anomalyCount).toBe(0);
    });

    test("request dumps redact nested secrets while counters keep original byte totals", async () => {
        const sessionId = `unit-redacted-${Date.now()}`;
        const sessionRoot = getInterceptDumpRoot(sessionId);
        cleanupPath(sessionRoot);

        const requestBody = buildAnthropicBody("secret prompt", {
            api_key: "req-secret-value",
            nested: {
                token: "nested-token",
                keep: "visible",
            },
            items: [
                {
                    password: "hidden-password",
                    label: "still-visible",
                },
                {
                    authorization: "Bearer raw-auth",
                    safe: true,
                },
            ],
        });

        globalThis.fetch = toMockFetch(async () => {
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: {
                    "content-type": "application/json",
                },
            });
        });

        installInterceptFetch({
            now: () => 0,
            timestamp: () => "2026-04-19T06:07:00.000Z",
        });
        setActiveInterceptSession(sessionId);
        setInterceptEnabled(true);

        await globalThis.fetch(
            "http://127.0.0.1:4010/v1/messages",
            buildAnthropicInitWithBody(requestBody, {
                authorization: "Bearer header-secret",
            }),
        );

        const filenames = (await readdir(sessionRoot)).sort();
        const base = filenames[0].replace(/\.(request|response|meta)\.json$/, "");
        const requestDump = readJson(`${sessionRoot}/${base}.request.json`);
        const metaDump = readJson(`${sessionRoot}/${base}.meta.json`);

        expect(requestDump).toEqual({
            model: "mock-sonnet",
            messages: [{ role: "user", content: "secret prompt" }],
            max_tokens: 64,
            api_key: INTERCEPT_REDACTED_VALUE,
            nested: {
                token: INTERCEPT_REDACTED_VALUE,
                keep: "visible",
            },
            items: [
                {
                    password: INTERCEPT_REDACTED_VALUE,
                    label: "still-visible",
                },
                {
                    authorization: INTERCEPT_REDACTED_VALUE,
                    safe: true,
                },
            ],
        });
        expect(JSON.stringify(requestDump)).not.toContain("req-secret-value");
        expect(JSON.stringify(requestDump)).not.toContain("nested-token");
        expect(JSON.stringify(requestDump)).not.toContain("hidden-password");
        expect(JSON.stringify(requestDump)).not.toContain("header-secret");
        expect(requestDump.headers).toBeUndefined();
        expect(metaDump.requestBytes).toBe(Buffer.byteLength(JSON.stringify(requestBody)));
    });

    test("write failures stay fail-open but increment observable anomalies", async () => {
        const writeFailRoot = getInterceptDumpRoot("unit-write-fail");
        cleanupPath(writeFailRoot);

        let originalCalls = 0;
        globalThis.fetch = toMockFetch(async () => {
            originalCalls += 1;
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: {
                    "content-type": "application/json",
                },
            });
        });

        const writeFailWrapper = installInterceptFetch({
            writeDumpTrio: async () => {
                throw new Error("disk full");
            },
        });
        setActiveInterceptSession("unit-write-fail");
        setInterceptEnabled(true);

        const writeFailResponse = await writeFailWrapper(
            "http://127.0.0.1:4010/v1/messages",
            buildAnthropicInit("write fail"),
        );

        expect(await writeFailResponse.text()).toBe(JSON.stringify({ ok: true }));
        expect(originalCalls).toBe(1);
        expect(existsSync(writeFailRoot)).toBe(false);
        expect(getInterceptStateSnapshot().captureCount).toBe(0);
        expect(getInterceptStateSnapshot().anomalyCount).toBe(1);
        expect(getInterceptStateSnapshot().latestAnomaly).toMatchObject({
            scope: "capture",
            phase: "dump-write",
            message: "disk full",
        });
    });

    test("response clone read failures preserve the original response path and surface read anomalies", async () => {
        const cloneFailRoot = getInterceptDumpRoot("unit-clone-fail");
        cleanupPath(cloneFailRoot);

        const originalResponse = new Response("stream body", {
            status: 206,
            headers: {
                "content-type": "text/plain",
            },
        });
        Object.defineProperty(originalResponse, "clone", {
            value: () => ({
                headers: new Headers({ "content-type": "text/plain" }),
                status: 206,
                statusText: "Partial Content",
                text: async () => {
                    throw new Error("clone read failed");
                },
            }),
        });

        globalThis.fetch = toMockFetch(async () => originalResponse);
        installInterceptFetch({
            timestamp: () => "2026-04-19T06:10:00.000Z",
        });
        setActiveInterceptSession("unit-clone-fail");
        setInterceptEnabled(true);

        const cloneFailResponse = await globalThis.fetch(
            "http://127.0.0.1:4010/v1/messages",
            buildAnthropicInit("clone fail"),
        );
        const cloneFiles = (await readdir(cloneFailRoot)).sort();
        const cloneBase = cloneFiles[0].replace(/\.(request|response|meta)\.json$/, "");
        const cloneResponseDump = readJson(`${cloneFailRoot}/${cloneBase}.response.json`);
        const cloneMetaDump = readJson(`${cloneFailRoot}/${cloneBase}.meta.json`);

        expect(await cloneFailResponse.text()).toBe("stream body");
        expect(cloneFiles).toHaveLength(3);
        expect(cloneResponseDump).toEqual({
            status: 206,
            statusText: "Partial Content",
            body: null,
            bodyFormat: "read-error",
            bodyReadError: "clone read failed",
            bodyOmittedReason: null,
        });
        expect(cloneMetaDump.responseBytes).toBe(0);
        expect(getInterceptStateSnapshot().captureCount).toBe(1);
        expect(getInterceptStateSnapshot().totalBytes).toBe(
            Buffer.byteLength(JSON.stringify(buildAnthropicBody("clone fail"))),
        );
        expect(getInterceptStateSnapshot().anomalyCount).toBe(1);
        expect(getInterceptStateSnapshot().latestAnomaly).toMatchObject({
            scope: "capture",
            phase: "response-read",
            message: "clone read failed",
        });
    });

    test("malformed event streams are omitted truthfully and recorded as capture anomalies", async () => {
        const sessionId = `unit-invalid-stream-${Date.now()}`;
        const sessionRoot = getInterceptDumpRoot(sessionId);
        cleanupPath(sessionRoot);
        const responseText = "event: message_start\ndata: {this-is-not-json}\n\n";

        globalThis.fetch = toMockFetch(async () => {
            return new Response(responseText, {
                status: 200,
                headers: {
                    "content-type": "text/event-stream",
                },
            });
        });

        installInterceptFetch({
            now: () => 0,
            timestamp: () => "2026-04-19T06:11:00.000Z",
        });
        setActiveInterceptSession(sessionId);
        setInterceptEnabled(true);

        const response = await globalThis.fetch(
            "http://127.0.0.1:4010/v1/messages",
            buildAnthropicInit("invalid stream"),
        );
        const filenames = (await readdir(sessionRoot)).sort();
        const base = filenames[0].replace(/\.(request|response|meta)\.json$/, "");
        const responseDump = readJson(`${sessionRoot}/${base}.response.json`);
        const metaDump = readJson(`${sessionRoot}/${base}.meta.json`);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(responseText);
        expect(responseDump).toEqual({
            status: 200,
            statusText: "",
            body: null,
            bodyFormat: "omitted",
            bodyReadError: null,
            bodyOmittedReason: "malformed-event-stream",
        });
        expect(metaDump.responseBytes).toBe(Buffer.byteLength(responseText));
        expect(getInterceptStateSnapshot().captureCount).toBe(1);
        expect(getInterceptStateSnapshot().anomalyCount).toBe(1);
        expect(getInterceptStateSnapshot().latestAnomaly?.phase).toBe("response-parse");
        expect(getInterceptStateSnapshot().latestAnomaly?.message).toContain(
            "event stream frame data was not valid JSON",
        );
    });

    test("dump basenames stay stable and sortable", () => {
        expect(
            buildInterceptDumpBasename({
                sequence: 7,
                provider: "anthropic",
                timestamp: "2026-04-19T06:15:00.123Z",
            }),
        ).toBe("007-anthropic-2026-04-19T06-15-00-123Z");
    });
});
