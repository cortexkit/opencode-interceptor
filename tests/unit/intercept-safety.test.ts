import { describe, expect, test } from "bun:test";
import { matchInterceptRequest, serializeInterceptBodyText } from "../../src/intercept/matcher";
import {
    INTERCEPT_REDACTED_VALUE,
    scrubInterceptHeaders,
    scrubInterceptJsonValue,
} from "../../src/intercept/redact";

function buildAnthropicBody(extra: Record<string, unknown> = {}) {
    return {
        model: "mock-sonnet",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 64,
        ...extra,
    };
}

function buildOpenAIBody(extra: Record<string, unknown> = {}) {
    return {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        ...extra,
    };
}

function buildGenericLLMBody(extra: Record<string, unknown> = {}) {
    return {
        messages: [{ role: "user", content: "hello" }],
        ...extra,
    };
}

describe("intercept safety guards", () => {
    test("shape-based detection matches anthropic requests by body structure", async () => {
        const body = buildAnthropicBody();
        const matched = await matchInterceptRequest(
            new Request("https://any-proxy.example.com/v1/chat", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            }),
        );

        expect(matched).not.toBeNull();
        expect(matched?.provider).toBe("anthropic");
    });

    test("shape-based detection matches openai requests by body structure", async () => {
        const body = buildOpenAIBody();
        const matched = await matchInterceptRequest(
            new Request("https://any-proxy.example.com/v1/chat", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            }),
        );

        expect(matched).not.toBeNull();
        expect(matched?.provider).toBe("openai");
    });

    test("shape-based detection matches generic llm requests by messages array", async () => {
        const body = buildGenericLLMBody();
        const matched = await matchInterceptRequest(
            new Request("https://any-proxy.example.com/v1/chat", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            }),
        );

        expect(matched).not.toBeNull();
        expect(matched?.provider).toBe("generic-llm");
    });

    test("non-POST methods never match", async () => {
        await expect(
            matchInterceptRequest(
                new Request("https://api.anthropic.com/v1/messages", {
                    method: "GET",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(buildAnthropicBody()),
                }),
            ),
        ).resolves.toBeNull();
    });

    test("malformed, empty, text, and shape-mismatched bodies never produce a capture match", async () => {
        await expect(
            matchInterceptRequest(
                new Request("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{not-json}",
                }),
            ),
        ).resolves.toBeNull();

        await expect(
            matchInterceptRequest(
                new Request("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "",
                }),
            ),
        ).resolves.toBeNull();

        await expect(
            matchInterceptRequest(
                new Request("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: { "content-type": "text/plain" },
                    body: "plain text body",
                }),
            ),
        ).resolves.toBeNull();

        await expect(
            matchInterceptRequest(
                new Request("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ model: "mock-sonnet" }),
                }),
            ),
        ).resolves.toBeNull();

        await expect(
            matchInterceptRequest(
                new Request("https://example.com/v1/messages", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ some_field: "value" }),
                }),
            ),
        ).resolves.toBeNull();
    });

    test("accepted requests preserve provider labeling and parsed body bytes", async () => {
        const payload = buildAnthropicBody();
        const bodyText = JSON.stringify(payload);
        const matched = await matchInterceptRequest(
            new Request("http://127.0.0.1:4010/v1/messages", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: bodyText,
            }),
        );

        expect(matched).not.toBeNull();
        expect(matched?.provider).toBe("anthropic");
        expect(matched?.method).toBe("POST");
        expect(matched?.url).toBe("http://127.0.0.1:4010/v1/messages");
        expect(matched?.requestBody).toEqual({
            format: "json",
            value: payload,
            bytes: Buffer.byteLength(bodyText),
            text: bodyText,
        });
    });

    test("recursive scrubber redacts obvious secret keys and preserves safe structure", () => {
        const scrubbed = scrubInterceptJsonValue({
            model: "mock-sonnet",
            api_key: "top-level-secret",
            nested: {
                token: "token-secret",
                keep: "visible",
                deepArray: [
                    {
                        password: "hidden-password",
                        label: "kept",
                    },
                    {
                        safe: 42,
                        authorization: "Bearer raw-auth",
                    },
                ],
            },
            messages: [
                {
                    role: "user",
                    content: "hello",
                    secret_note: "do-not-store",
                },
            ],
        });

        expect(scrubbed).toEqual({
            model: "mock-sonnet",
            api_key: INTERCEPT_REDACTED_VALUE,
            nested: {
                token: INTERCEPT_REDACTED_VALUE,
                keep: "visible",
                deepArray: [
                    {
                        password: INTERCEPT_REDACTED_VALUE,
                        label: "kept",
                    },
                    {
                        safe: 42,
                        authorization: INTERCEPT_REDACTED_VALUE,
                    },
                ],
            },
            messages: [
                {
                    role: "user",
                    content: "hello",
                    secret_note: INTERCEPT_REDACTED_VALUE,
                },
            ],
        });
    });

    test("header scrubber redacts secret headers and preserves safe ones", () => {
        const headers = new Headers({
            "content-type": "application/json",
            authorization: "Bearer secret-token",
            "x-api-key": "secret-key",
            "x-custom-header": "visible-value",
            cookie: "session=secret-session",
        });

        const scrubbed = scrubInterceptHeaders(headers);

        expect(scrubbed).toEqual({
            "content-type": "application/json",
            authorization: INTERCEPT_REDACTED_VALUE,
            "x-api-key": INTERCEPT_REDACTED_VALUE,
            "x-custom-header": "visible-value",
            cookie: INTERCEPT_REDACTED_VALUE,
        });
    });

    test("body serialization stays truthful for empty, json, and text payloads", () => {
        expect(serializeInterceptBodyText(undefined)).toEqual({
            format: "empty",
            value: null,
            bytes: 0,
            text: null,
        });
        expect(serializeInterceptBodyText('{"ok":true}')).toEqual({
            format: "json",
            value: { ok: true },
            bytes: Buffer.byteLength('{"ok":true}'),
            text: '{"ok":true}',
        });
        expect(serializeInterceptBodyText("not json")).toEqual({
            format: "text",
            value: "not json",
            bytes: Buffer.byteLength("not json"),
            text: "not json",
        });
    });
});
