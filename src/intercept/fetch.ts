import {
    buildInterceptDumpBasename,
    type InterceptMetaPayload,
    type InterceptResponsePayload,
    writeInterceptDumpTrio,
} from "./dump";
import { matchInterceptRequest } from "./matcher";
import { scrubInterceptJsonValue } from "./redact";
import {
    allocateInterceptSequence,
    getActiveInterceptSessionId,
    getInterceptDumpRoot,
    getInterceptWrappedFetch,
    isInterceptEnabled,
    recordInterceptAnomaly,
    recordInterceptCapture,
    registerInterceptFetchWrapper,
    resolveInterceptSessionId,
} from "./state";

export type InterceptFetchOptions = {
    now?: () => number;
    timestamp?: () => string;
    writeDumpTrio?: typeof writeInterceptDumpTrio;
};

type InterceptSerializationAnomaly = {
    phase: string;
    message: string;
};

function resolveNow(options: InterceptFetchOptions): number {
    return options.now ? options.now() : performance.now();
}

function resolveTimestamp(options: InterceptFetchOptions): string {
    return options.timestamp ? options.timestamp() : new Date().toISOString();
}

function readCloneFailureMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function withFetchPreconnect(
    fetchLike: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    preconnect: typeof globalThis.fetch.preconnect,
): typeof globalThis.fetch {
    return Object.assign(fetchLike, { preconnect }) as typeof globalThis.fetch;
}

function normalizeContentType(contentType: string | null): string | null {
    if (!contentType) {
        return null;
    }

    const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase();
    return normalized && normalized.length > 0 ? normalized : null;
}

function looksLikeJsonContentType(contentType: string | null): boolean {
    return contentType === "application/json" || contentType === "application/problem+json";
}

function isEventStreamContentType(contentType: string | null): boolean {
    return contentType === "text/event-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function tryParseJsonText(
    text: string,
): { ok: true; value: unknown } | { ok: false; error: unknown } {
    try {
        return {
            ok: true,
            value: JSON.parse(text),
        };
    } catch (error) {
        return {
            ok: false,
            error,
        };
    }
}

function extractReplayTextFromEventPayload(payload: unknown): string[] {
    if (!isRecord(payload)) {
        return [];
    }

    if (
        payload.type === "content_block_start" &&
        isRecord(payload.content_block) &&
        payload.content_block.type === "text" &&
        typeof payload.content_block.text === "string"
    ) {
        return [payload.content_block.text];
    }

    if (
        payload.type === "content_block_delta" &&
        isRecord(payload.delta) &&
        payload.delta.type === "text_delta" &&
        typeof payload.delta.text === "string"
    ) {
        return [payload.delta.text];
    }

    return [];
}

function extractReplayTextFromEventStream(text: string): string {
    const fragments: string[] = [];
    const blocks = text.replace(/\r\n/g, "\n").split(/\n\n+/);

    for (const block of blocks) {
        const trimmedBlock = block.trim();
        if (trimmedBlock.length === 0) {
            continue;
        }

        const dataLines: string[] = [];
        const lines = block.split("\n").filter((line) => line.length > 0);

        for (const line of lines) {
            if (line.startsWith(":")) {
                continue;
            }

            const separatorIndex = line.indexOf(":");
            if (separatorIndex === -1) {
                throw new Error("event stream frame was missing a field separator");
            }

            const field = line.slice(0, separatorIndex).trim();
            const value = line.slice(separatorIndex + 1).trimStart();

            if (field === "data") {
                dataLines.push(value);
                continue;
            }

            if (field === "event" || field === "id" || field === "retry") {
                continue;
            }

            throw new Error(`event stream used unsupported field '${field || "unknown"}'`);
        }

        if (dataLines.length === 0) {
            continue;
        }

        const payloadText = dataLines.join("\n");
        if (payloadText === "[DONE]") {
            continue;
        }

        const parsedPayload = tryParseJsonText(payloadText);
        if (!parsedPayload.ok) {
            throw new Error(
                `event stream frame data was not valid JSON: ${safeErrorMessage(parsedPayload.error)}`,
            );
        }

        fragments.push(...extractReplayTextFromEventPayload(parsedPayload.value));
    }

    return fragments.join("");
}

