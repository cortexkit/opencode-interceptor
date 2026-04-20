import {
    INTERCEPT_DISABLED_TITLE,
    INTERCEPT_ENABLED_TITLE,
    INTERCEPT_STATUS_TITLE,
    INTERCEPT_USAGE,
    INTERCEPT_USAGE_TITLE,
} from "./constants";
import { getInterceptDumpRoot, getInterceptStateSnapshot, setInterceptEnabled } from "./state";

export type InterceptCommandAction = "status" | "enable" | "disable" | "usage";

export function parseInterceptCommandAction(argumentsText: string): InterceptCommandAction {
    const normalized = argumentsText.trim().split(/\s+/).filter(Boolean);

    if (normalized.length === 0) {
        return "status";
    }

    if (normalized.length === 1 && normalized[0] === "on") {
        return "enable";
    }

    if (normalized.length === 1 && normalized[0] === "off") {
        return "disable";
    }

    return "usage";
}

export function buildInterceptStatusSummary(sessionId?: string | null): string {
    const snapshot = getInterceptStateSnapshot();
    const latestAnomalyPhase = snapshot.latestAnomaly
        ? `${snapshot.latestAnomaly.scope}/${snapshot.latestAnomaly.phase}`
        : "none";
    const latestAnomalyMessage = snapshot.latestAnomaly?.message ?? "none";

    return [
        INTERCEPT_STATUS_TITLE,
        "",
        `- Enabled: ${snapshot.enabled ? "enabled" : "disabled"}`,
        `- Dump root: ${getInterceptDumpRoot(sessionId)}`,
        `- Captures: ${snapshot.captureCount}`,
        `- Total bytes: ${snapshot.totalBytes}`,
        `- Anomalies: ${snapshot.anomalyCount}`,
        `- Latest anomaly phase: ${latestAnomalyPhase}`,
        `- Latest anomaly message: ${latestAnomalyMessage}`,
    ].join("\n");
}

export function executeInterceptCommand(input: {
    argumentsText: string;
    sessionId?: string | null;
}): string {
    const action = parseInterceptCommandAction(input.argumentsText);

    if (action === "status") {
        return buildInterceptStatusSummary(input.sessionId);
    }

    if (action === "enable") {
        setInterceptEnabled(true);
        return [INTERCEPT_ENABLED_TITLE, "", buildInterceptStatusSummary(input.sessionId)].join(
            "\n",
        );
    }

    if (action === "disable") {
        setInterceptEnabled(false);
        return [INTERCEPT_DISABLED_TITLE, "", buildInterceptStatusSummary(input.sessionId)].join(
            "\n",
        );
    }

    return [
        INTERCEPT_USAGE_TITLE,
        "",
        INTERCEPT_USAGE,
        "",
        buildInterceptStatusSummary(input.sessionId),
    ].join("\n");
}
