import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PLUGIN_ENTRY = resolve(import.meta.dir, "../../src/index.ts");
const DEFAULT_PLUGIN_SPEC = `file://${PLUGIN_ENTRY}`;
const READY_PATH = "/doc";
const DEFAULT_TIMEOUT_MS = 15_000;

export type SessionMessagePart = {
    type?: string;
    text?: string;
    ignored?: boolean;
};

export type SessionMessage = {
    info?: {
        role?: string;
        id?: string;
    };
    parts?: SessionMessagePart[];
};

type SdkResponse<T> =
    | T
    | {
          data?: T;
      };

type SessionCommandResult = {
    info?: {
        role?: string;
    };
    parts?: SessionMessagePart[];
};

type OpencodeClient = {
    session: {
        create: (input: {
            query: {
                directory: string;
            };
        }) => Promise<SdkResponse<{ id: string }>>;
        command?: (input: {
            path: { id: string };
            query?: { directory?: string };
            body: {
                command: string;
                arguments: string;
            };
        }) => Promise<SdkResponse<SessionCommandResult>>;
        prompt: (input: {
            path: { id: string };
            query?: { directory?: string };
            body: {
                parts: Array<{ type: "text"; text: string }>;
            };
        }) => Promise<unknown>;
        messages?: (input: {
            path: { id: string };
            query: { directory: string };
        }) => Promise<SdkResponse<SessionMessage[]>>;
    };
};

type IsolatedEnv = {
    configDir: string;
    dataDir: string;
    cacheDir: string;
    workdir: string;
};

export type MockProviderMode = "streaming-text" | "http-error" | "stall" | "invalid-event-stream";

export type DumpInspectionEntry = {
    relativePath: string;
    type: "file" | "directory";
    size: number;
    content?: string;
};

export type DumpInspection = {
    root: string;
    exists: boolean;
    entries: DumpInspectionEntry[];
};

export type InterceptSummary = {
    enabled: boolean;
    dumpRoot: string;
    captures: number;
    totalBytes: number;
    anomalies: number;
    latestAnomalyPhase: string | null;
    latestAnomalyMessage: string | null;
};

export type InterceptCommandResult = {
    summary: string;
    parsed: InterceptSummary;
};

export type DumpResponsePayload = {
    status: number;
    statusText: string;
    body: unknown;
    bodyFormat: string;
    bodyReadError: string | null;
    bodyOmittedReason: string | null;
};

