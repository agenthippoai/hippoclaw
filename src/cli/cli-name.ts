import path from "node:path";

export const DEFAULT_CLI_NAME = "openclaw";

/** Binaries shipped by this package (`package.json` bin map). */
const KNOWN_CLI_NAMES = new Set<string>([DEFAULT_CLI_NAME, "hippoclaw"]);
const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(openclaw|hippoclaw)\b/;

export function resolveCliName(argv: string[] = process.argv): string {
  const argv1 = argv[1];
  if (!argv1) {
    return DEFAULT_CLI_NAME;
  }
  const base = path.basename(argv1).trim();
  if (KNOWN_CLI_NAMES.has(base)) {
    return base;
  }
  return DEFAULT_CLI_NAME;
}

export function replaceCliName(command: string, cliName = resolveCliName()): string {
  if (!command.trim()) {
    return command;
  }
  if (!CLI_PREFIX_RE.test(command)) {
    return command;
  }
  return command.replace(CLI_PREFIX_RE, (_match, runner: string | undefined, _bin: string) => {
    return `${runner ?? ""}${cliName}`;
  });
}
