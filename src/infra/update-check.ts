import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { detectPackageManager as detectPackageManagerImpl } from "./detect-package-manager.js";
import { channelToNpmTag, isStableTag, type UpdateChannel } from "./update-channels.js";

export type PackageManager = "pnpm" | "bun" | "npm" | "unknown";

export type GitUpdateStatus = {
  root: string;
  sha: string | null;
  tag: string | null;
  branch: string | null;
  upstream: string | null;
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  fetchOk: boolean | null;
  error?: string;
};

export type DepsStatus = {
  manager: PackageManager;
  status: "ok" | "missing" | "stale" | "unknown";
  lockfilePath: string | null;
  markerPath: string | null;
  reason?: string;
};

export type RegistryStatus = {
  latestVersion: string | null;
  error?: string;
};

export type NpmTagStatus = {
  tag: string;
  version: string | null;
  error?: string;
};

export type UpdateCheckResult = {
  root: string | null;
  installKind: "git" | "package" | "unknown";
  packageManager: PackageManager;
  git?: GitUpdateStatus;
  deps?: DepsStatus;
  registry?: RegistryStatus;
};

export function formatGitInstallLabel(update: UpdateCheckResult): string | null {
  if (update.installKind !== "git") {
    return null;
  }
  const shortSha = update.git?.sha ? update.git.sha.slice(0, 8) : null;
  const branch = update.git?.branch && update.git.branch !== "HEAD" ? update.git.branch : null;
  const tag = update.git?.tag ?? null;
  const parts = [
    branch ?? (tag ? "detached" : "git"),
    tag ? `tag ${tag}` : null,
    shortSha ? `@ ${shortSha}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(root: string): Promise<PackageManager> {
  return (await detectPackageManagerImpl(root)) ?? "unknown";
}

async function detectGitRoot(root: string): Promise<string | null> {
  const res = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "--show-toplevel"], {
    timeoutMs: 4000,
  }).catch(() => null);
  if (!res || res.code !== 0) {
    return null;
  }
  const top = res.stdout.trim();
  return top ? path.resolve(top) : null;
}

export async function checkGitUpdateStatus(params: {
  root: string;
  timeoutMs?: number;
  fetch?: boolean;
}): Promise<GitUpdateStatus> {
  const timeoutMs = params.timeoutMs ?? 6000;
  const root = path.resolve(params.root);

  const base: GitUpdateStatus = {
    root,
    sha: null,
    tag: null,
    branch: null,
    upstream: null,
    dirty: null,
    ahead: null,
    behind: null,
    fetchOk: null,
  };

  const branchRes = await runCommandWithTimeout(
    ["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"],
    { timeoutMs },
  ).catch(() => null);
  if (!branchRes || branchRes.code !== 0) {
    return { ...base, error: branchRes?.stderr?.trim() || "git unavailable" };
  }
  const branch = branchRes.stdout.trim() || null;

  const shaRes = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "HEAD"], {
    timeoutMs,
  }).catch(() => null);
  const sha = shaRes && shaRes.code === 0 ? shaRes.stdout.trim() : null;

  const tagRes = await runCommandWithTimeout(
    ["git", "-C", root, "describe", "--tags", "--exact-match"],
    { timeoutMs },
  ).catch(() => null);
  const tag = tagRes && tagRes.code === 0 ? tagRes.stdout.trim() : null;

  const upstreamRes = await runCommandWithTimeout(
    ["git", "-C", root, "rev-parse", "--abbrev-ref", "@{upstream}"],
    { timeoutMs },
  ).catch(() => null);
  const upstream = upstreamRes && upstreamRes.code === 0 ? upstreamRes.stdout.trim() : null;

  const dirtyRes = await runCommandWithTimeout(
    ["git", "-C", root, "status", "--porcelain", "--", ":!dist/control-ui/"],
    { timeoutMs },
  ).catch(() => null);
  const dirty = dirtyRes && dirtyRes.code === 0 ? dirtyRes.stdout.trim().length > 0 : null;

  const fetchOk = params.fetch
    ? await runCommandWithTimeout(["git", "-C", root, "fetch", "--quiet", "--prune"], { timeoutMs })
        .then((r) => r.code === 0)
        .catch(() => false)
    : null;

  const counts =
    upstream && upstream.length > 0
      ? await runCommandWithTimeout(
          ["git", "-C", root, "rev-list", "--left-right", "--count", `HEAD...${upstream}`],
          { timeoutMs },
        ).catch(() => null)
      : null;

  const parseCounts = (raw: string): { ahead: number; behind: number } | null => {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 2) {
      return null;
    }
    const ahead = Number.parseInt(parts[0] ?? "", 10);
    const behind = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
      return null;
    }
    return { ahead, behind };
  };
  const parsed = counts && counts.code === 0 ? parseCounts(counts.stdout) : null;

  return {
    root,
    sha,
    tag,
    branch,
    upstream,
    dirty,
    ahead: parsed?.ahead ?? null,
    behind: parsed?.behind ?? null,
    fetchOk,
  };
}

async function statMtimeMs(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

function resolveDepsMarker(params: { root: string; manager: PackageManager }): {
  lockfilePath: string | null;
  markerPath: string | null;
} {
  const root = params.root;
  if (params.manager === "pnpm") {
    return {
      lockfilePath: path.join(root, "pnpm-lock.yaml"),
      markerPath: path.join(root, "node_modules", ".modules.yaml"),
    };
  }
  if (params.manager === "bun") {
    return {
      lockfilePath: path.join(root, "bun.lockb"),
      markerPath: path.join(root, "node_modules"),
    };
  }
  if (params.manager === "npm") {
    return {
      lockfilePath: path.join(root, "package-lock.json"),
      markerPath: path.join(root, "node_modules"),
    };
  }
  return { lockfilePath: null, markerPath: null };
}

export async function checkDepsStatus(params: {
  root: string;
  manager: PackageManager;
}): Promise<DepsStatus> {
  const root = path.resolve(params.root);
  const { lockfilePath, markerPath } = resolveDepsMarker({
    root,
    manager: params.manager,
  });

  if (!lockfilePath || !markerPath) {
    return {
      manager: params.manager,
      status: "unknown",
      lockfilePath,
      markerPath,
      reason: "unknown package manager",
    };
  }

  const lockExists = await exists(lockfilePath);
  const markerExists = await exists(markerPath);
  if (!lockExists) {
    return {
      manager: params.manager,
      status: "unknown",
      lockfilePath,
      markerPath,
      reason: "lockfile missing",
    };
  }
  if (!markerExists) {
    return {
      manager: params.manager,
      status: "missing",
      lockfilePath,
      markerPath,
      reason: "node_modules marker missing",
    };
  }

  const lockMtime = await statMtimeMs(lockfilePath);
  const markerMtime = await statMtimeMs(markerPath);
  if (!lockMtime || !markerMtime) {
    return {
      manager: params.manager,
      status: "unknown",
      lockfilePath,
      markerPath,
    };
  }
  if (lockMtime > markerMtime + 1000) {
    return {
      manager: params.manager,
      status: "stale",
      lockfilePath,
      markerPath,
      reason: "lockfile newer than install marker",
    };
  }
  return {
    manager: params.manager,
    status: "ok",
    lockfilePath,
    markerPath,
  };
}

export async function fetchNpmLatestVersion(params?: {
  timeoutMs?: number;
}): Promise<RegistryStatus> {
  const res = await fetchNpmTagVersion({ tag: "latest", timeoutMs: params?.timeoutMs });
  return {
    latestVersion: res.version,
    error: res.error,
  };
}

export async function fetchNpmTagVersion(params: {
  tag: string;
  timeoutMs?: number;
}): Promise<NpmTagStatus> {
  const timeoutMs = params?.timeoutMs ?? 3500;
  const tag = params.tag;
  try {
    const res = await fetchWithTimeout(
      `https://registry.npmjs.org/openclaw/${encodeURIComponent(tag)}`,
      {},
      Math.max(250, timeoutMs),
    );
    if (!res.ok) {
      return { tag, version: null, error: `HTTP ${res.status}` };
    }
    const json = (await res.json()) as { version?: unknown };
    const version = typeof json?.version === "string" ? json.version : null;
    return { tag, version };
  } catch (err) {
    return { tag, version: null, error: String(err) };
  }
}

