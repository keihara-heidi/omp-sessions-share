/** Deterministic plugin update checks and background handoff. */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { PluginUpdateStatus } from "../lib/contracts";
import { getInstalledPluginPackagePath } from "../shared/config";

const REPOSITORY = "https://github.com/keihara-heidi/omp-sessions-share.git";
const RAW_PACKAGE = "https://raw.githubusercontent.com/keihara-heidi/omp-sessions-share";
const PACKAGE_NAME = "omp-sessions-share";
const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_PACKAGE_BYTES = 16_384;

export function parseMainCommit(output: string): string | null {
  return output.trim().match(/^([0-9a-f]{40})\s+refs\/heads\/main$/)?.[1] ?? null;
}

function parsePackageVersion(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const pkg = value as Record<string, unknown>;
  return pkg.name === PACKAGE_NAME &&
    typeof pkg.version === "string" &&
    VERSION_RE.test(pkg.version)
    ? pkg.version
    : null;
}

async function readPackageVersion(packagePath: string): Promise<string> {
  const info = await stat(packagePath);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_PACKAGE_BYTES) {
    throw new Error("Installed plugin manifest is invalid");
  }
  const version = parsePackageVersion(
    JSON.parse(await readFile(packagePath, "utf8")),
  );
  if (!version) throw new Error("Installed plugin manifest is invalid");
  return version;
}

export async function resolveLatestMainCommit(): Promise<string> {
  const proc = Bun.spawn(["git", "ls-remote", REPOSITORY, "refs/heads/main"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), 10_000);
  try {
    const [code, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    const commit = code === 0 ? parseMainCommit(stdout) : null;
    if (!commit) throw new Error("Could not resolve latest main commit");
    return commit;
  } finally {
    clearTimeout(timer);
  }
}

export type PluginUpdateServiceOptions = {
  installedPackagePath?: string;
  resolveCommit?: () => Promise<string>;
  fetchPackage?: (commit: string) => Promise<unknown>;
  schedule?: (commit: string) => void;
};

export function createPluginUpdateService(
  options: PluginUpdateServiceOptions = {},
) {
  const installedPackagePath =
    options.installedPackagePath ?? getInstalledPluginPackagePath();
  const fetchPackage =
    options.fetchPackage ??
    (async (commit: string) => {
      const response = await fetch(`${RAW_PACKAGE}/${commit}/package.json`, {
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not fetch latest plugin manifest");
      return response.json();
    });

  const check = async (): Promise<PluginUpdateStatus> => {
    const [currentVersion, commit] = await Promise.all([
      readPackageVersion(installedPackagePath),
      (options.resolveCommit ?? resolveLatestMainCommit)(),
    ]);
    if (!SHA_RE.test(commit)) throw new Error("Latest commit is invalid");
    const latestVersion = parsePackageVersion(await fetchPackage(commit));
    if (!latestVersion) throw new Error("Latest plugin manifest is invalid");
    return {
      currentVersion,
      latestVersion,
      commit,
      updateAvailable: currentVersion !== latestVersion,
    };
  };

  let scheduled = false;
  const schedule =
    options.schedule ??
    ((commit: string) => {
      const setupEntry = path.join(
        path.dirname(installedPackagePath),
        "setup",
        "cli.ts",
      );
      setTimeout(() => {
        const proc = Bun.spawn(
          [process.execPath, setupEntry, "update", "--commit", commit],
          {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            detached: true,
          },
        );
        proc.unref();
      }, 250);
    });

  return {
    check,
    start(commit: string): void {
      if (!SHA_RE.test(commit)) throw new Error("Invalid update commit");
      if (scheduled) throw new Error("Update already started");
      schedule(commit);
      scheduled = true;
    },
  };
}
