import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    INTERCEPT_CAPTURE_SEQUENCE_PAD,
    INTERCEPT_META_FILE_SUFFIX,
    INTERCEPT_REQUEST_FILE_SUFFIX,
    INTERCEPT_RESPONSE_FILE_SUFFIX,
} from "./constants";
import type { InterceptProvider } from "./matcher";

export type InterceptResponseBodyFormat =
    | "empty"
    | "json"
    | "replay-text"
    | "omitted"
    | "read-error";

export type InterceptResponsePayload = {
    status: number;
    statusText: string;
    body: unknown;
    bodyFormat: InterceptResponseBodyFormat;
    bodyReadError: string | null;
    bodyOmittedReason: string | null;
};

export type InterceptMetaPayload = {
    timestamp: string;
    url: string;
    method: string;
    status: number;
    contentType: string | null;
    durationMs: number;
    requestBytes: number;
    responseBytes: number;
    capturedBytes: number;
};

export function formatInterceptSequence(sequence: number): string {
    return `${Math.max(0, sequence)}`.padStart(INTERCEPT_CAPTURE_SEQUENCE_PAD, "0");
}

export function sanitizeInterceptTimestamp(timestamp: string): string {
    return timestamp.replaceAll(":", "-").replaceAll(".", "-");
}

export function buildInterceptDumpBasename(input: {
    sequence: number;
    provider: InterceptProvider;
    timestamp: string;
}): string {
    return [
        formatInterceptSequence(input.sequence),
        input.provider,
        sanitizeInterceptTimestamp(input.timestamp),
    ].join("-");
}

export function getInterceptDumpPaths(root: string, basename: string) {
    return {
        requestPath: join(root, `${basename}${INTERCEPT_REQUEST_FILE_SUFFIX}`),
        responsePath: join(root, `${basename}${INTERCEPT_RESPONSE_FILE_SUFFIX}`),
        metaPath: join(root, `${basename}${INTERCEPT_META_FILE_SUFFIX}`),
    };
}

function renderJson(value: unknown): string {
    const rendered = JSON.stringify(value, null, 2);
    return rendered ?? "null";
}

export async function writeInterceptDumpTrio(input: {
    root: string;
    basename: string;
    requestPayload: unknown;
    responsePayload: InterceptResponsePayload;
    metaPayload: InterceptMetaPayload;
}): Promise<ReturnType<typeof getInterceptDumpPaths>> {
    const paths = getInterceptDumpPaths(input.root, input.basename);
    const files = [
        {
            finalPath: paths.requestPath,
            content: renderJson(input.requestPayload),
        },
        {
            finalPath: paths.responsePath,
            content: renderJson(input.responsePayload),
        },
        {
            finalPath: paths.metaPath,
            content: renderJson(input.metaPayload),
        },
    ].map((file) => ({
        ...file,
        tempPath: `${file.finalPath}.${randomUUID()}.tmp`,
    }));

    await mkdir(input.root, { recursive: true });

    try {
        for (const file of files) {
            await writeFile(file.tempPath, file.content, "utf8");
        }

        for (const file of files) {
            await rename(file.tempPath, file.finalPath);
        }

        return paths;
    } catch (error) {
        await Promise.all(
            files.flatMap((file) => [
                rm(file.tempPath, { force: true }).catch(() => undefined),
                rm(file.finalPath, { force: true }).catch(() => undefined),
            ]),
        );
        throw error;
    }
}
