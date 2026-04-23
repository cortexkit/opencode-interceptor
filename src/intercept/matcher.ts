export type InterceptProvider = "anthropic" | "openai" | "generic-llm";
export type InterceptBodyFormat = "empty" | "json" | "text";

export type InterceptBodyPayload = {
    format: InterceptBodyFormat;
    value: unknown;
    bytes: number;
    text: string | null;
};

export type MatchedInterceptRequest = {
    provider: InterceptProvider;
    method: "POST";
    request: Request;
    requestBody: InterceptBodyPayload;
    url: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMessagesArray(
    value: unknown,
): value is Record<string, unknown> & { messages: unknown[] } {
    return isRecord(value) && Array.isArray(value.messages);
}

function looksLikeAnthropicRequest(value: unknown): boolean {
    if (!hasMessagesArray(value)) {
        return false;
    }

    return typeof value.model === "string" && value.max_tokens !== undefined;
}

function looksLikeOpenAIRequest(value: unknown): boolean {
    if (!hasMessagesArray(value)) {
        return false;
    }

    return (
        typeof value.model === "string" &&
        (typeof value.stream === "boolean" || value.stream === undefined)
    );
}

function looksLikeGenericLLMRequest(value: unknown): boolean {
    if (!hasMessagesArray(value)) {
        return false;
    }

    const messages = value.messages;
    if (messages.length === 0) {
        return true;
    }

    return messages.some(
        (msg: unknown) =>
            isRecord(msg) && (typeof msg.role === "string" || typeof msg.content === "string"),
    );
}

function detectProviderFromBody(value: unknown): InterceptProvider | null {
    if (looksLikeAnthropicRequest(value)) {
        return "anthropic";
    }
    if (looksLikeOpenAIRequest(value)) {
        return "openai";
    }
    if (looksLikeGenericLLMRequest(value)) {
        return "generic-llm";
    }
    return null;
}

export function serializeInterceptBodyText(text: string | null | undefined): InterceptBodyPayload {
    const normalized = text ?? "";
    const bytes = Buffer.byteLength(normalized);

    if (normalized.length === 0) {
        return {
            format: "empty",
            value: null,
            bytes: 0,
            text: null,
        };
    }

    try {
        return {
            format: "json",
            value: JSON.parse(normalized),
            bytes,
            text: normalized,
        };
    } catch {
        return {
            format: "text",
            value: normalized,
            bytes,
            text: normalized,
        };
    }
}

export async function matchInterceptRequest(
    request: Request,
): Promise<MatchedInterceptRequest | null> {
    if (request.method.toUpperCase() !== "POST") {
        return null;
    }

    let url: URL;
    try {
        url = new URL(request.url);
    } catch {
        return null;
    }

    let requestBody: InterceptBodyPayload;
    try {
        requestBody = serializeInterceptBodyText(await request.clone().text());
    } catch {
        return null;
    }

    if (requestBody.format !== "json") {
        return null;
    }

    const provider = detectProviderFromBody(requestBody.value);
    if (!provider) {
        return null;
    }

    return {
        provider,
        method: "POST",
        request,
        requestBody,
        url: url.toString(),
    };
}
