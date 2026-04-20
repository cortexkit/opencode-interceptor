export const INTERCEPT_REDACTED_VALUE = "[REDACTED]";

export type InterceptOmittedValue = {
    omitted: true;
    reason: string;
};

const INTERCEPT_SECRET_KEY_SEGMENTS = ["token", "password", "authorization", "secret"];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitKeySegments(key: string): string[] {
    return key
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
    return (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    );
}

export function omitInterceptValue(reason: string): InterceptOmittedValue {
    return {
        omitted: true,
        reason,
    };
}

export function isInterceptSecretKey(key: string): boolean {
    const segments = splitKeySegments(key);
    if (segments.length === 0) {
        return false;
    }

    const hasApiKeyPair = segments.some((segment, index) => {
        return segment === "api" && segments[index + 1] === "key";
    });
    if (hasApiKeyPair) {
        return true;
    }

    return INTERCEPT_SECRET_KEY_SEGMENTS.some((segment) => segments.includes(segment));
}

function scrubInterceptJsonValueInternal(value: unknown, seen: WeakSet<object>): unknown {
    if (isJsonPrimitive(value)) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => scrubInterceptJsonValueInternal(item, seen));
    }

    if (!isRecord(value)) {
        return omitInterceptValue("unsupported-non-json-value");
    }

    if (seen.has(value)) {
        return omitInterceptValue("circular-reference");
    }

    seen.add(value);

    const scrubbedEntries = Object.entries(value).map(([key, entryValue]) => {
        if (isInterceptSecretKey(key)) {
            return [key, INTERCEPT_REDACTED_VALUE] satisfies [string, unknown];
        }

        return [key, scrubInterceptJsonValueInternal(entryValue, seen)] satisfies [string, unknown];
    });

    seen.delete(value);
    return Object.fromEntries(scrubbedEntries);
}

export function scrubInterceptJsonValue(value: unknown): unknown {
    return scrubInterceptJsonValueInternal(value, new WeakSet<object>());
}
