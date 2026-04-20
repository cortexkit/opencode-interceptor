import { describe, expect, test } from "bun:test";
import {
    matchInterceptProvider,
    matchInterceptRequest,
    serializeInterceptBodyText,
} from "../../src/intercept/matcher";
import { INTERCEPT_REDACTED_VALUE, scrubInterceptJsonValue } from "../../src/intercept/redact";

function buildAnthropicBody(extra: Record<string, unknown> = {}) {
    return {
        model: "mock-sonnet",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 64,
        ...extra,
    };
}

describe("intercept safety guards", () => {
    test("curated host and path pairs match deny-by-default", () => {
        expect(
            matchInterceptProvider("POST", new URL("https://api.anthropic.com/v1/messages")),
        ).toBe("anthropic");
        expect(matchInterceptProvider("POST", new URL("http://127.0.0.1:4010/messages"))).toBe(
            "anthropic",
        );
        expect(matchInterceptProvider("POST", new URL("http://localhost:4010/v1/messages"))).toBe(
            "anthropic",
        );
        expect(matchInterceptProvider("POST", new URL("http://[::1]:4010/v1/messages"))).toBe(
            "anthropic",
        );

        expect(
            matchInterceptProvider("GET", new URL("https://api.anthropic.com/v1/messages")),
        ).toBeNull();
        expect(
            matchInterceptProvider("POST", new URL("https://api.anthropic.com/chat/completions")),
        ).toBeNull();
        expect(
            matchInterceptProvider("POST", new URL("https://example.com/v1/messages")),
        ).toBeNull();
        expect(
            matchInterceptProvider(
                "POST",
                new URL("https://api.anthropic.com.evil.test/v1/messages"),
            ),
        ).toBeNull();
        expect(
            matchInterceptProvider("POST", new URL("https://api.openai.com/v1/messages")),
        ).toBeNull();
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
                    body: JSON.stringify(buildAnthropicBody()),
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
