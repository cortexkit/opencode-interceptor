import { beforeEach, describe, expect, test } from "bun:test";
import {
    buildInterceptStatusSummary,
    executeInterceptCommand,
    parseInterceptCommandAction,
} from "../../src/intercept/command";
import { UNKNOWN_SESSION_ID } from "../../src/intercept/constants";
import {
    getInterceptStateSnapshot,
    recordInterceptAnomaly,
    resetInterceptState,
} from "../../src/intercept/state";

function parseSummary(summary: string) {
    const enabledMatch = summary.match(/- Enabled: (enabled|disabled)/);
    const dumpRootMatch = summary.match(/- Dump root: (.+)/);
    const capturesMatch = summary.match(/- Captures: (\d+)/);
    const totalBytesMatch = summary.match(/- Total bytes: (\d+)/);
    const anomaliesMatch = summary.match(/- Anomalies: (\d+)/);
    const latestAnomalyPhaseMatch = summary.match(/- Latest anomaly phase: (.+)/);
    const latestAnomalyMessageMatch = summary.match(/- Latest anomaly message: (.+)/);

    if (
        !enabledMatch ||
        !dumpRootMatch ||
        !capturesMatch ||
        !totalBytesMatch ||
        !anomaliesMatch ||
        !latestAnomalyPhaseMatch ||
        !latestAnomalyMessageMatch
    ) {
        throw new Error(`Malformed summary:\n${summary}`);
    }

    return {
        enabled: enabledMatch[1] === "enabled",
        dumpRoot: dumpRootMatch[1].trim(),
        captures: Number(capturesMatch[1]),
        totalBytes: Number(totalBytesMatch[1]),
        anomalies: Number(anomaliesMatch[1]),
        latestAnomalyPhase: latestAnomalyPhaseMatch[1].trim(),
        latestAnomalyMessage: latestAnomalyMessageMatch[1].trim(),
    };
}

beforeEach(() => {
    resetInterceptState();
});

describe("intercept command state", () => {
    test("bare status is disabled by default and falls back to unknown-session", () => {
        const summary = buildInterceptStatusSummary();
        const parsed = parseSummary(summary);

        expect(parsed.enabled).toBe(false);
        expect(parsed.captures).toBe(0);
        expect(parsed.totalBytes).toBe(0);
        expect(parsed.anomalies).toBe(0);
        expect(parsed.latestAnomalyPhase).toBe("none");
        expect(parsed.latestAnomalyMessage).toBe("none");
        expect(parsed.dumpRoot).toEndWith(`/opencode-interceptor/${UNKNOWN_SESSION_ID}`);
    });

    test("on then off toggles the shared module state truthfully", () => {
        const enabledReply = executeInterceptCommand({
            argumentsText: "on",
            sessionId: "session-123",
        });
        let parsed = parseSummary(enabledReply);

        expect(enabledReply).toContain("## Interceptor Enabled");
        expect(parsed.enabled).toBe(true);
        expect(parsed.dumpRoot).toEndWith("/opencode-interceptor/session-123");
        expect(parsed.anomalies).toBe(0);
        expect(getInterceptStateSnapshot().enabled).toBe(true);

        const disabledReply = executeInterceptCommand({
            argumentsText: "off",
            sessionId: "session-123",
        });
        parsed = parseSummary(disabledReply);

        expect(disabledReply).toContain("## Interceptor Disabled");
        expect(parsed.enabled).toBe(false);
        expect(parsed.anomalies).toBe(0);
        expect(getInterceptStateSnapshot().enabled).toBe(false);
    });

    test("repeated toggles stay idempotent and preserve truthful counters", () => {
        executeInterceptCommand({ argumentsText: "on", sessionId: "repeat" });
        const secondOn = executeInterceptCommand({ argumentsText: "on", sessionId: "repeat" });
        const secondOnParsed = parseSummary(secondOn);

        expect(secondOnParsed.enabled).toBe(true);
        expect(secondOnParsed.captures).toBe(0);
        expect(secondOnParsed.totalBytes).toBe(0);
        expect(secondOnParsed.anomalies).toBe(0);

        executeInterceptCommand({ argumentsText: "off", sessionId: "repeat" });
        const secondOff = executeInterceptCommand({ argumentsText: "off", sessionId: "repeat" });
        const secondOffParsed = parseSummary(secondOff);

        expect(secondOffParsed.enabled).toBe(false);
        expect(secondOffParsed.captures).toBe(0);
        expect(secondOffParsed.totalBytes).toBe(0);
        expect(secondOffParsed.anomalies).toBe(0);
    });

    test("invalid subcommands and extra arguments return usage without mutating state", () => {
        executeInterceptCommand({ argumentsText: "on", sessionId: "kept-state" });

        const invalidReply = executeInterceptCommand({
            argumentsText: "on now",
            sessionId: "kept-state",
        });
        const invalidParsed = parseSummary(invalidReply);

        expect(invalidReply).toContain("## Interceptor Usage");
        expect(invalidReply).toContain(
            "Usage: `/intercept`, `/intercept on`, or `/intercept off`.",
        );
        expect(invalidParsed.enabled).toBe(true);
        expect(invalidParsed.anomalies).toBe(0);
        expect(getInterceptStateSnapshot().enabled).toBe(true);

        const malformedReply = executeInterceptCommand({
            argumentsText: "bogus",
            sessionId: "kept-state",
        });
        expect(malformedReply).toContain("## Interceptor Usage");
        expect(parseSummary(malformedReply).enabled).toBe(true);
    });

    test("status surfaces the latest anomaly phase and message without inventing success", () => {
        recordInterceptAnomaly({
            phase: "response-parse",
            message: "event stream frame data was not valid JSON",
        });

        const summary = buildInterceptStatusSummary("session-anomaly");
        const parsed = parseSummary(summary);

        expect(parsed.anomalies).toBe(1);
        expect(parsed.latestAnomalyPhase).toBe("capture/response-parse");
        expect(parsed.latestAnomalyMessage).toBe("event stream frame data was not valid JSON");
        expect(getInterceptStateSnapshot().latestAnomaly).toMatchObject({
            scope: "capture",
            phase: "response-parse",
        });
    });

    test("cleanup warnings reuse the shared anomaly summary surface", () => {
        recordInterceptAnomaly({
            scope: "cleanup",
            phase: "entry-delete",
            message: "Failed to delete expired cleanup entry stale-session: permission denied",
        });

        const summary = buildInterceptStatusSummary("cleanup-session");
        const parsed = parseSummary(summary);

        expect(parsed.anomalies).toBe(1);
        expect(parsed.latestAnomalyPhase).toBe("cleanup/entry-delete");
        expect(parsed.latestAnomalyMessage).toBe(
            "Failed to delete expired cleanup entry stale-session: permission denied",
        );
        expect(getInterceptStateSnapshot().latestAnomaly).toMatchObject({
            scope: "cleanup",
            phase: "entry-delete",
        });
    });

    test("the parser exposes deterministic actions for later slices", () => {
        expect(parseInterceptCommandAction("")).toBe("status");
        expect(parseInterceptCommandAction("   ")).toBe("status");
        expect(parseInterceptCommandAction("on")).toBe("enable");
        expect(parseInterceptCommandAction("off")).toBe("disable");
        expect(parseInterceptCommandAction("off please")).toBe("usage");
    });
});