export type DumpMetaPayload = {
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

export type DumpTrio = {
    basename: string;
    requestPath: string;
    responsePath: string;
    metaPath: string;
    requestPayload: Record<string, unknown>;
    responsePayload: DumpResponsePayload;
    metaPayload: DumpMetaPayload;
};

export type PromptRoundtripResult = {
    promptResult: unknown;
    allMessages: SessionMessage[];
    newMessages: SessionMessage[];
    latestAssistantText: string | null;
    providerRequestCount: number;
    providerRequestDelta: number;
    latestInterceptSummary: string | null;
    dumpInspection: DumpInspection | null;
};

export type StartServeOptions = {
    pluginSpec?: string | null;
    port?: number;
    startupTimeoutMs?: number;
    rawConfigText?: string;
    mockProviderMode?: MockProviderMode;
};

function normalizeData<T>(value: SdkResponse<T>): T | undefined {
    if (value && typeof value === "object" && "data" in value) {
        return value.data;
    }

    return value as T;
}

function normalizeMessages(value: SdkResponse<SessionMessage[]>): SessionMessage[] {
    const data = normalizeData(value);
    return Array.isArray(data) ? data : [];
}

function pickFreePort(): number {
    const server = Bun.serve({
        port: 0,
        fetch: () => new Response("ok"),
    });
    const port = server.port;
    server.stop(true);

    if (typeof port !== "number") {
        throw new Error("Could not allocate a free port for opencode serve.");
    }

    return port;
}

function createIsolatedEnv(): IsolatedEnv {
    const id = `opencode-interceptor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const root = join(tmpdir(), id);
    const env = {
        configDir: join(root, "config"),
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        workdir: join(root, "workdir"),
    };

    mkdirSync(env.configDir, { recursive: true });
    mkdirSync(env.dataDir, { recursive: true });
    mkdirSync(env.cacheDir, { recursive: true });
    mkdirSync(env.workdir, { recursive: true });

    return env;
}

function buildStreamingAnthropicResponse(text: string) {
    const encoder = new TextEncoder();
    const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

    return new ReadableStream({
        start(controller) {
            const send = (event: string, payload: Record<string, unknown>) => {
                controller.enqueue(
                    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
                );
            };

            send("message_start", {
                type: "message_start",
                message: {
                    id: messageId,
                    type: "message",
                    role: "assistant",
                    model: "mock-sonnet",
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: {
                        input_tokens: 1,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                },
            });
            send("content_block_start", {
                type: "content_block_start",
                index: 0,
                content_block: {
                    type: "text",
                    text: "",
                },
            });
            send("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: {
                    type: "text_delta",
                    text,
                },
            });
            send("content_block_stop", {
                type: "content_block_stop",
                index: 0,
            });
            send("message_delta", {
                type: "message_delta",
                delta: {
                    stop_reason: "end_turn",
                    stop_sequence: null,
                },
                usage: {
                    output_tokens: 1,
                },
            });
            send("message_stop", {
                type: "message_stop",
            });
            controller.close();
        },
    });
}

class MockAnthropicServer {
    private server: ReturnType<typeof Bun.serve> | null = null;
    private capturedBodies: unknown[] = [];

    constructor(private readonly mode: MockProviderMode = "streaming-text") {}

    async start() {
        this.server = Bun.serve({
            port: 0,
            fetch: async (request) => {
                const url = new URL(request.url);
                const isMessagesRoute =
                    url.pathname === "/messages" || url.pathname === "/v1/messages";

                if (request.method === "POST" && isMessagesRoute) {
                    let body: unknown = null;
                    try {
                        body = await request.json();
                    } catch {
                        body = null;
                    }

                    this.capturedBodies.push(body);

                    if (this.mode === "http-error") {
                        return new Response(
                            JSON.stringify({
                                error: {
                                    type: "mock_provider_error",
                                    api_key: "provider-http-error-secret",
                                    nested: {
                                        token: "http-error-token",
                                        path: url.pathname,
                                    },
                                },
                            }),
                            {
                                status: 503,
                                headers: {
                                    "content-type": "application/json",
                                },
                            },
                        );
                    }

                    if (this.mode === "stall") {
                        return new Response(
                            new ReadableStream({
                                start() {},
                            }),
                            {
                                status: 200,
                                headers: {
                                    "content-type": "text/event-stream",
                                    "cache-control": "no-cache",
                                    connection: "keep-alive",
                                },
                            },
                        );
                    }

                    if (this.mode === "invalid-event-stream") {
                        return new Response("event: message_start\ndata: {this-is-not-json}\n\n", {
                            status: 200,
                            headers: {
                                "content-type": "text/event-stream",
                                "cache-control": "no-cache",
                                connection: "keep-alive",
                            },
                        });
                    }

                    return new Response(
                        buildStreamingAnthropicResponse("unexpected model fallback"),
                        {
                            status: 200,
                            headers: {
                                "content-type": "text/event-stream",
                                "cache-control": "no-cache",
                                connection: "keep-alive",
                            },
                        },
                    );
                }

                return new Response(JSON.stringify({ error: "not_found", path: url.pathname }), {
                    status: 404,
                    headers: {
                        "content-type": "application/json",
                    },
                });
            },
        });

        const port = this.server.port;
        if (typeof port !== "number") {
            throw new Error("Mock Anthropic server failed to bind a port.");
        }

        return {
            port,
            baseUrl: `http://127.0.0.1:${port}`,
        };
    }

    requestCount() {
        return this.capturedBodies.length;
    }

    requests() {
        return [...this.capturedBodies];
    }

    async stop() {
        this.server?.stop(true);
        this.server = null;
    }
}

