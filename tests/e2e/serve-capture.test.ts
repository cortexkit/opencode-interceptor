import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INTERCEPT_DUMP_ROOT, INTERCEPT_RETENTION_MAX_AGE_MS } from "../../src/intercept/constants";
import {
    collectDumpTrios,
    OpencodeServeHarness,
    runInterceptCommand,
} from "../helpers/opencodeServe";

let harness: OpencodeServeHarness | null = null;
const RETENTION_FIXTURE_PATHS = new Set<string>();

function registerRetentionFixturePath(path: string) {
    RETENTION_FIXTURE_PATHS.add(path);
}

function seedStartupRetentionFixture() {
    const prefix = `startup-retention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const expiredDir = join(INTERCEPT_DUMP_ROOT, `${prefix}-expired`);
    const freshDir = join(INTERCEPT_DUMP_ROOT, `${prefix}-fresh`);
    const staleStamp = new Date(Date.now() - INTERCEPT_RETENTION_MAX_AGE_MS - 60_000);

    mkdirSync(expiredDir, { recursive: true });
    writeFileSync(join(expiredDir, "seed.txt"), "stale capture", "utf8");
    utimesSync(join(expiredDir, "seed.txt"), staleStamp, staleStamp);
    utimesSync(expiredDir, staleStamp, staleStamp);

    mkdirSync(freshDir, { recursive: true });
    writeFileSync(join(freshDir, "seed.txt"), "fresh capture", "utf8");

    registerRetentionFixturePath(expiredDir);
    registerRetentionFixturePath(freshDir);

    return {
        expiredDir,
        freshDir,
    };
}

afterEach(async () => {
    await harness?.dispose();
    harness = null;

    for (const path of RETENTION_FIXTURE_PATHS) {
        rmSync(path, { recursive: true, force: true });
    }
    RETENTION_FIXTURE_PATHS.clear();
});

describe("opencode serve capture hardening and negative regressions", () => {
    test("a fresh real prompt keeps disabled mode inert while still observing provider traffic", async () => {
        harness = await OpencodeServeHarness.start();
        const sessionId = await harness.createSession();
        const statusReply = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "initial status",
        );

        const prompt = await harness.sendPrompt(sessionId, "say hello briefly", {
            label: "fresh prompt",
        });
        const statusAfterPrompt = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "status after disabled prompt",
        );

        expect(prompt.providerRequestDelta).toBeGreaterThanOrEqual(1);
        expect(prompt.providerRequestCount).toBeGreaterThanOrEqual(prompt.providerRequestDelta);
        expect(prompt.latestAssistantText).toContain("unexpected model fallback");
        expect(prompt.newMessages.some((message) => message.info?.role === "user")).toBe(true);
        expect(prompt.newMessages.some((message) => message.info?.role === "assistant")).toBe(true);
        expect(prompt.latestInterceptSummary).toBe(statusReply.summary);
        expect(prompt.dumpInspection?.root).toBe(statusReply.parsed.dumpRoot);
        expect(prompt.dumpInspection?.exists).toBe(false);
        expect(prompt.dumpInspection?.entries ?? []).toHaveLength(0);
        expect(statusAfterPrompt.parsed.enabled).toBe(false);
        expect(statusAfterPrompt.parsed.dumpRoot).toBe(statusReply.parsed.dumpRoot);
        expect(statusAfterPrompt.parsed.captures).toBe(0);
        expect(statusAfterPrompt.parsed.totalBytes).toBe(0);
        expect(statusAfterPrompt.parsed.anomalies).toBe(0);
        expect(statusAfterPrompt.parsed.latestAnomalyPhase).toBeNull();
        expect(statusAfterPrompt.parsed.latestAnomalyMessage).toBeNull();
        expect(JSON.stringify(harness.modelRequests(), null, 2)).toContain("say hello briefly");
    }, 45_000);

    test("startup cleanup prunes stale temp artifacts, keeps fresh ones, and still allows real capture", async () => {
        const fixture = seedStartupRetentionFixture();
        harness = await OpencodeServeHarness.start();
        const sessionId = await harness.createSession();
        const statusAfterStartup = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "status after startup cleanup",
        );

        expect(statusAfterStartup.parsed.dumpRoot).toContain(`${INTERCEPT_DUMP_ROOT}/`);
        expect(statusAfterStartup.parsed.anomalies).toBe(0);
        expect(statusAfterStartup.parsed.latestAnomalyPhase).toBeNull();
        expect(statusAfterStartup.parsed.latestAnomalyMessage).toBeNull();
        expect(existsSync(fixture.expiredDir)).toBe(false);
        expect(existsSync(fixture.freshDir)).toBe(true);

        await runInterceptCommand(
            harness,
            sessionId,
            "/intercept on",
            "enable after startup cleanup",
        );
        const prompt = await harness.sendPrompt(sessionId, "say hello after cleanup", {
            label: "post-cleanup prompt",
        });
        const statusAfterPrompt = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "status after post-cleanup prompt",
        );
        const trios = collectDumpTrios(
            prompt.dumpInspection,
            statusAfterPrompt.summary,
            "post-cleanup prompt",
        );

        expect(prompt.providerRequestDelta).toBeGreaterThanOrEqual(1);
        expect(trios.length).toBeGreaterThanOrEqual(1);
        expect(statusAfterPrompt.parsed.enabled).toBe(true);
        expect(statusAfterPrompt.parsed.captures).toBe(trios.length);
        expect(statusAfterPrompt.parsed.anomalies).toBe(0);
        expect(statusAfterPrompt.parsed.latestAnomalyPhase).toBeNull();
        expect(statusAfterPrompt.parsed.latestAnomalyMessage).toBeNull();
    }, 45_000);

    test("enabled mode writes replay-text dump trios and disable prevents new trios on later prompts", async () => {
        harness = await OpencodeServeHarness.start();
        const sessionId = await harness.createSession();
        const enableReply = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept on",
            "enable",
        );

        const enabledPrompt = await harness.sendPrompt(sessionId, "say hello briefly", {
            label: "enabled prompt",
        });
        const statusAfterEnabledPrompt = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "status after enabled prompt",
        );
        const enabledTrios = collectDumpTrios(
            enabledPrompt.dumpInspection,
            statusAfterEnabledPrompt.summary,
            "enabled prompt",
        );
        const enabledTotalBytes = enabledTrios.reduce(
            (total, trio) => total + trio.metaPayload.capturedBytes,
            0,
        );

        expect(enabledPrompt.providerRequestDelta).toBeGreaterThanOrEqual(1);
        expect(enabledPrompt.providerRequestDelta).toBe(enabledTrios.length);
        expect(statusAfterEnabledPrompt.parsed.enabled).toBe(true);
        expect(statusAfterEnabledPrompt.parsed.dumpRoot).toBe(enableReply.parsed.dumpRoot);
        expect(statusAfterEnabledPrompt.parsed.captures).toBe(enabledTrios.length);
        expect(statusAfterEnabledPrompt.parsed.totalBytes).toBe(enabledTotalBytes);
        expect(statusAfterEnabledPrompt.parsed.anomalies).toBe(0);
        expect(statusAfterEnabledPrompt.parsed.latestAnomalyPhase).toBeNull();
        expect(statusAfterEnabledPrompt.parsed.latestAnomalyMessage).toBeNull();

        for (const [index, trio] of enabledTrios.entries()) {
            const expectedPrefix = `${String(index + 1).padStart(3, "0")}-anthropic-`;
            expect(trio.basename).toStartWith(expectedPrefix);
            expect(trio.requestPath).toBe(`${trio.basename}.request.json`);
            expect(trio.responsePath).toBe(`${trio.basename}.response.json`);
            expect(trio.metaPath).toBe(`${trio.basename}.meta.json`);
            expect(trio.requestPayload.model).toBe("mock-sonnet");
            expect(Array.isArray(trio.requestPayload.messages)).toBe(true);
            expect(trio.responsePayload.status).toBe(200);
            expect(trio.responsePayload.bodyFormat).toBe("replay-text");
            expect(trio.responsePayload.bodyReadError).toBeNull();
            expect(trio.responsePayload.bodyOmittedReason).toBeNull();
            expect(typeof trio.responsePayload.body).toBe("string");
            expect(String(trio.responsePayload.body)).toContain("unexpected model fallback");
            expect(String(trio.responsePayload.body)).not.toContain("event:");
            expect(String(trio.responsePayload.body)).not.toContain("data:");
            expect(trio.metaPayload.url).toContain("/messages");
            expect(trio.metaPayload.method).toBe("POST");
            expect(trio.metaPayload.status).toBe(200);
            expect(trio.metaPayload.contentType).toBe("text/event-stream");
            expect(trio.metaPayload.durationMs).toBeGreaterThanOrEqual(0);
            expect(trio.metaPayload.requestBytes).toBeGreaterThan(0);
            expect(trio.metaPayload.responseBytes).toBeGreaterThan(0);
            expect(trio.metaPayload.capturedBytes).toBe(
                trio.metaPayload.requestBytes + trio.metaPayload.responseBytes,
            );
        }

        const disableReply = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept off",
            "disable",
        );
        const disabledPrompt = await harness.sendPrompt(sessionId, "say hello after disable", {
            label: "disabled prompt",
        });
        const statusAfterDisabledPrompt = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "status after disabled prompt",
        );
        const disabledTrios = collectDumpTrios(
            disabledPrompt.dumpInspection,
            statusAfterDisabledPrompt.summary,
            "disabled prompt",
        );

        expect(disableReply.parsed.enabled).toBe(false);
        expect(disableReply.parsed.dumpRoot).toBe(enableReply.parsed.dumpRoot);
        expect(disableReply.parsed.captures).toBe(enabledTrios.length);
        expect(disableReply.parsed.totalBytes).toBe(enabledTotalBytes);
        expect(disabledPrompt.providerRequestDelta).toBeGreaterThanOrEqual(1);
        expect(statusAfterDisabledPrompt.parsed.enabled).toBe(false);
        expect(statusAfterDisabledPrompt.parsed.dumpRoot).toBe(enableReply.parsed.dumpRoot);
        expect(statusAfterDisabledPrompt.parsed.captures).toBe(enabledTrios.length);
        expect(statusAfterDisabledPrompt.parsed.totalBytes).toBe(enabledTotalBytes);
        expect(statusAfterDisabledPrompt.parsed.anomalies).toBe(0);
        expect(statusAfterDisabledPrompt.parsed.latestAnomalyPhase).toBeNull();
        expect(statusAfterDisabledPrompt.parsed.latestAnomalyMessage).toBeNull();
        expect(disabledTrios).toEqual(enabledTrios);
    }, 45_000);

    test("HTTP-error provider responses persist scrubbed JSON bodies without anomaly drift", async () => {
        harness = await OpencodeServeHarness.start({ mockProviderMode: "http-error" });
        const sessionId = await harness.createSession();
        await runInterceptCommand(harness, sessionId, "/intercept on", "enable");

        let promptFailure: Error | null = null;
        try {
            await harness.sendPrompt(sessionId, "say hello briefly", {
                label: "http error prompt",
                timeoutMs: 5_000,
                requireAssistantText: false,
            });
        } catch (error) {
            promptFailure = error as Error;
        }

        const statusAfterHttpError = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "status after http error prompt",
        );
        const httpErrorTrios = collectDumpTrios(
            harness.inspectDumpRoot(statusAfterHttpError.parsed.dumpRoot),
            statusAfterHttpError.summary,
            "http error prompt",
        );
        const latestTrio = httpErrorTrios.at(-1);

        expect(statusAfterHttpError.parsed.captures).toBeGreaterThanOrEqual(1);
        expect(statusAfterHttpError.parsed.anomalies).toBe(0);
        expect(statusAfterHttpError.parsed.latestAnomalyPhase).toBeNull();
        expect(statusAfterHttpError.parsed.latestAnomalyMessage).toBeNull();
        expect(latestTrio).toBeDefined();
        expect(latestTrio?.responsePayload.status).toBe(503);
        expect(latestTrio?.responsePayload.bodyFormat).toBe("json");
        expect(latestTrio?.responsePayload.bodyReadError).toBeNull();
        expect(latestTrio?.responsePayload.bodyOmittedReason).toBeNull();
        expect(latestTrio?.responsePayload.body).toEqual({
            error: {
                type: "mock_provider_error",
                api_key: "[REDACTED]",
                nested: {
                    token: "[REDACTED]",
                    path: "/messages",
                },
            },
        });
        expect(JSON.stringify(latestTrio?.responsePayload.body)).not.toContain(
            "provider-http-error-secret",
        );
        expect(JSON.stringify(latestTrio?.responsePayload.body)).not.toContain("http-error-token");
        if (promptFailure) {
            expect(promptFailure.message).toContain("providerRequestCount=");
            expect(promptFailure.message).toContain("providerRequestDelta=");
        }
    }, 45_000);

    test("stalled provider traffic fails with summary, dump, transcript, and stdio diagnostics", async () => {
        harness = await OpencodeServeHarness.start({ mockProviderMode: "stall" });
        const sessionId = await harness.createSession();
        const enableReply = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept on",
            "enable",
        );

        let failure: Error | null = null;
        try {
            await harness.sendPrompt(sessionId, "say hello briefly", {
                label: "stalled prompt",
                timeoutMs: 2_500,
            });
        } catch (error) {
            failure = error as Error;
        }

        expect(failure).toBeInstanceOf(Error);
        expect(failure?.message).toContain("Prompt roundtrip failed for stalled prompt");
        expect(failure?.message).toContain("providerRequestCount=");
        expect(failure?.message).toContain("providerRequestDelta=");
        expect(failure?.message).toContain(
            `latestInterceptSummary=${JSON.stringify(enableReply.summary)}`,
        );
        expect(failure?.message).toContain("dumpInspection=");
        expect(failure?.message).toContain(enableReply.parsed.dumpRoot);
        expect(failure?.message).toContain("mockRequests=");
        expect(failure?.message).toContain("say hello briefly");
        expect(failure?.message).toContain("--- stdout ---");
        expect(failure?.message).toContain("--- stderr ---");
    }, 45_000);

    test("malformed provider output records an observable anomaly and omitted response dump", async () => {
        harness = await OpencodeServeHarness.start({ mockProviderMode: "invalid-event-stream" });
        const sessionId = await harness.createSession();
        await runInterceptCommand(harness, sessionId, "/intercept on", "enable");

        let failure: Error | null = null;
        try {
            await harness.sendPrompt(sessionId, "say hello briefly", {
                label: "invalid event stream",
                timeoutMs: 4_000,
            });
        } catch (error) {
            failure = error as Error;
        }

        const statusAfterMalformedPrompt = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "status after invalid event stream",
        );
        const malformedTrios = collectDumpTrios(
            harness.inspectDumpRoot(statusAfterMalformedPrompt.parsed.dumpRoot),
            statusAfterMalformedPrompt.summary,
            "invalid event stream",
        );
        const latestTrio = malformedTrios.at(-1);

        expect(failure).toBeInstanceOf(Error);
        expect(failure?.message).toContain("Prompt roundtrip failed for invalid event stream");
        expect(failure?.message).toContain("providerRequestCount=");
        expect(failure?.message).toContain("providerRequestDelta=");
        expect(failure?.message).toContain("dumpInspection=");
        expect(failure?.message).toContain(statusAfterMalformedPrompt.parsed.dumpRoot);
        expect(failure?.message).toContain("mockRequests=");
        expect(failure?.message).toContain("say hello briefly");
        expect(failure?.message).toContain("--- stdout ---");
        expect(failure?.message).toContain("--- stderr ---");
        expect(statusAfterMalformedPrompt.parsed.captures).toBeGreaterThanOrEqual(1);
        expect(statusAfterMalformedPrompt.parsed.anomalies).toBeGreaterThanOrEqual(1);
        expect(statusAfterMalformedPrompt.parsed.latestAnomalyPhase).toBe("capture/response-parse");
        expect(statusAfterMalformedPrompt.parsed.latestAnomalyMessage).toContain(
            "event stream frame data was not valid JSON",
        );
        expect(latestTrio).toBeDefined();
        expect(latestTrio?.responsePayload.status).toBe(200);
        expect(latestTrio?.responsePayload.body).toBeNull();
        expect(latestTrio?.responsePayload.bodyFormat).toBe("omitted");
        expect(latestTrio?.responsePayload.bodyReadError).toBeNull();
        expect(latestTrio?.responsePayload.bodyOmittedReason).toBe("malformed-event-stream");
    }, 45_000);
});
