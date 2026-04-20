import { afterEach, describe, expect, test } from "bun:test";
import type { DumpInspection, InterceptCommandResult } from "../helpers/opencodeServe";
import {
    collectDumpTrios,
    formatDumpInspection,
    OpencodeServeHarness,
    runInterceptCommand,
} from "../helpers/opencodeServe";

let harness: OpencodeServeHarness | null = null;

afterEach(async () => {
    await harness?.dispose();
    harness = null;
});

function buildProofDiagnostics(
    phase: string,
    status: InterceptCommandResult,
    inspection: DumpInspection | null,
): string {
    return [
        `phase=${phase}`,
        `latestInterceptSummary=${JSON.stringify(status.summary)}`,
        `dumpInspection=${formatDumpInspection(inspection)}`,
        `mockRequests=${JSON.stringify(harness?.modelRequests() ?? [], null, 2)}`,
        "--- stdout ---",
        harness?.stdout() ?? "",
        "--- stderr ---",
        harness?.stderr() ?? "",
    ].join("\n");
}

function assertNoDumpGrowth(
    phase: string,
    status: InterceptCommandResult,
    inspection: DumpInspection | null,
) {
    const entryCount = inspection?.entries.length ?? 0;
    if (status.parsed.captures !== 0 || status.parsed.totalBytes !== 0 || entryCount !== 0) {
        throw new Error(
            [
                `Expected disabled interceptor state to remain inert during ${phase}.`,
                buildProofDiagnostics(phase, status, inspection),
            ].join("\n"),
        );
    }
}

