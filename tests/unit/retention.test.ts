import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INTERCEPT_RETENTION_MAX_AGE_MS } from "../../src/intercept/constants";
import {
    classifyInterceptRetentionEntry,
    cleanupExpiredInterceptArtifacts,
    isPathInsideInterceptRoot,
} from "../../src/intercept/retention";

const TEST_ROOTS = new Set<string>();

function createRoot(label: string): string {
    const root = join(
        tmpdir(),
        `opencode-interceptor-retention-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    TEST_ROOTS.add(root);
    mkdirSync(root, { recursive: true });
    return root;
}

function touchWithAge(path: string, ageMs: number) {
    const stampedAt = new Date(Date.now() - ageMs);
    utimesSync(path, stampedAt, stampedAt);
}

afterEach(() => {
    for (const root of TEST_ROOTS) {
        rmSync(root, { recursive: true, force: true });
    }
    TEST_ROOTS.clear();
});

describe("intercept retention cleanup", () => {
    test("classification deletes only expired direct child session directories inside the root", () => {
        const nowMs = Date.UTC(2026, 3, 19, 7, 0, 0);
        const root = resolve("/tmp/opencode-interceptor");
        const expiredPath = join(root, "expired-session");
        const freshPath = join(root, "fresh-session");
        const nestedPath = join(expiredPath, "nested-child");
        const repoReadme = resolve(import.meta.dir, "../../README.md");

        expect(
            classifyInterceptRetentionEntry({
                root,
                entryPath: expiredPath,
                kind: "directory",
                modifiedAtMs: nowMs - INTERCEPT_RETENTION_MAX_AGE_MS - 1,
                nowMs,
            }),
        ).toMatchObject({
            action: "delete",
            reason: "expired-session",
            path: expiredPath,
        });

        expect(
            classifyInterceptRetentionEntry({
                root,
                entryPath: freshPath,
                kind: "directory",
                modifiedAtMs: nowMs - INTERCEPT_RETENTION_MAX_AGE_MS + 1,
                nowMs,
            }),
        ).toMatchObject({
            action: "keep",
            reason: "fresh-session",
            path: freshPath,
        });

        expect(
            classifyInterceptRetentionEntry({
                root,
                entryPath: join(root, "notes.txt"),
                kind: "file",
                modifiedAtMs: nowMs - INTERCEPT_RETENTION_MAX_AGE_MS - 1,
                nowMs,
            }),
        ).toMatchObject({
            action: "skip",
            reason: "unsupported-entry-kind",
        });

        expect(
            classifyInterceptRetentionEntry({
                root,
                entryPath: nestedPath,
                kind: "directory",
                modifiedAtMs: nowMs - INTERCEPT_RETENTION_MAX_AGE_MS - 1,
                nowMs,
            }),
        ).toMatchObject({
            action: "skip",
            reason: "unsafe-path",
            path: nestedPath,
        });

        expect(
            classifyInterceptRetentionEntry({
                root,
                entryPath: repoReadme,
                kind: "directory",
                modifiedAtMs: nowMs - INTERCEPT_RETENTION_MAX_AGE_MS - 1,
                nowMs,
            }),
        ).toMatchObject({
            action: "skip",
            reason: "unsafe-path",
            path: repoReadme,
        });
        expect(isPathInsideInterceptRoot(expiredPath, root)).toBe(true);
        expect(isPathInsideInterceptRoot(repoReadme, root)).toBe(false);
    });

    test("cleanup removes expired session directories while keeping fresh directories and unknown files", async () => {
        const root = createRoot("real-fs");
        const expiredDir = join(root, "expired-session");
        const freshDir = join(root, "fresh-session");
        const strayFile = join(root, "notes.txt");

        mkdirSync(expiredDir, { recursive: true });
        mkdirSync(freshDir, { recursive: true });
        writeFileSync(join(expiredDir, "capture.meta.json"), "{}", "utf8");
        writeFileSync(join(freshDir, "capture.meta.json"), "{}", "utf8");
        writeFileSync(strayFile, "leave me here", "utf8");
        touchWithAge(expiredDir, INTERCEPT_RETENTION_MAX_AGE_MS + 60_000);
        touchWithAge(freshDir, 1_000);
        touchWithAge(strayFile, INTERCEPT_RETENTION_MAX_AGE_MS + 60_000);

        const result = await cleanupExpiredInterceptArtifacts({ root });

        expect(result.root).toBe(root);
        expect(result.inspectedCount).toBe(3);
        expect(result.deletedPaths).toEqual([expiredDir]);
        expect(result.keptPaths).toEqual([freshDir]);
        expect(result.skippedPaths).toEqual([strayFile]);
        expect(result.warnings).toEqual([]);
        expect(existsSync(expiredDir)).toBe(false);
        expect(existsSync(freshDir)).toBe(true);
        expect(existsSync(strayFile)).toBe(true);
    });

    test("delete failures become cleanup warnings without aborting the pass", async () => {
        const root = resolve("/tmp/opencode-interceptor-delete-failure");
        const expiredDir = join(root, "expired-session");
        const freshDir = join(root, "fresh-session");

        const result = await cleanupExpiredInterceptArtifacts({
            root,
            now: () => Date.UTC(2026, 3, 19, 7, 0, 0),
            listEntries: async () => [
                { path: expiredDir, kind: "directory" },
                { path: freshDir, kind: "directory" },
            ],
            statEntry: async (path) => ({
                mtimeMs:
                    path === expiredDir
                        ? Date.UTC(2026, 3, 18, 6, 0, 0)
                        : Date.UTC(2026, 3, 19, 6, 59, 0),
            }),
            removeEntry: async (path) => {
                if (path === expiredDir) {
                    throw new Error("permission denied");
                }
            },
        });

        expect(result.deletedPaths).toEqual([]);
        expect(result.keptPaths).toEqual([freshDir]);
        expect(result.skippedPaths).toEqual([expiredDir]);
        expect(result.warnings).toEqual([
            {
                phase: "entry-delete",
                message:
                    "Failed to delete expired cleanup entry expired-session: permission denied",
            },
        ]);
    });

    test("stat failures and unsafe paths surface as warnings while missing roots stay a quiet no-op", async () => {
        const root = resolve("/tmp/opencode-interceptor-stat-failure");
        const missingRoot = join(root, "missing-root");
        const unsafePath = resolve("/tmp/not-the-interceptor-root/outside-session");

        const statFailureResult = await cleanupExpiredInterceptArtifacts({
            root,
            now: () => Date.UTC(2026, 3, 19, 7, 0, 0),
            listEntries: async () => [
                { path: join(root, "inspect-me"), kind: "directory" },
                { path: unsafePath, kind: "directory" },
            ],
            statEntry: async (path) => {
                if (path === unsafePath) {
                    return { mtimeMs: Date.UTC(2026, 3, 18, 6, 0, 0) };
                }

                throw new Error("stat exploded");
            },
            removeEntry: async () => undefined,
        });

        expect(statFailureResult.deletedPaths).toEqual([]);
        expect(statFailureResult.keptPaths).toEqual([]);
        expect(statFailureResult.skippedPaths).toEqual([join(root, "inspect-me"), unsafePath]);
        expect(statFailureResult.warnings).toEqual([
            {
                phase: "entry-stat",
                message: "Failed to inspect cleanup entry inspect-me: stat exploded",
            },
            {
                phase: "path-safety",
                message: `Rejected cleanup entry outside the interceptor root: ${unsafePath}`,
            },
        ]);

        const missingRootResult = await cleanupExpiredInterceptArtifacts({ root: missingRoot });
        expect(missingRootResult).toEqual({
            root: missingRoot,
            inspectedCount: 0,
            deletedPaths: [],
            keptPaths: [],
            skippedPaths: [],
            warnings: [],
        });
    });
});