function writeOpencodeConfig(
    env: IsolatedEnv,
    mockProviderBaseUrl: string,
    pluginSpec: string | null,
    rawConfigText?: string,
) {
    const config = {
        $schema: "https://opencode.ai/config.json",
        autoupdate: false,
        model: "mock-anthropic/mock-sonnet",
        compaction: {
            auto: false,
            prune: false,
        },
        plugin: pluginSpec ? [pluginSpec] : [],
        provider: {
            "mock-anthropic": {
                api: "@ai-sdk/anthropic",
                npm: "@ai-sdk/anthropic",
                name: "Mock Anthropic",
                env: [],
                options: {
                    apiKey: "test-key-not-real",
                    baseURL: mockProviderBaseUrl,
                },
                models: {
                    "mock-sonnet": {
                        id: "mock-sonnet",
                        name: "Mock Sonnet",
                        cost: {
                            input: 0,
                            output: 0,
                        },
                        limit: {
                            context: 200_000,
                            output: 8_192,
                        },
                        modalities: {
                            input: ["text"],
                            output: ["text"],
                        },
                        options: {},
                    },
                },
            },
        },
    };

    const configText = rawConfigText ?? JSON.stringify(config, null, 2);
    const nestedConfigDir = join(env.configDir, "opencode");
    mkdirSync(nestedConfigDir, { recursive: true });

    writeFileSync(join(env.configDir, "opencode.json"), configText);
    writeFileSync(join(nestedConfigDir, "opencode.json"), configText);
}

async function waitForReady(
    url: string,
    child: ChildProcess,
    stdout: () => string,
    stderr: () => string,
    timeoutMs: number,
) {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(
                [
                    "opencode serve exited before becoming ready.",
                    `exitCode=${child.exitCode} signal=${child.signalCode}`,
                    "--- stdout ---",
                    stdout(),
                    "--- stderr ---",
                    stderr(),
                ].join("\n"),
            );
        }

        try {
            const response = await fetch(`${url}${READY_PATH}`);
            const body = await response.text();
            const hasServerReadyLog = stdout().includes("opencode server listening on");
            const looksLikeOpencodeDoc = body.includes("OpenAPI") || body.includes("Swagger");
            if (
                hasServerReadyLog &&
                (response.ok ||
                    response.status === 404 ||
                    response.status === 401 ||
                    looksLikeOpencodeDoc)
            ) {
                return;
            }
        } catch (error) {
            lastError = error;
        }

        await Bun.sleep(100);
    }

    throw new Error(
        [
            `opencode serve did not become ready within ${timeoutMs}ms.`,
            `lastError=${String(lastError)}`,
            "--- stdout ---",
            stdout(),
            "--- stderr ---",
            stderr(),
        ].join("\n"),
    );
}

function extractIgnoredTexts(messages: SessionMessage[]): string[] {
    return messages
        .flatMap((message) => message.parts ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string" && part.ignored)
        .map((part) => part.text ?? "");
}

function extractSummaryTexts(value: unknown): string[] {
    const result = normalizeData(value as SdkResponse<SessionCommandResult>);
    if (!result?.parts) {
        return [];
    }

    return result.parts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "");
}

function extractTextParts(
    messages: SessionMessage[],
    options: { includeIgnored?: boolean } = {},
): string[] {
    const includeIgnored = options.includeIgnored ?? true;

    return messages
        .flatMap((message) => message.parts ?? [])
        .filter(
            (part) =>
                part.type === "text" &&
                typeof part.text === "string" &&
                (includeIgnored || !part.ignored),
        )
        .map((part) => part.text ?? "");
}

