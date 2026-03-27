import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkDepsStatus,
  checkUpdateStatus,
  compareSemverStrings,
  fetchLatestGitHubTagChannelVersion,
  fetchNpmLatestVersion,
  fetchNpmTagVersion,
  formatGitInstallLabel,
  isAgenthippoHippoclawRepo,
  parseGitHubOwnerRepoFromPackageRepository,
  resolvePackageChannelTarget,
  resolveNpmChannelTag,
} from "./update-check.js";

describe("compareSemverStrings", () => {
  it("handles stable and prerelease precedence for both legacy and beta formats", () => {
    expect(compareSemverStrings("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemverStrings("v1.0.0", "1.0.0")).toBe(0);

    expect(compareSemverStrings("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);

    expect(compareSemverStrings("1.0.0-2", "1.0.0-1")).toBe(1);
    expect(compareSemverStrings("1.0.0-1", "1.0.0-beta.1")).toBe(-1);
    expect(compareSemverStrings("1.0.0.beta.2", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0", "1.0.0.beta.1")).toBe(1);
  });

  it("returns null for invalid inputs", () => {
    expect(compareSemverStrings("1.0", "1.0.0")).toBeNull();
    expect(compareSemverStrings("latest", "1.0.0")).toBeNull();
  });
});

describe("resolveNpmChannelTag", () => {
  let versionByTag: Record<string, string | null>;

  beforeEach(() => {
    versionByTag = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const tag = decodeURIComponent(url.split("/").pop() ?? "");
        const version = versionByTag[tag] ?? null;
        return {
          ok: version != null,
          status: version != null ? 200 : 404,
          json: async () => ({ version }),
        } as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to latest when beta is older", async () => {
    versionByTag.beta = "1.0.0-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1-1" });
  });

  it("keeps beta when beta is not older", async () => {
    versionByTag.beta = "1.0.2-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "beta", version: "1.0.2-beta.1" });
  });

  it("falls back to latest when beta has same base as stable", async () => {
    versionByTag.beta = "1.0.1-beta.2";
    versionByTag.latest = "1.0.1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1" });
  });

  it("keeps non-beta channels unchanged", async () => {
    versionByTag.latest = "1.0.3";

    await expect(resolveNpmChannelTag({ channel: "stable", timeoutMs: 1000 })).resolves.toEqual({
      tag: "latest",
      version: "1.0.3",
    });
  });

  it("exposes tag fetch helpers for success and http failures", async () => {
    versionByTag.latest = "1.0.4";

    await expect(fetchNpmTagVersion({ tag: "latest", timeoutMs: 1000 })).resolves.toEqual({
      tag: "latest",
      version: "1.0.4",
    });
    await expect(fetchNpmLatestVersion({ timeoutMs: 1000 })).resolves.toEqual({
      latestVersion: "1.0.4",
      error: undefined,
    });
    await expect(fetchNpmTagVersion({ tag: "beta", timeoutMs: 1000 })).resolves.toEqual({
      tag: "beta",
      version: null,
      error: "HTTP 404",
    });
  });
});

describe("parseGitHubOwnerRepoFromPackageRepository", () => {
  it("parses git+https and https github urls", () => {
    expect(
      parseGitHubOwnerRepoFromPackageRepository({
        type: "git",
        url: "git+https://github.com/agenthippoai/hippoclaw.git",
      }),
    ).toEqual({ owner: "agenthippoai", repo: "hippoclaw" });
    expect(
      parseGitHubOwnerRepoFromPackageRepository("https://github.com/agenthippoai/hippoclaw"),
    ).toEqual({ owner: "agenthippoai", repo: "hippoclaw" });
  });

  it("returns null for non-github or missing url", () => {
    expect(parseGitHubOwnerRepoFromPackageRepository(undefined)).toBeNull();
    expect(
      parseGitHubOwnerRepoFromPackageRepository({ url: "https://example.com/a/b.git" }),
    ).toBeNull();
  });
});

describe("isAgenthippoHippoclawRepo", () => {
  it("matches the HippoClaw fork", () => {
    expect(isAgenthippoHippoclawRepo({ owner: "agenthippoai", repo: "hippoclaw" })).toBe(true);
    expect(isAgenthippoHippoclawRepo({ owner: "AgentHippoAI", repo: "hippoclaw" })).toBe(true);
    expect(isAgenthippoHippoclawRepo({ owner: "agenthippoai", repo: "hippoclaw.git" })).toBe(true);
    expect(isAgenthippoHippoclawRepo({ owner: "openclaw", repo: "openclaw" })).toBe(false);
    expect(isAgenthippoHippoclawRepo(null)).toBe(false);
  });
});

describe("fetchLatestGitHubTagChannelVersion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selects highest semver among tags", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: true,
          json: async () => [{ name: "1.0.0" }, { name: "v2.0.0" }, { name: "not-a-version" }],
        } as Response;
      }),
    );
    await expect(
      fetchLatestGitHubTagChannelVersion({
        owner: "agenthippoai",
        repo: "hippoclaw",
        channel: "beta",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ tag: "v2.0.0", version: "2.0.0" });
  });

  it("filters prerelease tags out of stable channel resolution", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: true,
          json: async () => [{ name: "v2.1.0-beta.1" }, { name: "v2.0.0" }],
        } as Response;
      }),
    );
    await expect(
      fetchLatestGitHubTagChannelVersion({
        owner: "agenthippoai",
        repo: "hippoclaw",
        channel: "stable",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ tag: "v2.0.0", version: "2.0.0" });
  });

  it("returns null when the first page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403 }) as Response),
    );
    await expect(
      fetchLatestGitHubTagChannelVersion({
        owner: "agenthippoai",
        repo: "hippoclaw",
        channel: "stable",
        timeoutMs: 1000,
      }),
    ).resolves.toBeNull();
  });

  it("returns the best version collected so far when a later page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ name: "v2.0.0" }],
        } as Response)
        .mockResolvedValueOnce({ ok: false, status: 403 } as Response),
    );

    await expect(
      fetchLatestGitHubTagChannelVersion({
        owner: "agenthippoai",
        repo: "hippoclaw",
        channel: "stable",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ tag: "v2.0.0", version: "2.0.0" });
  });
});

