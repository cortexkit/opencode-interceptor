import { INTERCEPT_PROVIDER_ROUTE_DEFINITIONS } from "./constants";

export type InterceptProvider = (typeof INTERCEPT_PROVIDER_ROUTE_DEFINITIONS)[number]["provider"];
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

function looksLikeAnthropicRequest(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) {
        return false;
    }

    return typeof value.model === "string" && Array.isArray(value.messages);
}

function normalizeHostname(hostname: string): string {
    return hostname.trim().toLowerCase().replace(/\.+$/, "");
}

export function matchInterceptProvider(method: string, url: URL): InterceptProvider | null {
    if (method.toUpperCase() !== "POST") {
        return null;
    }

    const normalizedHostname = normalizeHostname(url.hostname);

    for (const definition of INTERCEPT_PROVIDER_ROUTE_DEFINITIONS) {
        const hostMatched = definition.hostnames.some(
            (hostname) => normalizeHostname(hostname) === normalizedHostname,
        );
        if (!hostMatched) {
            continue;
        }

        const pathMatched = definition.pathnames.some((pathname) => pathname === url.pathname);
        if (pathMatched) {
            return definition.provider;
        }
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
    let url: URL;
    try {
        url = new URL(request.url);
    } catch {
        return null;
    }

    const provider = matchInterceptProvider(request.method, url);
    if (!provider) {
        return null;
    }

    let requestBody: InterceptBodyPayload;
    try {
        requestBody = serializeInterceptBodyText(await request.clone().text());
    } catch {
        return null;
    }

    if (provider === "anthropic") {
        if (requestBody.format !== "json" || !looksLikeAnthropicRequest(requestBody.value)) {
            return null;
        }
    }

    return {
        provider,
        method: "POST",
        request,
        requestBody,
        url: url.toString(),
    };
}
