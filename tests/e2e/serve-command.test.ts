import { afterEach, describe, expect, test } from "bun:test";
import { OpencodeServeHarness, runInterceptCommand } from "../helpers/opencodeServe";

let harness: OpencodeServeHarness | null = null;

afterEach(async () => {
    await harness?.dispose();
    harness = null;
});

describe("opencode serve /intercept command seam", () => {
    test("the real server path supports status, toggles, repeats, and malformed inputs in one session", async () => {
        harness = await OpencodeServeHarness.start();
        const sessionId = await harness.createSession();

        const statusReply = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "initial status",
        );
        expect(statusReply.summary).toContain("## Interceptor Status");
        expect(statusReply.parsed.enabled).toBe(false);
        expect(statusReply.parsed.captures).toBe(0);
        expect(statusReply.parsed.totalBytes).toBe(0);
        expect(statusReply.parsed.dumpRoot).toContain("opencode-interceptor");

        const enableReply = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept on",
            "enable",
        );
        expect(enableReply.summary).toContain("## Interceptor Enabled");
        expect(enableReply.parsed.enabled).toBe(true);
        expect(enableReply.parsed.dumpRoot).toBe(statusReply.parsed.dumpRoot);
        expect(enableReply.parsed.captures).toBe(0);
        expect(enableReply.parsed.totalBytes).toBe(0);

        const repeatedEnableReply = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept on",
            "repeat enable",
        );
        expect(repeatedEnableReply.summary).toContain("## Interceptor Enabled");
        expect(repeatedEnableReply.parsed.enabled).toBe(true);
        expect(repeatedEnableReply.parsed.captures).toBe(0);
        expect(repeatedEnableReply.parsed.totalBytes).toBe(0);

        const usageWhileEnabled = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept bogus",
            "invalid subcommand while enabled",
        );
        expect(usageWhileEnabled.summary).toContain("## Interceptor Usage");
        expect(usageWhileEnabled.summary).toContain(
            "Usage: `/intercept`, `/intercept on`, or `/intercept off`.",
        );
        expect(usageWhileEnabled.parsed.enabled).toBe(true);
        expect(usageWhileEnabled.parsed.dumpRoot).toBe(statusReply.parsed.dumpRoot);

        const enabledStatusReply = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "status after enable",
        );
        expect(enabledStatusReply.summary).toContain("## Interceptor Status");
        expect(enabledStatusReply.parsed.enabled).toBe(true);

        const disableReply = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept off",
            "disable",
        );
        expect(disableReply.summary).toContain("## Interceptor Disabled");
        expect(disableReply.parsed.enabled).toBe(false);
        expect(disableReply.parsed.dumpRoot).toBe(statusReply.parsed.dumpRoot);
        expect(disableReply.parsed.captures).toBe(0);
        expect(disableReply.parsed.totalBytes).toBe(0);

        const repeatedDisableReply = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept off",
            "repeat disable",
        );
        expect(repeatedDisableReply.summary).toContain("## Interceptor Disabled");
        expect(repeatedDisableReply.parsed.enabled).toBe(false);
        expect(repeatedDisableReply.parsed.captures).toBe(0);
        expect(repeatedDisableReply.parsed.totalBytes).toBe(0);

        const usageWhileDisabled = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept off please",
            "invalid subcommand while disabled",
        );
        expect(usageWhileDisabled.summary).toContain("## Interceptor Usage");
        expect(usageWhileDisabled.parsed.enabled).toBe(false);
        expect(usageWhileDisabled.parsed.dumpRoot).toBe(statusReply.parsed.dumpRoot);

        expect(harness.modelRequestCount()).toBe(0);
    }, 45_000);

    test("the harness surfaces a clear failure when the plugin never registers /intercept", async () => {
        harness = await OpencodeServeHarness.start({ pluginSpec: null });
        const sessionId = await harness.createSession();

        await harness.sendSlashCommand(sessionId, "/intercept");

        let failure: Error | null = null;
        try {
            await harness.waitForInterceptSummary(sessionId, {
                timeoutMs: 1_500,
                label: "missing plugin",
            });
        } catch (error) {
            failure = error as Error;
        }

        expect(failure).toBeInstanceOf(Error);
        expect(failure?.message).toContain("Did not observe an ignored /intercept reply");
        expect(failure?.message).toContain("modelRequests=");
        expect(failure?.message).toContain("--- stdout ---");
        expect(failure?.message).toContain("--- stderr ---");
    }, 30_000);

    test("startup failures include captured serve diagnostics", async () => {
        let failure: Error | null = null;
        try {
            harness = await OpencodeServeHarness.start({
                rawConfigText: "{ this-is-not-valid-json",
                startupTimeoutMs: 3_000,
            });
        } catch (error) {
            failure = error as Error;
        }

        expect(failure).toBeInstanceOf(Error);
        expect(failure?.message).toContain("opencode serve exited before becoming ready");
        expect(failure?.message).toContain("--- stdout ---");
        expect(failure?.message).toContain("--- stderr ---");
    }, 30_000);

    test("a fresh restart still supports all command forms and resets state truthfully", async () => {
        harness = await OpencodeServeHarness.start();
        let sessionId = await harness.createSession();

        const firstEnable = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept on",
            "first boot enable",
        );
        expect(firstEnable.parsed.enabled).toBe(true);
        expect(harness.modelRequestCount()).toBe(0);

        await harness.dispose();
        harness = await OpencodeServeHarness.start();
        sessionId = await harness.createSession();

        const restartedStatus = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept",
            "status after restart",
        );
        expect(restartedStatus.summary).toContain("## Interceptor Status");
        expect(restartedStatus.parsed.enabled).toBe(false);

        const restartedEnable = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept on",
            "enable after restart",
        );
        expect(restartedEnable.summary).toContain("## Interceptor Enabled");
        expect(restartedEnable.parsed.enabled).toBe(true);

        const restartedDisable = await runInterceptCommand(
            harness,
            sessionId,
            "/intercept off",
            "disable after restart",
        );
        expect(restartedDisable.summary).toContain("## Interceptor Disabled");
        expect(restartedDisable.parsed.enabled).toBe(false);
        expect(harness.modelRequestCount()).toBe(0);
    }, 45_000);
});
