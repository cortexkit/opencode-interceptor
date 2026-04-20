import { readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { INTERCEPT_DUMP_ROOT, INTERCEPT_RETENTION_MAX_AGE_MS } from "./constants";

export type InterceptRetentionEntryKind = "directory" | "file" | "other";

export type InterceptRetentionEntry = {
    path: string;
    kind: InterceptRetentionEntryKind;
};

export type InterceptRetentionClassification = {
    action: "delete" | "keep" | "skip";
    reason: "expired-session" | "fresh-session" | "unsupported-entry-kind" | "unsafe-path";
    path: string;
    root: string;
    kind: InterceptRetentionEntryKind;
    ageMs: number;
    expiresAtMs: number;
};

export type InterceptRetentionWarning = {
    phase: string;
    message: string;
};

export type InterceptRetentionCleanupResult = {
    root: string;
    inspectedCount: number;
    deletedPaths: string[];
    keptPaths: string[];
    skippedPaths: string[];
    warnings: InterceptRetentionWarning[];
};

type InterceptRetentionStat = {
    mtimeMs: number;
};

type InterceptRetentionOptions = {
    root?: string;
    now?: () => number;
    maxAgeMs?: number;
    listEntries?: (root: string) => Promise<InterceptRetentionEntry[]>;
    statEntry?: (path: string) => Promise<InterceptRetentionStat>;
    removeEntry?: (path: string) => Promise<void>;
};

function safeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function resolveRetentionRoot(root = INTERCEPT_DUMP_ROOT): string {
    return resolve(root);
}

function readNow(now?: () => number): number {
    return now ? now() : Date.now();
}

function isMissingPathError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
    );
}

export function isPathInsideInterceptRoot(path: string, root = INTERCEPT_DUMP_ROOT): boolean {
    const normalizedRoot = resolveRetentionRoot(root);
    const normalizedPath = resolve(path);

    return (
        normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`)
    );
}

function isDirectChildOfRoot(path: string, root: string): boolean {
    return dirname(path) === root;
}

export function classifyInterceptRetentionEntry(input: {
    entryPath: string;
    kind: InterceptRetentionEntryKind;
    modifiedAtMs: number;
    root?: string;
    nowMs?: number;
    maxAgeMs?: number;
}): InterceptRetentionClassification {
    const root = resolveRetentionRoot(input.root);
    const entryPath = resolve(input.entryPath);
    const nowMs = input.nowMs ?? Date.now();
    const maxAgeMs = input.maxAgeMs ?? INTERCEPT_RETENTION_MAX_AGE_MS;
    const ageMs = Math.max(0, nowMs - input.modifiedAtMs);
    const expiresAtMs = input.modifiedAtMs + maxAgeMs;

    if (!isPathInsideInterceptRoot(entryPath, root) || !isDirectChildOfRoot(entryPath, root)) {
        return {
            action: "skip",
            reason: "unsafe-path",
            path: entryPath,
            root,
            kind: input.kind,
            ageMs,
            expiresAtMs,
        };
    }

    if (input.kind !== "directory") {
        return {
            action: "skip",
            reason: "unsupported-entry-kind",
            path: entryPath,
            root,
            kind: input.kind,
            ageMs,
            expiresAtMs,
        };
    }

    if (ageMs < maxAgeMs) {
        return {
            action: "keep",
            reason: "fresh-session",
            path: entryPath,
            root,
            kind: input.kind,
            ageMs,
            expiresAtMs,
        };
    }

    return {
        action: "delete",
        reason: "expired-session",
        path: entryPath,
        root,
        kind: input.kind,
        ageMs,
        expiresAtMs,
    };
}

async function defaultListEntries(root: string): Promise<InterceptRetentionEntry[]> {
    const entries = await readdir(root, { withFileTypes: true });

    return entries.map((entry) => ({
        path: resolve(root, entry.name),
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    }));
}

async function defaultStatEntry(path: string): Promise<InterceptRetentionStat> {
    const entryStat = await stat(path);
    return { mtimeMs: entryStat.mtimeMs };
}

async function defaultRemoveEntry(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
}

export async function cleanupExpiredInterceptArtifacts(
    options: InterceptRetentionOptions = {},
): Promise<InterceptRetentionCleanupResult> {
    const root = resolveRetentionRoot(options.root);
    const nowMs = readNow(options.now);
    const listEntries = options.listEntries ?? defaultListEntries;
    const statEntry = options.statEntry ?? defaultStatEntry;
    const removeEntry = options.removeEntry ?? defaultRemoveEntry;
    const result: InterceptRetentionCleanupResult = {
        root,
        inspectedCount: 0,
        deletedPaths: [],
        keptPaths: [],
        skippedPaths: [],
        warnings: [],
    };

    let entries: InterceptRetentionEntry[];
    try {
        entries = await listEntries(root);
    } catch (error) {
        if (isMissingPathError(error)) {
            return result;
        }

        result.warnings.push({
            phase: "root-read",
            message: `Failed to scan cleanup root ${root}: ${safeErrorMessage(error)}`,
        });
        return result;
    }

    for (const entry of entries) {
        result.inspectedCount += 1;

        let entryStat: InterceptRetentionStat;
        try {
            entryStat = await statEntry(entry.path);
        } catch (error) {
            result.skippedPaths.push(resolve(entry.path));
            result.warnings.push({
                phase: "entry-stat",
                message: `Failed to inspect cleanup entry ${basename(entry.path)}: ${safeErrorMessage(error)}`,
            });
            continue;
        }

        const classification = classifyInterceptRetentionEntry({
            entryPath: entry.path,
            kind: entry.kind,
            modifiedAtMs: entryStat.mtimeMs,
            root,
            nowMs,
            maxAgeMs: options.maxAgeMs,
        });

        if (classification.action === "keep") {
            result.keptPaths.push(classification.path);
            continue;
        }

        if (classification.action === "skip") {
            result.skippedPaths.push(classification.path);

            if (classification.reason === "unsafe-path") {
                result.warnings.push({
                    phase: "path-safety",
                    message: `Rejected cleanup entry outside the interceptor root: ${classification.path}`,
                });
            }

            continue;
        }

        try {
            await removeEntry(classification.path);
            result.deletedPaths.push(classification.path);
        } catch (error) {
            result.skippedPaths.push(classification.path);
            result.warnings.push({
                phase: "entry-delete",
                message: `Failed to delete expired cleanup entry ${basename(classification.path)}: ${safeErrorMessage(error)}`,
            });
        }
    }

    return result;
}