describe("resolvePackageChannelTarget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses exact package versions for HippoClaw GitHub tag updates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hippoclaw-package-target-"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        repository: {
          type: "git",
          url: "git+https://github.com/agenthippoai/hippoclaw.git",
        },
      }),
      "utf8",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: true,
          json: async () => [{ name: "v2.0.0" }],
        } as Response;
      }),
    );

    await expect(
      resolvePackageChannelTarget({ root, channel: "stable", timeoutMs: 1000 }),
    ).resolves.toEqual({
      source: "github",
      tag: "v2.0.0",
      installSpec: "2.0.0",
      version: "2.0.0",
    });

    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("formatGitInstallLabel", () => {
  it("formats branch, detached tag, and non-git installs", () => {
    expect(
      formatGitInstallLabel({
        root: "/repo",
        installKind: "git",
        packageManager: "pnpm",
        git: {
          root: "/repo",
          sha: "1234567890abcdef",
          tag: null,
          branch: "main",
          upstream: "origin/main",
          dirty: false,
          ahead: 0,
          behind: 0,
          fetchOk: true,
        },
      }),
    ).toBe("main · @ 12345678");

    expect(
      formatGitInstallLabel({
        root: "/repo",
        installKind: "git",
        packageManager: "pnpm",
        git: {
          root: "/repo",
          sha: "abcdef1234567890",
          tag: "v1.2.3",
          branch: "HEAD",
          upstream: null,
          dirty: false,
          ahead: 0,
          behind: 0,
          fetchOk: null,
        },
      }),
    ).toBe("detached · tag v1.2.3 · @ abcdef12");

    expect(
      formatGitInstallLabel({
        root: null,
        installKind: "package",
        packageManager: "pnpm",
      }),
    ).toBeNull();
  });
});

describe("checkDepsStatus", () => {
  it("reports unknown, missing, stale, and ok states from lockfile markers", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-check-"));

    await expect(checkDepsStatus({ root: base, manager: "unknown" })).resolves.toEqual({
      manager: "unknown",
      status: "unknown",
      lockfilePath: null,
      markerPath: null,
      reason: "unknown package manager",
    });

    await fs.writeFile(path.join(base, "pnpm-lock.yaml"), "lock", "utf8");
    await expect(checkDepsStatus({ root: base, manager: "pnpm" })).resolves.toMatchObject({
      manager: "pnpm",
      status: "missing",
      reason: "node_modules marker missing",
    });

    const markerPath = path.join(base, "node_modules", ".modules.yaml");
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, "marker", "utf8");
    const staleDate = new Date(Date.now() - 10_000);
    const freshDate = new Date();
    await fs.utimes(markerPath, staleDate, staleDate);
    await fs.utimes(path.join(base, "pnpm-lock.yaml"), freshDate, freshDate);

    await expect(checkDepsStatus({ root: base, manager: "pnpm" })).resolves.toMatchObject({
      manager: "pnpm",
      status: "stale",
      reason: "lockfile newer than install marker",
    });

    const newerMarker = new Date(Date.now() + 2_000);
    await fs.utimes(markerPath, newerMarker, newerMarker);
    await expect(checkDepsStatus({ root: base, manager: "pnpm" })).resolves.toMatchObject({
      manager: "pnpm",
      status: "ok",
    });
  });
});

describe("checkUpdateStatus", () => {
  it("returns unknown install status when root is missing", async () => {
    await expect(
      checkUpdateStatus({ root: null, includeRegistry: false, timeoutMs: 1000 }),
    ).resolves.toEqual({
      root: null,
      installKind: "unknown",
      packageManager: "unknown",
      registry: undefined,
    });
  });

  it("detects package installs for non-git roots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-check-"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "npm@10.0.0" }),
      "utf8",
    );
    await fs.writeFile(path.join(root, "package-lock.json"), "lock", "utf8");
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });

    await expect(
      checkUpdateStatus({ root, includeRegistry: false, fetchGit: false, timeoutMs: 1000 }),
    ).resolves.toMatchObject({
      root,
      installKind: "package",
      packageManager: "npm",
      git: undefined,
      registry: undefined,
      deps: {
        manager: "npm",
      },
    });
  });
});