/** HippoClaw fork: compare updates against GitHub tags, not npm `openclaw`. */
const HIPPOCLAW_GITHUB_OWNER = "agenthippoai";
const HIPPOCLAW_GITHUB_REPO = "hippoclaw";

const GITHUB_TAGS_PATH = (owner: string, repo: string, page: number) =>
  `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags?per_page=100&page=${page}`;

export function parseGitHubOwnerRepoFromPackageRepository(repository: unknown): {
  owner: string;
  repo: string;
} | null {
  let url: string | null = null;
  if (typeof repository === "string") {
    url = repository;
  } else if (repository && typeof repository === "object" && "url" in repository) {
    const u = (repository as { url?: unknown }).url;
    url = typeof u === "string" ? u : null;
  }
  if (!url?.trim()) {
    return null;
  }
  const normalized = url.trim().replace(/^git\+/i, "");
  const match = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(normalized);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const repoName = match[2].replace(/\.git$/i, "");
  return { owner: match[1], repo: repoName };
}

export function isAgenthippoHippoclawRepo(repo: { owner: string; repo: string } | null): boolean {
  if (!repo) {
    return false;
  }
  return (
    repo.owner.toLowerCase() === HIPPOCLAW_GITHUB_OWNER &&
    repo.repo.toLowerCase().replace(/\.git$/i, "") === HIPPOCLAW_GITHUB_REPO
  );
}