async function serializeInterceptResponse(response: Response): Promise<{
    contentType: string | null;
    responseBytes: number;
    responsePayload: InterceptResponsePayload;
    anomaly: InterceptSerializationAnomaly | null;
}> {
    const contentType = response.headers.get("content-type");
    const normalizedContentType = normalizeContentType(contentType);

    let bodyText: string;
    try {
        bodyText = await response.text();
    } catch (error) {
        const message = readCloneFailureMessage(error);
        return {
            contentType,
            responseBytes: 0,
            responsePayload: {
                status: response.status,
                statusText: response.statusText,
                body: null,
                bodyFormat: "read-error",
                bodyReadError: message,
                bodyOmittedReason: null,
            },
            anomaly: {
                phase: "response-read",
                message,
            },
        };
    }

    const responseBytes = Buffer.byteLength(bodyText);
    if (bodyText.length === 0) {
        return {
            contentType,
            responseBytes,
            responsePayload: {
                status: response.status,
                statusText: response.statusText,
                body: null,
                bodyFormat: "empty",
                bodyReadError: null,
                bodyOmittedReason: null,
            },
            anomaly: null,
        };
    }

    if (isEventStreamContentType(normalizedContentType)) {
        try {
            const replayText = extractReplayTextFromEventStream(bodyText);
            return {
                contentType,
                responseBytes,
                responsePayload: {
                    status: response.status,
                    statusText: response.statusText,
                    body: replayText,
                    bodyFormat: "replay-text",
                    bodyReadError: null,
                    bodyOmittedReason: null,
                },
                anomaly: null,
            };
        } catch (error) {
            return {
                contentType,
                responseBytes,
                responsePayload: {
                    status: response.status,
                    statusText: response.statusText,
                    body: null,
                    bodyFormat: "omitted",
                    bodyReadError: null,
                    bodyOmittedReason: "malformed-event-stream",
                },
                anomaly: {
                    phase: "response-parse",
                    message: safeErrorMessage(error),
                },
            };
        }
    }

    const parsedJson = tryParseJsonText(bodyText);
    if (parsedJson.ok) {
        return {
            contentType,
            responseBytes,
            responsePayload: {
                status: response.status,
                statusText: response.statusText,
                body: scrubInterceptJsonValue(parsedJson.value),
                bodyFormat: "json",
                bodyReadError: null,
                bodyOmittedReason: null,
            },
            anomaly: null,
        };
    }

    if (looksLikeJsonContentType(normalizedContentType)) {
        return {
            contentType,
            responseBytes,
            responsePayload: {
                status: response.status,
                statusText: response.statusText,
                body: null,
                bodyFormat: "omitted",
                bodyReadError: null,
                bodyOmittedReason: "malformed-json-response",
            },
            anomaly: {
                phase: "response-parse",
                message: `JSON response parsing failed: ${safeErrorMessage(parsedJson.error)}`,
            },
        };
    }

    return {
        contentType,
        responseBytes,
        responsePayload: {
            status: response.status,
            statusText: response.statusText,
            body: null,
            bodyFormat: "omitted",
            bodyReadError: null,
            bodyOmittedReason: "unsupported-text-response",
        },
        anomaly: null,
    };
}

export function createInterceptFetchWrapper(
    originalFetch: typeof globalThis.fetch,
    options: InterceptFetchOptions = {},
): typeof globalThis.fetch {
    const writeDumpTrio = options.writeDumpTrio ?? writeInterceptDumpTrio;

    return withFetchPreconnect(async (input, init) => {
        if (!isInterceptEnabled()) {
            return originalFetch(input, init);
        }

        let request: Request;
        try {
            request = new Request(input, init);
        } catch {
            return originalFetch(input, init);
        }

        const matchedRequest = await matchInterceptRequest(request);
        if (!matchedRequest) {
            return originalFetch(input, init);
        }

        const sessionId = resolveInterceptSessionId(getActiveInterceptSessionId());
        const dumpRoot = getInterceptDumpRoot(sessionId);
        const startedAt = resolveNow(options);
        const response = await originalFetch(request);
        const completedAt = resolveNow(options);
        const { contentType, responseBytes, responsePayload, anomaly } =
            await serializeInterceptResponse(response.clone());

        const capturedBytes = matchedRequest.requestBody.bytes + responseBytes;
        const metaPayload: InterceptMetaPayload = {
            timestamp: resolveTimestamp(options),
            url: matchedRequest.url,
            method: matchedRequest.method,
            status: response.status,
            contentType,
            durationMs: Math.max(0, Math.round(completedAt - startedAt)),
            requestBytes: matchedRequest.requestBody.bytes,
            responseBytes,
            capturedBytes,
        };

        try {
            const sequence = allocateInterceptSequence(sessionId);
            const basename = buildInterceptDumpBasename({
                sequence,
                provider: matchedRequest.provider,
                timestamp: metaPayload.timestamp,
            });

            await writeDumpTrio({
                root: dumpRoot,
                basename,
                requestPayload: scrubInterceptJsonValue(matchedRequest.requestBody.value),
                responsePayload,
                metaPayload,
            });
            recordInterceptCapture(capturedBytes);

            if (anomaly) {
                recordInterceptAnomaly(anomaly);
            }
        } catch (error) {
            recordInterceptAnomaly({
                phase: "dump-write",
                message: readCloneFailureMessage(error),
            });
            // Fail open: preserve the original response path if capture serialization or writes fail.
        }

        return response;
    }, originalFetch.preconnect);
}

export function installInterceptFetch(
    options: InterceptFetchOptions = {},
): typeof globalThis.fetch {
    const existingWrappedFetch = getInterceptWrappedFetch();
    if (existingWrappedFetch) {
        globalThis.fetch = existingWrappedFetch;
        return existingWrappedFetch;
    }

    const originalFetch = globalThis.fetch.bind(globalThis) as typeof globalThis.fetch;
    const wrappedFetch = createInterceptFetchWrapper(originalFetch, options);
    const registration = registerInterceptFetchWrapper({
        originalFetch,
        wrappedFetch,
    });

    globalThis.fetch = registration.wrappedFetch;
    return registration.wrappedFetch;
}