describe("opencode serve milestone toggle proof via the real runtime harness", () => {
    test("one real session truthfully stays inert while disabled, captures while enabled, and stops again after disable", async () => {
        harness = await OpencodeServeHarness.start();
        const sessionId = await harness.createSession();

        const initialStatus = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "initial status",
        );
        expect(initialStatus.summary).toContain("## Interceptor Status");
        expect(initialStatus.parsed.enabled).toBe(false);
        expect(initialStatus.parsed.captures).toBe(0);
        expect(initialStatus.parsed.totalBytes).toBe(0);
        expect(initialStatus.parsed.anomalies).toBe(0);
        expect(initialStatus.parsed.latestAnomalyPhase).toBeNull();
        expect(initialStatus.parsed.latestAnomalyMessage).toBeNull();

        const disabledBeforeEnablePrompt = await harness.sendPrompt(
            sessionId,
            "say hello before enable",
            {
                label: "disabled before enable",
            },
        );
        const statusAfterDisabledBeforeEnable = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "status after disabled-before-enable prompt",
        );

        expect(disabledBeforeEnablePrompt.providerRequestDelta).toBeGreaterThanOrEqual(1);
        expect(disabledBeforeEnablePrompt.latestAssistantText).toContain(
            "unexpected model fallback",
        );
        expect(disabledBeforeEnablePrompt.latestInterceptSummary).toBe(initialStatus.summary);
        expect(statusAfterDisabledBeforeEnable.parsed.enabled).toBe(false);
        expect(statusAfterDisabledBeforeEnable.parsed.dumpRoot).toBe(initialStatus.parsed.dumpRoot);
        expect(statusAfterDisabledBeforeEnable.parsed.anomalies).toBe(0);
        expect(statusAfterDisabledBeforeEnable.parsed.latestAnomalyPhase).toBeNull();
        expect(statusAfterDisabledBeforeEnable.parsed.latestAnomalyMessage).toBeNull();
        assertNoDumpGrowth(
            "disabled-before-enable",
            statusAfterDisabledBeforeEnable,
            disabledBeforeEnablePrompt.dumpInspection,
        );

        const enableReply = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept on",
            "enable",
        );
        expect(enableReply.summary).toContain("## Interceptor Enabled");
        expect(enableReply.parsed.enabled).toBe(true);
        expect(enableReply.parsed.dumpRoot).toBe(initialStatus.parsed.dumpRoot);
        expect(enableReply.parsed.captures).toBe(0);
        expect(enableReply.parsed.totalBytes).toBe(0);

        const enabledPrompt = await harness.sendPrompt(sessionId, "say hello after enable", {
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
        expect(enabledPrompt.latestAssistantText).toContain("unexpected model fallback");
        expect(enabledPrompt.latestInterceptSummary).toBe(enableReply.summary);
        expect(enabledTrios.length).toBeGreaterThanOrEqual(1);
        if (enabledPrompt.providerRequestDelta !== enabledTrios.length) {
            throw new Error(
                [
                    "Enabled prompt provider-request delta did not match the captured trio count.",
                    `providerRequestDelta=${enabledPrompt.providerRequestDelta}`,
                    `trioCount=${enabledTrios.length}`,
                    buildProofDiagnostics(
                        "enabled",
                        statusAfterEnabledPrompt,
                        enabledPrompt.dumpInspection,
                    ),
                ].join("\n"),
            );
        }

        expect(statusAfterEnabledPrompt.parsed.enabled).toBe(true);
        expect(statusAfterEnabledPrompt.parsed.dumpRoot).toBe(initialStatus.parsed.dumpRoot);
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
        expect(disableReply.summary).toContain("## Interceptor Disabled");
        expect(disableReply.parsed.enabled).toBe(false);
        expect(disableReply.parsed.dumpRoot).toBe(initialStatus.parsed.dumpRoot);
        expect(disableReply.parsed.captures).toBe(enabledTrios.length);
        expect(disableReply.parsed.totalBytes).toBe(enabledTotalBytes);
        expect(disableReply.parsed.anomalies).toBe(0);
        expect(disableReply.parsed.latestAnomalyPhase).toBeNull();
        expect(disableReply.parsed.latestAnomalyMessage).toBeNull();

        const disabledAfterEnablePrompt = await harness.sendPrompt(
            sessionId,
            "say hello after disable",
            {
                label: "disabled after enable",
            },
        );
        const statusAfterDisabledAfterEnable = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "status after disabled-after-enable prompt",
        );
        const disabledAfterEnableTrios = collectDumpTrios(
            disabledAfterEnablePrompt.dumpInspection,
            statusAfterDisabledAfterEnable.summary,
            "disabled after enable",
        );

        expect(disabledAfterEnablePrompt.providerRequestDelta).toBeGreaterThanOrEqual(1);
        expect(disabledAfterEnablePrompt.latestAssistantText).toContain(
            "unexpected model fallback",
        );
        expect(disabledAfterEnablePrompt.latestInterceptSummary).toBe(disableReply.summary);
        expect(statusAfterDisabledAfterEnable.parsed.enabled).toBe(false);
        expect(statusAfterDisabledAfterEnable.parsed.dumpRoot).toBe(initialStatus.parsed.dumpRoot);
        expect(statusAfterDisabledAfterEnable.parsed.captures).toBe(enabledTrios.length);
        expect(statusAfterDisabledAfterEnable.parsed.totalBytes).toBe(enabledTotalBytes);
        expect(statusAfterDisabledAfterEnable.parsed.anomalies).toBe(0);
        expect(statusAfterDisabledAfterEnable.parsed.latestAnomalyPhase).toBeNull();
        expect(statusAfterDisabledAfterEnable.parsed.latestAnomalyMessage).toBeNull();
        if (JSON.stringify(disabledAfterEnableTrios) !== JSON.stringify(enabledTrios)) {
            throw new Error(
                [
                    "Disabled-after-enable prompt changed the persisted dump inventory.",
                    buildProofDiagnostics(
                        "disabled-after-enable",
                        statusAfterDisabledAfterEnable,
                        disabledAfterEnablePrompt.dumpInspection,
                    ),
                ].join("\n"),
            );
        }

        expect(harness.modelRequestCount()).toBeGreaterThanOrEqual(
            disabledBeforeEnablePrompt.providerRequestDelta +
                enabledPrompt.providerRequestDelta +
                disabledAfterEnablePrompt.providerRequestDelta,
        );
    }, 45_000);
});