export async function readPackageGitHubRepoFromRoot(root: string): Promise<{
  owner: string;
  repo: string;
} | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { repository?: unknown };
    return parseGitHubOwnerRepoFromPackageRepository(parsed.repository);
  } catch {
    return null;
  }
}

function normalizeGitTagToSemver(tagName: string): string {
  const t = tagName.trim();
  return t.startsWith("v") || t.startsWith("V") ? t.slice(1) : t;
}

/** Latest semver among repo tags for the requested release channel. */
export async function fetchLatestGitHubTagChannelVersion(params: {
  owner: string;
  repo: string;
  channel: UpdateChannel;
  timeoutMs?: number;
}): Promise<{ tag: string; version: string } | null> {
  const timeoutMs = params.timeoutMs ?? 3500;
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  let bestAny: { tag: string; version: string } | null = null;
  let bestStable: { tag: string; version: string } | null = null;

  for (let page = 1; page <= 10; page += 1) {
    try {
      const res = await fetchWithTimeout(
        GITHUB_TAGS_PATH(params.owner, params.repo, page),
        { headers },
        Math.max(250, timeoutMs),
      );
      if (!res.ok) {
        return page === 1 ? null : params.channel === "stable" ? bestStable : bestAny;
      }
      const json = (await res.json()) as unknown;
      if (!Array.isArray(json) || json.length === 0) {
        break;
      }
      for (const entry of json) {
        if (!entry || typeof entry !== "object" || !("name" in entry)) {
          continue;
        }
        const name = (entry as { name?: unknown }).name;
        if (typeof name !== "string" || !name.trim()) {
          continue;
        }
        const version = normalizeGitTagToSemver(name);
        if (compareSemverStrings(version, version) == null) {
          continue;
        }
        const candidate = { tag: name.trim(), version };
        if (!bestAny || (compareSemverStrings(version, bestAny.version) ?? 0) > 0) {
          bestAny = candidate;
        }
        if (
          isStableTag(name) &&
          (!bestStable || (compareSemverStrings(version, bestStable.version) ?? 0) > 0)
        ) {
          bestStable = candidate;
        }
      }
      if (json.length < 100) {
        break;
      }
    } catch {
      return params.channel === "stable" ? bestStable : bestAny;
    }
  }

  return params.channel === "stable" ? bestStable : bestAny;
}

export type PackageChannelTarget = {
  source: "npm" | "github";
  tag: string;
  installSpec: string;
  version: string | null;
};

export async function resolvePackageChannelTarget(params: {
  root: string;
  channel: UpdateChannel;
  timeoutMs?: number;
}): Promise<PackageChannelTarget> {
  if (params.channel !== "dev") {
    const ghRepo = await readPackageGitHubRepoFromRoot(params.root);
    if (ghRepo && isAgenthippoHippoclawRepo(ghRepo)) {
      const resolved = await fetchLatestGitHubTagChannelVersion({
        owner: ghRepo.owner,
        repo: ghRepo.repo,
        channel: params.channel,
        timeoutMs: params.timeoutMs,
      });
      return {
        source: "github",
        tag: resolved?.tag ?? "github",
        installSpec: resolved?.version ?? "latest",
        version: resolved?.version ?? null,
      };
    }
  }

  const resolved = await resolveNpmChannelTag({
    channel: params.channel,
    timeoutMs: params.timeoutMs,
  });
  return {
    source: "npm",
    tag: resolved.tag,
    installSpec: resolved.tag,
    version: resolved.version,
  };
}

