import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import type { UpdateCheckResult } from "./update-check.js";

vi.mock("./openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(),
}));

vi.mock("./update-check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./update-check.js")>();
  return {
    ...actual,
    checkUpdateStatus: vi.fn(),
    resolvePackageChannelTarget: vi.fn(),
  };
});

vi.mock("../version.js", () => ({
  VERSION: "1.0.0",
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

describe("update-startup", () => {
  let suiteRoot = "";
  let suiteCase = 0;
  let tempDir: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  let resolveOpenClawPackageRoot: (typeof import("./openclaw-root.js"))["resolveOpenClawPackageRoot"];
  let checkUpdateStatus: (typeof import("./update-check.js"))["checkUpdateStatus"];
  let resolvePackageChannelTarget: (typeof import("./update-check.js"))["resolvePackageChannelTarget"];
  let runCommandWithTimeout: (typeof import("../process/exec.js"))["runCommandWithTimeout"];
  let runGatewayUpdateCheck: (typeof import("./update-startup.js"))["runGatewayUpdateCheck"];
  let scheduleGatewayUpdateCheck: (typeof import("./update-startup.js"))["scheduleGatewayUpdateCheck"];
  let getUpdateAvailable: (typeof import("./update-startup.js"))["getUpdateAvailable"];
  let resetUpdateAvailableStateForTest: (typeof import("./update-startup.js"))["resetUpdateAvailableStateForTest"];
  let loaded = false;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-check-suite-"));
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T10:00:00Z"));
    tempDir = path.join(suiteRoot, `case-${++suiteCase}`);
    await fs.mkdir(tempDir);
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "NODE_ENV", "VITEST"]);
    process.env.OPENCLAW_STATE_DIR = tempDir;

    process.env.NODE_ENV = "test";

    // Ensure update checks don't short-circuit in test mode.
    delete process.env.VITEST;

    // Perf: load mocked modules once (after timers/env are set up).
    if (!loaded) {
      ({ resolveOpenClawPackageRoot } = await import("./openclaw-root.js"));
      ({ checkUpdateStatus, resolvePackageChannelTarget } = await import("./update-check.js"));
      ({ runCommandWithTimeout } = await import("../process/exec.js"));
      ({
        runGatewayUpdateCheck,
        scheduleGatewayUpdateCheck,
        getUpdateAvailable,
        resetUpdateAvailableStateForTest,
      } = await import("./update-startup.js"));
      loaded = true;
    }
    vi.mocked(resolveOpenClawPackageRoot).mockClear();
    vi.mocked(checkUpdateStatus).mockClear();
    vi.mocked(resolvePackageChannelTarget).mockClear();
    vi.mocked(runCommandWithTimeout).mockClear();
    resetUpdateAvailableStateForTest();
  });

  afterEach(async () => {
    vi.useRealTimers();
    envSnapshot.restore();
    resetUpdateAvailableStateForTest();
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
    suiteRoot = "";
    suiteCase = 0;
  });

  function mockPackageUpdateStatus(tag = "latest", version = "2.0.0") {
    mockPackageInstallStatus();
    mockNpmChannelTag(tag, version);
  }

  function mockPackageInstallStatus() {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "package",
      packageManager: "npm",
    } satisfies UpdateCheckResult);
  }

  function mockNpmChannelTag(tag: string, version: string) {
    vi.mocked(resolvePackageChannelTarget).mockResolvedValue({
      source: "npm",
      tag,
      installSpec: tag,
      version,
    });
  }

  async function runUpdateCheckAndReadState(channel: "stable" | "beta") {
    mockPackageUpdateStatus("latest", "2.0.0");

    const log = { info: vi.fn() };
    await runGatewayUpdateCheck({
      cfg: { update: { channel } },
      log,
      isNixMode: false,
      allowInTests: true,
    });

    const statePath = path.join(tempDir, "update-check.json");
    const parsed = JSON.parse(await fs.readFile(statePath, "utf-8")) as {
      lastNotifiedVersion?: string;
      lastNotifiedTag?: string;
      lastAvailableVersion?: string;
      lastAvailableTag?: string;
    };
    return { log, parsed };
  }

  function createAutoUpdateSuccessMock() {
    return vi.fn().mockResolvedValue({
      ok: true,
      code: 0,
    });
  }

  function createBetaAutoUpdateConfig(params?: { checkOnStart?: boolean }) {
    return {
      update: {
        ...(params?.checkOnStart === false ? { checkOnStart: false } : {}),
        channel: "beta" as const,
        auto: {
          enabled: true,
          betaCheckIntervalHours: 1,
        },
      },
    };
  }

  async function runAutoUpdateCheckWithDefaults(params: {
    cfg: { update?: Record<string, unknown> };
    runAutoUpdate?: ReturnType<typeof createAutoUpdateSuccessMock>;
  }) {
    await runGatewayUpdateCheck({
      cfg: params.cfg,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      ...(params.runAutoUpdate ? { runAutoUpdate: params.runAutoUpdate } : {}),
    });
  }

  async function runStableUpdateCheck(params: {
    onUpdateAvailableChange?: Parameters<
      typeof runGatewayUpdateCheck
    >[0]["onUpdateAvailableChange"];
  }) {
    await runGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      ...(params.onUpdateAvailableChange
        ? { onUpdateAvailableChange: params.onUpdateAvailableChange }
        : {}),
    });
  }

  it.each([
    {
      name: "stable channel",
      channel: "stable" as const,
    },
    {
      name: "beta channel with older beta tag",
      channel: "beta" as const,
    },
  ])("logs latest update hint for $name", async ({ channel }) => {
    const { log, parsed } = await runUpdateCheckAndReadState(channel);

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("update available (latest): v2.0.0"),
    );
    expect(parsed.lastNotifiedVersion).toBe("2.0.0");
    expect(parsed.lastAvailableVersion).toBe("2.0.0");
    expect(parsed.lastNotifiedTag).toBe("latest");
  });

  it("hydrates cached update from persisted state during throttle window", async () => {
    const statePath = path.join(tempDir, "update-check.json");
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          lastCheckedAt: new Date(Date.now()).toISOString(),
          lastAvailableVersion: "2.0.0",
          lastAvailableTag: "latest",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const onUpdateAvailableChange = vi.fn();
    await runGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      onUpdateAvailableChange,
    });

    expect(vi.mocked(checkUpdateStatus)).not.toHaveBeenCalled();
    expect(onUpdateAvailableChange).toHaveBeenCalledWith({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
    expect(getUpdateAvailable()).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
  });

  it("emits update change callback when update state clears", async () => {
    mockPackageInstallStatus();
    vi.mocked(resolvePackageChannelTarget)
      .mockResolvedValueOnce({
        source: "npm",
        tag: "latest",
        installSpec: "latest",
        version: "2.0.0",
      })
      .mockResolvedValueOnce({
        source: "npm",
        tag: "latest",
        installSpec: "latest",
        version: "1.0.0",
      });

    const onUpdateAvailableChange = vi.fn();
    await runStableUpdateCheck({ onUpdateAvailableChange });
    vi.setSystemTime(new Date("2026-01-18T11:00:00Z"));
    await runStableUpdateCheck({ onUpdateAvailableChange });

    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(1, {
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(2, null);
    expect(getUpdateAvailable()).toBeNull();
  });

  it("skips update check when disabled in config", async () => {
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      cfg: { update: { checkOnStart: false } },
      log,
      isNixMode: false,
      allowInTests: true,
    });

    expect(log.info).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(tempDir, "update-check.json"))).rejects.toThrow();
  });

  it("defers stable auto-update until rollout window is due", async () => {
    mockPackageUpdateStatus("latest", "2.0.0");

    const runAutoUpdate = vi.fn().mockResolvedValue({
      ok: true,
      code: 0,
    });
    const stableAutoConfig = {
      update: {
        channel: "stable" as const,
        auto: {
          enabled: true,
          stableDelayHours: 6,
          stableJitterHours: 12,
        },
      },
    };

    await runGatewayUpdateCheck({
      cfg: stableAutoConfig,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      runAutoUpdate,
    });
    expect(runAutoUpdate).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-01-18T07:00:00Z"));
    await runGatewayUpdateCheck({
      cfg: stableAutoConfig,
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      runAutoUpdate,
    });

    expect(runAutoUpdate).toHaveBeenCalledTimes(1);
    expect(runAutoUpdate).toHaveBeenCalledWith({
      channel: "stable",
      timeoutMs: 45 * 60 * 1000,
      root: "/opt/openclaw",
    });
  });

  it("runs beta auto-update checks hourly when enabled", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runAutoUpdateCheckWithDefaults({
      cfg: createBetaAutoUpdateConfig(),
      runAutoUpdate,
    });

    expect(runAutoUpdate).toHaveBeenCalledTimes(1);
    expect(runAutoUpdate).toHaveBeenCalledWith({
      channel: "beta",
      timeoutMs: 45 * 60 * 1000,
      root: "/opt/openclaw",
    });
  });

  it("does not auto-update when the available version came from GitHub tags", async () => {
    mockPackageInstallStatus();
    vi.mocked(resolvePackageChannelTarget).mockResolvedValue({
      source: "github",
      tag: "v2.0.0-beta.1",
      installSpec: "2.0.0-beta.1",
      version: "2.0.0-beta.1",
    });
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runAutoUpdateCheckWithDefaults({
      cfg: createBetaAutoUpdateConfig(),
      runAutoUpdate,
    });

    expect(runAutoUpdate).not.toHaveBeenCalled();
  });

  it("runs auto-update when checkOnStart is false but auto-update is enabled", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runAutoUpdateCheckWithDefaults({
      cfg: createBetaAutoUpdateConfig({ checkOnStart: false }),
      runAutoUpdate,
    });

    expect(runAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("uses current runtime + entrypoint for default auto-update command execution", async () => {
    mockPackageInstallStatus();
    mockNpmChannelTag("beta", "2.0.0-beta.1");
    vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "{}",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    const originalArgv = process.argv.slice();
    process.argv = [process.execPath, "/opt/openclaw/dist/entry.js"];
    try {
      await runAutoUpdateCheckWithDefaults({
        cfg: createBetaAutoUpdateConfig(),
      });
    } finally {
      process.argv = originalArgv;
    }

    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        process.execPath,
        "/opt/openclaw/dist/entry.js",
        "update",
        "--yes",
        "--channel",
        "beta",
        "--json",
      ],
      expect.objectContaining({
        timeoutMs: 45 * 60 * 1000,
        env: expect.objectContaining({
          OPENCLAW_AUTO_UPDATE: "1",
        }),
      }),
    );
  });

  it("scheduleGatewayUpdateCheck returns a cleanup function", async () => {
    mockPackageUpdateStatus("latest", "2.0.0");

    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      log: { info: vi.fn() },
      isNixMode: false,
    });
    expect(typeof stop).toBe("function");
    stop();
  });
});