function createTimeoutError(label: string, timeoutMs: number): Error {
    return new Error(`${label} timed out after ${timeoutMs}ms.`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(createTimeoutError(label, timeoutMs)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

function inspectDumpRoot(root: string): DumpInspection {
    if (!existsSync(root)) {
        return {
            root,
            exists: false,
            entries: [],
        };
    }

    const entries: DumpInspectionEntry[] = [];
    const walk = (currentPath: string, relativePrefix = "") => {
        for (const name of readdirSync(currentPath)) {
            const absolutePath = join(currentPath, name);
            const relativePath = relativePrefix ? join(relativePrefix, name) : name;
            const stat = statSync(absolutePath);

            if (stat.isDirectory()) {
                entries.push({
                    relativePath,
                    type: "directory",
                    size: stat.size,
                });
                walk(absolutePath, relativePath);
                continue;
            }

            entries.push({
                relativePath,
                type: "file",
                size: stat.size,
                content: readFileSync(absolutePath, "utf8"),
            });
        }
    };

    walk(root);

    return {
        root,
        exists: true,
        entries: entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    };
}

export function formatDumpInspection(inspection: DumpInspection | null | undefined): string {
    return inspection ? JSON.stringify(inspection, null, 2) : "null";
}

function pickLatestInterceptSummary(messageTexts: string[]): string | null {
    return [...messageTexts].reverse().find((text) => text.includes("## Interceptor")) ?? null;
}

function parseSlashCommand(text: string) {
    const normalized = text.trim();
    const withoutSlash = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    const [command = "", ...argumentParts] = withoutSlash.split(/\s+/).filter(Boolean);

    return {
        command,
        argumentsText: argumentParts.join(" "),
    };
}

export function parseInterceptSummary(summary: string): InterceptSummary {
    const enabledMatch = summary.match(/- Enabled: (enabled|disabled)/);
    const dumpRootMatch = summary.match(/- Dump root: (.+)/);
    const capturesMatch = summary.match(/- Captures: (\d+)/);
    const totalBytesMatch = summary.match(/- Total bytes: (\d+)/);
    const anomaliesMatch = summary.match(/- Anomalies: (\d+)/);
    const latestAnomalyPhaseMatch = summary.match(/- Latest anomaly phase: (.+)/);
    const latestAnomalyMessageMatch = summary.match(/- Latest anomaly message: (.+)/);

    if (!enabledMatch || !dumpRootMatch || !capturesMatch || !totalBytesMatch) {
        throw new Error(`Malformed /intercept summary payload:\n${summary}`);
    }

    return {
        enabled: enabledMatch[1] === "enabled",
        dumpRoot: dumpRootMatch[1].trim(),
        captures: Number(capturesMatch[1]),
        totalBytes: Number(totalBytesMatch[1]),
        anomalies: anomaliesMatch ? Number(anomaliesMatch[1]) : 0,
        latestAnomalyPhase:
            latestAnomalyPhaseMatch && latestAnomalyPhaseMatch[1].trim() !== "none"
                ? latestAnomalyPhaseMatch[1].trim()
                : null,
        latestAnomalyMessage:
            latestAnomalyMessageMatch && latestAnomalyMessageMatch[1].trim() !== "none"
                ? latestAnomalyMessageMatch[1].trim()
                : null,
    };
}

export async function runInterceptCommand(
    harness: OpencodeServeHarness,
    sessionId: string,
    commandText: string,
    label: string,
): Promise<InterceptCommandResult> {
    await harness.sendSlashCommand(sessionId, commandText);
    const summary = await harness.waitForInterceptSummary(sessionId, { label });

    if (!summary) {
        throw new Error(`No /intercept summary returned for ${label}.`);
    }

    return {
        summary,
        parsed: parseInterceptSummary(summary),
    };
}

function failMalformedDump(
    label: string,
    summary: string,
    inspection: DumpInspection | null,
): never {
    throw new Error(
        [
            `Malformed dump trio inspection for ${label}.`,
            `summary=${summary}`,
            `dumpInspection=${formatDumpInspection(inspection)}`,
        ].join("\n"),
    );
}

function parseInspectionJson<T>(
    entryContent: string | undefined,
    entryPath: string,
    label: string,
    summary: string,
    inspection: DumpInspection,
): T {
    if (typeof entryContent !== "string") {
        throw new Error(
            [
                `Dump file content missing for ${label}: ${entryPath}`,
                `summary=${summary}`,
                `dumpInspection=${formatDumpInspection(inspection)}`,
            ].join("\n"),
        );
    }

    try {
        return JSON.parse(entryContent) as T;
    } catch (error) {
        throw new Error(
            [
                `Dump file contained malformed JSON for ${label}: ${entryPath}`,
                `cause=${error instanceof Error ? error.message : String(error)}`,
                `rawContent=${entryContent}`,
                `summary=${summary}`,
                `dumpInspection=${formatDumpInspection(inspection)}`,
            ].join("\n"),
        );
    }
}

export function collectDumpTrios(
    inspection: DumpInspection | null,
    summary: string,
    label: string,
): DumpTrio[] {
    if (!inspection?.exists) {
        failMalformedDump(label, summary, inspection);
    }

    const grouped = new Map<
        string,
        Partial<Record<"request" | "response" | "meta", { relativePath: string; content?: string }>>
    >();

    for (const entry of inspection.entries) {
        if (entry.type !== "file") {
            continue;
        }

        const match = entry.relativePath.match(/^(?<basename>.+)\.(request|response|meta)\.json$/);
        if (!match?.groups?.basename) {
            failMalformedDump(label, summary, inspection);
        }

        const basename = match.groups.basename;
        const suffix = entry.relativePath.slice(basename.length + 1, -5) as
            | "request"
            | "response"
            | "meta";
        const current = grouped.get(basename) ?? {};
        current[suffix] = {
            relativePath: entry.relativePath,
            content: entry.content,
        };
        grouped.set(basename, current);
    }

    return [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([basename, trio]) => {
            if (!trio.request || !trio.response || !trio.meta) {
                failMalformedDump(label, summary, inspection);
            }

            return {
                basename,
                requestPath: trio.request.relativePath,
                responsePath: trio.response.relativePath,
                metaPath: trio.meta.relativePath,
                requestPayload: parseInspectionJson<Record<string, unknown>>(
                    trio.request.content,
                    trio.request.relativePath,
                    label,
                    summary,
                    inspection,
                ),
                responsePayload: parseInspectionJson<DumpResponsePayload>(
                    trio.response.content,
                    trio.response.relativePath,
                    label,
                    summary,
                    inspection,
                ),
                metaPayload: parseInspectionJson<DumpMetaPayload>(
                    trio.meta.content,
                    trio.meta.relativePath,
                    label,
                    summary,
                    inspection,
                ),
            };
        });
}

export class OpencodeServeHarness {
    readonly env: IsolatedEnv;
    readonly url: string;
    readonly port: number;

    private readonly child: ChildProcess;
    private readonly client: OpencodeClient;
    private readonly mock: MockAnthropicServer;
    private readonly stdoutBuffer: { value: string };
    private readonly stderrBuffer: { value: string };
    private lastCommandResult: unknown = null;

    private constructor(input: {
        env: IsolatedEnv;
        url: string;
        port: number;
        child: ChildProcess;
        client: OpencodeClient;
        mock: MockAnthropicServer;
        stdoutBuffer: { value: string };
        stderrBuffer: { value: string };
    }) {
        this.env = input.env;
        this.url = input.url;
        this.port = input.port;
        this.child = input.child;
        this.client = input.client;
        this.mock = input.mock;
        this.stdoutBuffer = input.stdoutBuffer;
        this.stderrBuffer = input.stderrBuffer;
    }

    static async start(options: StartServeOptions = {}) {
        const env = createIsolatedEnv();
        const mock = new MockAnthropicServer(options.mockProviderMode);
        const { baseUrl } = await mock.start();

        writeOpencodeConfig(
            env,
            baseUrl,
            options.pluginSpec === undefined ? DEFAULT_PLUGIN_SPEC : options.pluginSpec,
            options.rawConfigText,
        );

        const port = options.port ?? pickFreePort();
        const stdoutBuffer = { value: "" };
        const stderrBuffer = { value: "" };

        const childEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value !== "string") {
                continue;
            }
            if (key === "OPENCODE_SERVER_PASSWORD" || key === "OPENCODE_SERVER_USERNAME") {
                continue;
            }
            childEnv[key] = value;
        }
        childEnv.OPENCODE_CONFIG_DIR = env.configDir;
        childEnv.XDG_CONFIG_HOME = env.configDir;
        childEnv.XDG_DATA_HOME = env.dataDir;
        childEnv.XDG_CACHE_HOME = env.cacheDir;

        const child = spawn(
            "opencode",
            ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"],
            {
                cwd: env.workdir,
                env: childEnv,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        child.stdout?.on("data", (chunk: Buffer) => {
            stdoutBuffer.value += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderrBuffer.value += chunk.toString();
        });

        const url = `http://127.0.0.1:${port}`;
        await waitForReady(
            url,
            child,
            () => stdoutBuffer.value,
            () => stderrBuffer.value,
            options.startupTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        );

        const sdk = await import("@opencode-ai/sdk");
        const client = sdk.createOpencodeClient({ baseUrl: url }) as unknown as OpencodeClient;

        return new OpencodeServeHarness({
            env,
            url,
            port,
            child,
            client,
            mock,
            stdoutBuffer,
            stderrBuffer,
        });
    }

    stdout() {
        return this.stdoutBuffer.value;
    }

    stderr() {
        return this.stderrBuffer.value;
    }

    modelRequestCount() {
        return this.mock.requestCount();
    }

    modelRequests() {
        return this.mock.requests();
    }

    inspectDumpRoot(root: string): DumpInspection {
        return inspectDumpRoot(root);
    }

    async latestInterceptSummary(sessionId: string): Promise<string | null> {
        const commandSummary = pickLatestInterceptSummary(
            extractSummaryTexts(this.lastCommandResult),
        );
        if (commandSummary) {
            return commandSummary;
        }

        return pickLatestInterceptSummary(extractIgnoredTexts(await this.listMessages(sessionId)));
    }

    private async buildPromptDiagnostics(sessionId: string, messages: SessionMessage[]) {
        const latestInterceptSummary = await this.latestInterceptSummary(sessionId);
        let dumpInspection: DumpInspection | null = null;

        if (latestInterceptSummary) {
            try {
                dumpInspection = inspectDumpRoot(
                    parseInterceptSummary(latestInterceptSummary).dumpRoot,
                );
            } catch {
                dumpInspection = null;
            }
        }

        return {
            latestInterceptSummary,
            dumpInspection,
            latestTexts: extractTextParts(messages),
            ignoredSummaries: extractIgnoredTexts(messages),
        };
    }

    private async throwPromptFailure(
        sessionId: string,
        input: {
            label: string;
            cause: unknown;
            promptResult: unknown;
            messages: SessionMessage[];
            baselineRequestCount: number;
        },
    ): Promise<never> {
        const diagnostics = await this.buildPromptDiagnostics(sessionId, input.messages);
        const providerRequestCount = this.modelRequestCount();
        const providerRequestDelta = providerRequestCount - input.baselineRequestCount;

        throw new Error(
            [
                `Prompt roundtrip failed${input.label ? ` for ${input.label}` : ""}.`,
                `cause=${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
                `providerRequestCount=${providerRequestCount}`,
                `providerRequestDelta=${providerRequestDelta}`,
                `latestInterceptSummary=${JSON.stringify(diagnostics.latestInterceptSummary)}`,
                `latestTexts=${JSON.stringify(diagnostics.latestTexts, null, 2)}`,
                `ignoredSummaries=${JSON.stringify(diagnostics.ignoredSummaries, null, 2)}`,
                `dumpInspection=${formatDumpInspection(diagnostics.dumpInspection)}`,
                `promptResult=${JSON.stringify(input.promptResult, null, 2)}`,
                `messages=${JSON.stringify(input.messages, null, 2)}`,
                `mockRequests=${JSON.stringify(this.modelRequests(), null, 2)}`,
                "--- stdout ---",
                this.stdout(),
                "--- stderr ---",
                this.stderr(),
            ].join("\n"),
        );
    }

    async sendPrompt(
        sessionId: string,
        text: string,
        options: {
            timeoutMs?: number;
            label?: string;
            minimumProviderRequests?: number;
            requireAssistantText?: boolean;
        } = {},
    ): Promise<PromptRoundtripResult> {
        if (typeof this.client.session.prompt !== "function") {
            throw new Error("OpenCode SDK session.prompt() API is unavailable in this runtime.");
        }

        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const label = options.label ?? text;
        const minimumProviderRequests = options.minimumProviderRequests ?? 1;
        const requireAssistantText = options.requireAssistantText ?? true;
        const baselineMessages = await this.listMessages(sessionId);
        const baselineMessageIds = new Set(
            baselineMessages.map((message) => message.info?.id).filter(Boolean) as string[],
        );
        const baselineRequestCount = this.modelRequestCount();
        let promptResult: unknown = null;

        try {
            promptResult = await withTimeout(
                this.client.session.prompt({
                    path: { id: sessionId },
                    query: { directory: this.env.workdir },
                    body: {
                        parts: [{ type: "text", text }],
                    },
                }),
                timeoutMs,
                `session.prompt(${label})`,
            );
        } catch (error) {
            return this.throwPromptFailure(sessionId, {
                label,
                cause: error,
                promptResult,
                messages: baselineMessages,
                baselineRequestCount,
            });
        }

        const normalizedPrompt = normalizeData(promptResult as SdkResponse<SessionCommandResult>);
        if (
            !normalizedPrompt ||
            normalizedPrompt.info?.role !== "assistant" ||
            !Array.isArray(normalizedPrompt.parts)
        ) {
            return this.throwPromptFailure(sessionId, {
                label,
                cause: new Error("session.prompt() returned an unexpected payload."),
                promptResult,
                messages: await this.listMessages(sessionId),
                baselineRequestCount,
            });
        }

        const deadline = Date.now() + timeoutMs;
        let latestMessages = baselineMessages;

        while (Date.now() < deadline) {
            latestMessages = await this.listMessages(sessionId);
            const newMessages = latestMessages.filter(
                (message) => !baselineMessageIds.has(message.info?.id ?? ""),
            );
            const latestAssistantText =
                [...extractTextParts(newMessages, { includeIgnored: false })].reverse()[0] ?? null;
            const providerRequestCount = this.modelRequestCount();
            const providerRequestDelta = providerRequestCount - baselineRequestCount;

            if (providerRequestDelta >= minimumProviderRequests) {
                const latestInterceptSummary = await this.latestInterceptSummary(sessionId);
                const dumpInspection = latestInterceptSummary
                    ? inspectDumpRoot(parseInterceptSummary(latestInterceptSummary).dumpRoot)
                    : null;

                if (!requireAssistantText || latestAssistantText) {
                    return {
                        promptResult,
                        allMessages: latestMessages,
                        newMessages,
                        latestAssistantText,
                        providerRequestCount,
                        providerRequestDelta,
                        latestInterceptSummary,
                        dumpInspection,
                    };
                }
            }

            if (this.child.exitCode !== null || this.child.signalCode !== null) {
                break;
            }

            await Bun.sleep(100);
        }

        return this.throwPromptFailure(sessionId, {
            label,
            cause: new Error(
                `Prompt did not settle with >=${minimumProviderRequests} provider request(s)${requireAssistantText ? " and assistant text" : ""}.`,
            ),
            promptResult,
            messages: latestMessages,
            baselineRequestCount,
        });
    }

    async createSession() {
        const response = await this.client.session.create({
            query: {
                directory: this.env.workdir,
            },
        });
        const data = normalizeData(response);
        if (!data?.id) {
            throw new Error(
                [
                    "session.create did not return a session id.",
                    `response=${JSON.stringify(response, null, 2)}`,
                    "--- stdout ---",
                    this.stdout(),
                    "--- stderr ---",
                    this.stderr(),
                ].join("\n"),
            );
        }

        return data.id;
    }

    async sendSlashCommand(sessionId: string, text: string) {
        const parsed = parseSlashCommand(text);

        if (typeof this.client.session.command !== "function") {
            throw new Error("OpenCode SDK session.command() API is unavailable in this runtime.");
        }

        try {
            this.lastCommandResult = await this.client.session.command({
                path: { id: sessionId },
                query: { directory: this.env.workdir },
                body: {
                    command: parsed.command,
                    arguments: parsed.argumentsText,
                },
            });
        } catch (error) {
            this.lastCommandResult = {
                error: error instanceof Error ? error.message : String(error),
            };
        }

        return this.lastCommandResult;
    }

    async listMessages(sessionId: string) {
        if (typeof this.client.session.messages !== "function") {
            return [] as SessionMessage[];
        }

        const response = await this.client.session.messages({
            path: { id: sessionId },
            query: { directory: this.env.workdir },
        });

        return normalizeMessages(response);
    }

    async waitForInterceptSummary(
        sessionId: string,
        options: {
            timeoutMs?: number;
            label?: string;
        } = {},
    ) {
        const timeoutMs = options.timeoutMs ?? 5_000;
        const deadline = Date.now() + timeoutMs;
        let lastTexts: string[] = [];

        while (Date.now() < deadline) {
            const commandTexts = extractSummaryTexts(this.lastCommandResult);
            const directSummary = commandTexts.find((text) => text.includes("## Interceptor"));
            if (directSummary) {
                return directSummary;
            }

            const messages = await this.listMessages(sessionId);
            lastTexts = extractIgnoredTexts(messages);
            const summary = [...lastTexts]
                .reverse()
                .find((text) => text.includes("## Interceptor"));
            if (summary) {
                return summary;
            }

            if (this.child.exitCode !== null || this.child.signalCode !== null) {
                break;
            }

            await Bun.sleep(100);
        }

        throw new Error(
            [
                `Did not observe an ignored /intercept reply${options.label ? ` for ${options.label}` : ""}.`,
                `modelRequests=${this.modelRequestCount()}`,
                `lastCommandResult=${JSON.stringify(this.lastCommandResult, null, 2)}`,
                `ignoredTexts=${JSON.stringify(lastTexts, null, 2)}`,
                `mockRequests=${JSON.stringify(this.mock.requests(), null, 2)}`,
                "--- stdout ---",
                this.stdout(),
                "--- stderr ---",
                this.stderr(),
            ].join("\n"),
        );
    }

    async dispose() {
        if (this.child.exitCode === null && this.child.signalCode === null) {
            this.child.kill("SIGTERM");
            await new Promise<void>((resolve) => {
                const forceTimer = setTimeout(() => {
                    this.child.kill("SIGKILL");
                    resolve();
                }, 2_000);
                this.child.once("exit", () => {
                    clearTimeout(forceTimer);
                    resolve();
                });
            });
        }

        await this.mock.stop();
    }
}