export async function resolveNpmChannelTag(params: {
  channel: UpdateChannel;
  timeoutMs?: number;
}): Promise<{ tag: string; version: string | null }> {
  const channelTag = channelToNpmTag(params.channel);
  const channelStatus = await fetchNpmTagVersion({ tag: channelTag, timeoutMs: params.timeoutMs });
  if (params.channel !== "beta") {
    return { tag: channelTag, version: channelStatus.version };
  }

  const latestStatus = await fetchNpmTagVersion({ tag: "latest", timeoutMs: params.timeoutMs });
  if (!latestStatus.version) {
    return { tag: channelTag, version: channelStatus.version };
  }
  if (!channelStatus.version) {
    return { tag: "latest", version: latestStatus.version };
  }
  const cmp = compareSemverStrings(channelStatus.version, latestStatus.version);
  if (cmp != null && cmp < 0) {
    return { tag: "latest", version: latestStatus.version };
  }
  return { tag: channelTag, version: channelStatus.version };
}

export function compareSemverStrings(a: string | null, b: string | null): number | null {
  const pa = parseComparableSemver(a);
  const pb = parseComparableSemver(b);
  if (!pa || !pb) {
    return null;
  }
  if (pa.major !== pb.major) {
    return pa.major < pb.major ? -1 : 1;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor < pb.minor ? -1 : 1;
  }
  if (pa.patch !== pb.patch) {
    return pa.patch < pb.patch ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

type ComparableSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
};

function parseComparableSemver(version: string | null): ComparableSemver | null {
  if (!version) {
    return null;
  }
  const normalized = normalizeLegacyDotBetaVersion(version.trim());
  const match = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    normalized,
  );
  if (!match) {
    return null;
  }
  const [, major, minor, patch, prereleaseRaw] = match;
  if (!major || !minor || !patch) {
    return null;
  }
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prerelease: prereleaseRaw ? prereleaseRaw.split(".").filter(Boolean) : null,
  };
}

function normalizeLegacyDotBetaVersion(version: string): string {
  const trimmed = version.trim();
  const dotBetaMatch = /^([vV]?[0-9]+\.[0-9]+\.[0-9]+)\.beta(?:\.([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!dotBetaMatch) {
    return trimmed;
  }
  const base = dotBetaMatch[1];
  const suffix = dotBetaMatch[2];
  return suffix ? `${base}-beta.${suffix}` : `${base}-beta`;
}

function comparePrerelease(a: string[] | null, b: string[] | null): number {
  if (!a?.length && !b?.length) {
    return 0;
  }
  if (!a?.length) {
    return 1;
  }
  if (!b?.length) {
    return -1;
  }

  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const ai = a[i];
    const bi = b[i];
    if (ai == null && bi == null) {
      return 0;
    }
    if (ai == null) {
      return -1;
    }
    if (bi == null) {
      return 1;
    }
    if (ai === bi) {
      continue;
    }

    const aiNumeric = /^[0-9]+$/.test(ai);
    const biNumeric = /^[0-9]+$/.test(bi);
    if (aiNumeric && biNumeric) {
      const aiNum = Number.parseInt(ai, 10);
      const biNum = Number.parseInt(bi, 10);
      return aiNum < biNum ? -1 : 1;
    }
    if (aiNumeric && !biNumeric) {
      return -1;
    }
    if (!aiNumeric && biNumeric) {
      return 1;
    }
    return ai < bi ? -1 : 1;
  }

  return 0;
}

export async function checkUpdateStatus(params: {
  root: string | null;
  timeoutMs?: number;
  fetchGit?: boolean;
  includeRegistry?: boolean;
}): Promise<UpdateCheckResult> {
  const timeoutMs = params.timeoutMs ?? 6000;
  const root = params.root ? path.resolve(params.root) : null;
  if (!root) {
    return {
      root: null,
      installKind: "unknown",
      packageManager: "unknown",
      registry: params.includeRegistry ? await fetchNpmLatestVersion({ timeoutMs }) : undefined,
    };
  }

  const pm = await detectPackageManager(root);
  const gitRoot = await detectGitRoot(root);
  const isGit = gitRoot && path.resolve(gitRoot) === root;

  const installKind: UpdateCheckResult["installKind"] = isGit ? "git" : "package";
  const git = isGit
    ? await checkGitUpdateStatus({
        root,
        timeoutMs,
        fetch: Boolean(params.fetchGit),
      })
    : undefined;
  const deps = await checkDepsStatus({ root, manager: pm });
  const registry = params.includeRegistry ? await fetchNpmLatestVersion({ timeoutMs }) : undefined;

  return {
    root,
    installKind,
    packageManager: pm,
    git,
    deps,
    registry,
  };
}
