import { join } from "node:path";
import { INTERCEPT_DUMP_ROOT, UNKNOWN_SESSION_ID } from "./constants";

export type InterceptAnomalyScope = "capture" | "cleanup";

export type InterceptAnomaly = {
    scope: InterceptAnomalyScope;
    phase: string;
    message: string;
};

export type InterceptStateSnapshot = {
    enabled: boolean;
    captureCount: number;
    totalBytes: number;
    anomalyCount: number;
    latestAnomaly: InterceptAnomaly | null;
    activeSessionId: string | null;
    wrappedFetchInstalled: boolean;
    sessionSequenceById: Record<string, number>;
};

type InterceptFetchFunction = typeof globalThis.fetch;

type InterceptRuntimeState = {
    enabled: boolean;
    captureCount: number;
    totalBytes: number;
    anomalyCount: number;
    latestAnomaly: InterceptAnomaly | null;
    activeSessionId: string | null;
    wrappedFetchInstalled: boolean;
    originalFetch: InterceptFetchFunction | null;
    wrappedFetch: InterceptFetchFunction | null;
    sessionSequenceById: Map<string, number>;
};

const state: InterceptRuntimeState = {
    enabled: false,
    captureCount: 0,
    totalBytes: 0,
    anomalyCount: 0,
    latestAnomaly: null,
    activeSessionId: null,
    wrappedFetchInstalled: false,
    originalFetch: null,
    wrappedFetch: null,
    sessionSequenceById: new Map(),
};

function normalizeAnomalyText(value: string): string {
    const normalized = value.trim().replace(/\s+/g, " ");
    return normalized.length > 0 ? normalized : "unknown anomaly";
}

export function getInterceptStateSnapshot(): InterceptStateSnapshot {
    return {
        enabled: state.enabled,
        captureCount: state.captureCount,
        totalBytes: state.totalBytes,
        anomalyCount: state.anomalyCount,
        latestAnomaly: state.latestAnomaly,
        activeSessionId: state.activeSessionId,
        wrappedFetchInstalled: state.wrappedFetchInstalled,
        sessionSequenceById: Object.fromEntries(state.sessionSequenceById.entries()),
    };
}

export function resetInterceptState(): void {
    if (
        state.wrappedFetchInstalled &&
        state.originalFetch &&
        state.wrappedFetch &&
        globalThis.fetch === state.wrappedFetch
    ) {
        globalThis.fetch = state.originalFetch;
    }

    state.enabled = false;
    state.captureCount = 0;
    state.totalBytes = 0;
    state.anomalyCount = 0;
    state.latestAnomaly = null;
    state.activeSessionId = null;
    state.wrappedFetchInstalled = false;
    state.originalFetch = null;
    state.wrappedFetch = null;
    state.sessionSequenceById.clear();
}

export function isInterceptEnabled(): boolean {
    return state.enabled;
}

export function setInterceptEnabled(enabled: boolean): InterceptStateSnapshot {
    state.enabled = enabled;
    return getInterceptStateSnapshot();
}

export function recordInterceptCapture(bytes: number): InterceptStateSnapshot {
    state.captureCount += 1;
    state.totalBytes += Math.max(0, bytes);
    return getInterceptStateSnapshot();
}

export function recordInterceptAnomaly(input: {
    scope?: InterceptAnomalyScope;
    phase: string;
    message: string;
}): InterceptStateSnapshot {
    state.anomalyCount += 1;
    state.latestAnomaly = {
        scope: input.scope ?? "capture",
        phase: normalizeAnomalyText(input.phase),
        message: normalizeAnomalyText(input.message),
    };
    return getInterceptStateSnapshot();
}

export function resolveInterceptSessionId(sessionId?: string | null): string {
    const normalized = sessionId?.trim();
    return normalized ? normalized : UNKNOWN_SESSION_ID;
}

export function setActiveInterceptSession(sessionId?: string | null): string {
    const resolved = resolveInterceptSessionId(sessionId);
    state.activeSessionId = resolved;
    return resolved;
}

export function refreshActiveInterceptSession(sessionId?: string | null): string {
    const normalized = sessionId?.trim();

    if (!normalized) {
        state.activeSessionId = null;
        return UNKNOWN_SESSION_ID;
    }

    state.activeSessionId = normalized;
    return normalized;
}

export function clearActiveInterceptSession(): void {
    state.activeSessionId = null;
}

export function getActiveInterceptSessionId(): string | null {
    return state.activeSessionId;
}

export function getInterceptDumpRoot(sessionId?: string | null): string {
    return join(INTERCEPT_DUMP_ROOT, resolveInterceptSessionId(sessionId));
}

export function getActiveInterceptDumpRoot(): string {
    return getInterceptDumpRoot(state.activeSessionId);
}

export function allocateInterceptSequence(sessionId?: string | null): number {
    const resolved = resolveInterceptSessionId(sessionId ?? state.activeSessionId);
    const nextValue = (state.sessionSequenceById.get(resolved) ?? 0) + 1;
    state.sessionSequenceById.set(resolved, nextValue);
    return nextValue;
}

export function registerInterceptFetchWrapper(input: {
    originalFetch: InterceptFetchFunction;
    wrappedFetch: InterceptFetchFunction;
}): { installed: boolean; wrappedFetch: InterceptFetchFunction } {
    if (state.wrappedFetchInstalled && state.wrappedFetch) {
        return {
            installed: false,
            wrappedFetch: state.wrappedFetch,
        };
    }

    state.originalFetch = input.originalFetch;
    state.wrappedFetch = input.wrappedFetch;
    state.wrappedFetchInstalled = true;

    return {
        installed: true,
        wrappedFetch: input.wrappedFetch,
    };
}

export function getInterceptWrappedFetch(): InterceptFetchFunction | null {
    return state.wrappedFetch;
}

export function getInterceptOriginalFetch(): InterceptFetchFunction | null {
    return state.originalFetch;
}
