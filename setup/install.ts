/**
 * First-run / idempotent local runtime installer for omp-sessions-share.
 * Generates secrets, installs LaunchAgent daemon, Tailscale Serve, launcher.
 * Never accepts secrets via argv; never prints hostToken/cookieSecret.
 */
import { randomBytes } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  type ShareConfig,
  getDashboardDbPath,
  getDashboardLocationsPath,
  getShareConfigPath,
  getInstalledPluginPackagePath,
  loadShareConfig,
  writeShareConfig,
} from "../shared/config";

export type { ShareConfig };

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");
const LOCAL_ORIGIN = "http://127.0.0.1:7466";
const TAILSCALE_HTTPS_PORT = 8443;
const LAUNCH_LABEL = "sh.omp.sessions-share";
const LEGACY_LAUNCH_LABEL = "sh.omp.sessions-share-relay";
const RUNTIME_DIR_NAME = "omp-sessions-share-runtime";
const LEGACY_RUNTIME_DIR_NAME = "omp-sessions-share-relay";
const LAUNCHER_MARKER = "omp-sessions-share-owned-launcher";
const ZSH_BLOCK_BEGIN = "# omp-sessions-share begin";
const ZSH_BLOCK_END = "# omp-sessions-share end";
/** Legacy single-line marker still stripped on upgrade/uninstall. */
const ALIAS_MARKER = "# omp-sessions-share launcher";
const SECRET_BYTES = 32;
const OMP_PKG = "@oh-my-pi/pi-coding-agent";

const COLLAB_TITLE_PATCH_MARKER = "omp-sessions-share:collab-title";

/** Restore OMP auto-titling for prompts received through the collab guest. */
export async function enableCollabGuestTitleGeneration(
  pkgRoot: string,
): Promise<boolean> {
  const hostPath = path.join(pkgRoot, "src", "collab", "host.ts");
  try {
    const source = await readFile(hostPath, "utf8");
    if (
      source.includes(COLLAB_TITLE_PATCH_MARKER) ||
      source.includes("this.#ctx.session.maybeStartTitleGeneration(text);")
    ) {
      return true;
    }
    const anchor = "\t\tconst details: CollabPromptDetails = { from: name };";
    if (source.split(anchor).length !== 2) return false;
    const patched = source.replace(
      anchor,
      `${anchor}\n\t\tthis.#ctx.session.maybeStartTitleGeneration(text); // ${COLLAB_TITLE_PATCH_MARKER}`,
    );
    await writeFile(hostPath, patched);
    return true;
  } catch {
    return false;
  }
}

function agentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(homedir(), ".omp", "agent");
}

function runtimeDir(): string {
  return path.join(agentDir(), RUNTIME_DIR_NAME);
}

function assertDarwin(): void {
  if (process.platform !== "darwin") {
    throw new Error("omp-sessions-share v1 supports macOS only (os: darwin)");
  }
  if (typeof process.getuid !== "function") {
    throw new Error("macOS user context required (missing getuid)");
  }
}

function requireHome(): string {
  const home = process.env.HOME?.trim() || homedir();
  if (!home) throw new Error("Cannot resolve home directory");
  return home;
}

let cachedBunBin: string | undefined;
function resolveBunBin(): string {
  if (cachedBunBin) return cachedBunBin;
  const home = requireHome();
  const candidates = [
    process.env.BUN_INSTALL
      ? path.join(process.env.BUN_INSTALL, "bin", "bun")
      : "",
    path.join(home, ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
    "bun",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const probe = Bun.spawnSync([candidate, "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (probe.exitCode === 0) return (cachedBunBin = candidate);
  }
  throw new Error("Bun 1.3.14 or newer is required and was not found");
}

function secretToken(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

function run(
  argv: string[],
  opts: { allowFailure?: boolean } = {},
): { ok: boolean; stdout: string; stderr: string; code: number } {
  const result = Bun.spawnSync(argv, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  const code = result.exitCode ?? 1;
  if (code !== 0 && !opts.allowFailure) {
    throw new Error(
      `${argv.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`,
    );
  }
  return { ok: code === 0, stdout, stderr, code };
}

type CommandResult = ReturnType<typeof run>;
type CommandRunner = (
  argv: string[],
  opts?: { allowFailure?: boolean },
) => CommandResult;

export type LocalShareServerControlOptions = {
  home?: string;
  uid?: number;
  agentDir?: string;
  runCommand?: CommandRunner;
  tailscaleBin?: string;
};

function resolveTailscaleBin(): string {
  const candidates = [
    "tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ];
  for (const bin of candidates) {
    const probe = Bun.spawnSync([bin, "version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (probe.exitCode === 0) return bin;
  }
  throw new Error(
    "Tailscale CLI not found or not runnable. Install Tailscale, sign in, then re-run setup.",
  );
}

type TailscaleStatus = {
  BackendState?: string;
  Self?: { DNSName?: string };
};

async function discoverPublicOrigin(tailscaleBin: string): Promise<string> {
  const { stdout } = run([tailscaleBin, "status", "--json"]);
  let status: TailscaleStatus;
  try {
    status = JSON.parse(stdout) as TailscaleStatus;
  } catch {
    throw new Error(
      "tailscale status --json returned invalid JSON; is Tailscale running?",
    );
  }
  if (status.BackendState !== "Running") {
    throw new Error(
      `Tailscale is not running (BackendState=${status.BackendState ?? "unknown"}). Open Tailscale and sign in.`,
    );
  }
  const raw = status.Self?.DNSName?.trim();
  if (!raw) {
    throw new Error(
      "Tailscale Self.DNSName missing; wait until this node is online on your tailnet.",
    );
  }
  const host = raw.replace(/\.$/, "").toLowerCase();
  if (!host.endsWith(".ts.net") || host.includes("/") || host.includes(":")) {
    throw new Error(`Unexpected Tailscale DNS name: ${raw}`);
  }
  return `https://${host}:${TAILSCALE_HTTPS_PORT}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the pre-v0.3 relay service before it can reclaim port 7466.
 *
 * Merely booting the old job out during setup is insufficient: launchd loads
 * its retained plist again at the next login, causing the current daemon to
 * crash-loop on EADDRINUSE.
 */
export async function cleanupLegacyLocalShareRelay(
  options: LocalShareServerControlOptions = {},
): Promise<boolean> {
  assertDarwin();
  const home = options.home ?? requireHome();
  const uid = options.uid ?? process.getuid!();
  const legacyPlist = path.join(
    home,
    "Library",
    "LaunchAgents",
    `${LEGACY_LAUNCH_LABEL}.plist`,
  );
  const legacyRuntime = path.join(
    options.agentDir ?? agentDir(),
    LEGACY_RUNTIME_DIR_NAME,
  );
  if (!(await pathExists(legacyPlist)) && !(await pathExists(legacyRuntime))) {
    return false;
  }

  const runCommand = options.runCommand ?? run;
  runCommand(["launchctl", "bootout", `gui/${uid}/${LEGACY_LAUNCH_LABEL}`], {
    allowFailure: true,
  });
  await rm(legacyPlist, { force: true });
  await rm(legacyRuntime, { recursive: true, force: true });
  return true;
}

async function resolveStaticBundleDir(): Promise<string> {
  const candidates = [
    path.join(PACKAGE_ROOT, "out"),
    path.join(PACKAGE_ROOT, "web"),
  ];
  for (const dir of candidates) {
    if (
      (await pathExists(path.join(dir, "index.html"))) &&
      (await pathExists(path.join(dir, "login", "index.html")))
    ) {
      return dir;
    }
  }
  const build = Bun.spawnSync([resolveBunBin(), "run", "build"], {
    cwd: PACKAGE_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode === 0) {
    for (const dir of candidates) {
      if (
        (await pathExists(path.join(dir, "index.html"))) &&
        (await pathExists(path.join(dir, "login", "index.html")))
      ) {
        return dir;
      }
    }
  }
  throw new Error(
    "Static dashboard bundle missing or incomplete. Build before setup.",
  );
}

/**
 * Copy package runtime into ~/.omp/agent/omp-sessions-share-runtime.
 * Layout preserves relative imports: daemon/, shared/, lib/*, daemon/web/.
 */
async function copyRuntimeAssets(staticDir: string): Promise<string> {
  const dest = runtimeDir();
  const staging = `${dest}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  for (const name of ["daemon", "shared"] as const) {
    const src = path.join(PACKAGE_ROOT, name);
    if (!(await pathExists(src))) {
      throw new Error(`Package incomplete: missing ${name}/`);
    }
    await cp(src, path.join(staging, name), { recursive: true });
  }

  await mkdir(path.join(staging, "lib"), { recursive: true });
  for (const file of ["contracts.ts", "auth.ts"] as const) {
    const src = path.join(PACKAGE_ROOT, "lib", file);
    if (await pathExists(src)) {
      await cp(src, path.join(staging, "lib", file));
    }
  }

  const packageJson = path.join(PACKAGE_ROOT, "package.json");
  if (!(await pathExists(packageJson))) {
    throw new Error("Package incomplete: missing package.json");
  }
  await cp(packageJson, path.join(staging, "package.json"));

  // daemon/static.ts defaults to sibling web/ next to daemon/server.ts
  await cp(staticDir, path.join(staging, "daemon", "web"), { recursive: true });

  const entry = path.join(staging, "daemon", "server.ts");
  if (!(await pathExists(entry))) {
    throw new Error("Package incomplete: missing daemon/server.ts");
  }

  await rm(dest, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(staging, dest);
  return dest;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&" + "amp;")
    .replaceAll("<", "&" + "lt;")
    .replaceAll(">", "&" + "gt;")
    .replaceAll('"', "&" + "quot;")
    .replaceAll("'", "&" + "apos;");
}

async function installLaunchAgent(runtimeRoot: string): Promise<void> {
  const home = requireHome();
  const uid = process.getuid!();
  const logsDir = path.join(home, ".omp", "logs");
  const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${LAUNCH_LABEL}.plist`);
  const logPath = path.join(logsDir, "omp-sessions-share.log");
  const entry = path.join(runtimeRoot, "daemon", "server.ts");
  const bunBin = resolveBunBin();
  const configPath = getShareConfigPath();
  const webRoot = path.join(runtimeRoot, "daemon", "web");

  await mkdir(logsDir, { recursive: true });
  await mkdir(launchAgentsDir, { recursive: true });
  await cleanupLegacyLocalShareRelay();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xmlEscape(bunBin)}</string>
    <string>${xmlEscape(entry)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(runtimeRoot)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>OMP_SESSIONS_SHARE_CONFIG</key><string>${xmlEscape(configPath)}</string>
    <key>OMP_SESSIONS_SHARE_WEB</key><string>${xmlEscape(webRoot)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict></plist>
`;
  await writeFile(plistPath, plist, { mode: 0o600 });
  await chmod(plistPath, 0o600);

  const domain = `gui/${uid}`;
  run(["launchctl", "bootout", `${domain}/${LAUNCH_LABEL}`], {
    allowFailure: true,
  });
  let loaded = run(["launchctl", "bootstrap", domain, plistPath], {
    allowFailure: true,
  });
  for (let attempt = 0; !loaded.ok && attempt < 10; attempt++) {
    await Bun.sleep(500);
    loaded = run(["launchctl", "bootstrap", domain, plistPath], {
      allowFailure: true,
    });
  }
  if (!loaded.ok) {
    throw new Error(
      `launchctl bootstrap failed: ${loaded.stderr.trim() || loaded.stdout.trim()}`,
    );
  }
  run(["launchctl", "enable", `${domain}/${LAUNCH_LABEL}`], {
    allowFailure: true,
  });
  run(["launchctl", "kickstart", "-k", `${domain}/${LAUNCH_LABEL}`], {
    allowFailure: true,
  });
}

async function configureTailscaleServe(tailscaleBin: string): Promise<void> {
  // Dedicated port avoids overwriting the user's existing Serve handlers.
  run([
    tailscaleBin,
    "serve",
    "--bg",
    `--https=${TAILSCALE_HTTPS_PORT}`,
    "--yes",
    LOCAL_ORIGIN,
  ]);
}

function localServerControl(options: LocalShareServerControlOptions = {}): {
  domain: string;
  service: string;
  plistPath: string;
  runCommand: CommandRunner;
} {
  assertDarwin();
  const home = options.home ?? requireHome();
  const uid = options.uid ?? process.getuid!();
  const domain = `gui/${uid}`;
  return {
    domain,
    service: `${domain}/${LAUNCH_LABEL}`,
    plistPath: path.join(
      home,
      "Library",
      "LaunchAgents",
      `${LAUNCH_LABEL}.plist`,
    ),
    runCommand: options.runCommand ?? run,
  };
}

/** Whether the dashboard daemon is currently loaded in launchd. */
export function isLocalShareServerRunning(
  options: LocalShareServerControlOptions = {},
): boolean {
  const control = localServerControl(options);
  return control.runCommand(["launchctl", "print", control.service], {
    allowFailure: true,
  }).ok;
}

/** Restore the dashboard daemon and its private Tailscale Serve endpoint. */
export async function startLocalShareServer(
  options: LocalShareServerControlOptions = {},
): Promise<void> {
  await cleanupLegacyLocalShareRelay(options);
  const control = localServerControl(options);
  if (!(await pathExists(control.plistPath))) {
    throw new Error(
      "Dashboard service is not installed. Run oss setup first.",
    );
  }

  const loaded = control.runCommand(["launchctl", "print", control.service], {
    allowFailure: true,
  }).ok;
  if (!loaded) {
    control.runCommand(["launchctl", "enable", control.service], {
      allowFailure: true,
    });
    control.runCommand([
      "launchctl",
      "bootstrap",
      control.domain,
      control.plistPath,
    ]);
    control.runCommand(["launchctl", "kickstart", "-k", control.service]);
  }
  const tailscaleBin = options.tailscaleBin ?? resolveTailscaleBin();
  control.runCommand([
    tailscaleBin,
    "serve",
    "--bg",
    `--https=${TAILSCALE_HTTPS_PORT}`,
    "--yes",
    LOCAL_ORIGIN,
  ]);
}

/** Shut down dashboard ingress and daemon without terminating OMP. */
export async function stopLocalShareServer(
  options: LocalShareServerControlOptions = {},
): Promise<void> {
  const control = localServerControl(options);
  let serveError: unknown;
  try {
    const tailscaleBin = options.tailscaleBin ?? resolveTailscaleBin();
    control.runCommand([
      tailscaleBin,
      "serve",
      `--https=${TAILSCALE_HTTPS_PORT}`,
      "off",
    ]);
  } catch (err) {
    serveError = err;
  }
  control.runCommand(["launchctl", "bootout", control.service], {
    allowFailure: true,
  });
  if (serveError) throw serveError;
}

/** Resolve pinned OMP source CLI from this package's dependency tree. */
async function resolveBundledOmpCli(): Promise<string> {
  let pkgJson: string;
  try {
    pkgJson = Bun.resolveSync(`${OMP_PKG}/package.json`, PACKAGE_ROOT);
  } catch {
    try {
      pkgJson = Bun.resolveSync(`${OMP_PKG}/package.json`, import.meta.dir);
    } catch {
      throw new Error(
        `Missing dependency ${OMP_PKG}. Reinstall the plugin package so setup can build the omp launcher.`,
      );
    }
  }
  const cli = path.join(path.dirname(pkgJson), "src", "cli.ts");
  if (
    !(await enableCollabGuestTitleGeneration(path.dirname(path.dirname(cli))))
  ) {
    throw new Error(
      "Installed OMP does not expose the supported collab prompt path",
    );
  }
  return cli;
}

async function isOwnedLauncher(filePath: string): Promise<boolean> {
  try {
    const body = await readFile(filePath, "utf8");
    return body.includes(LAUNCHER_MARKER);
  } catch {
    return false;
  }
}

async function writeOwnedLauncher(
  filePath: string,
  sourceCli: string,
): Promise<void> {
  const script =
    `#!/bin/sh\n` +
    `# ${LAUNCHER_MARKER}\n` +
    `exec ${JSON.stringify(resolveBunBin())} ${JSON.stringify(sourceCli)} "$@"\n`;
  await writeFile(filePath, script, { mode: 0o700 });
  await chmod(filePath, 0o700);
}

function zshManagedBlock(): string {
  // zsh's tied, unique `path` array removes any later duplicate while keeping
  // ~/.local/bin first, so new shells resolve our source launcher.
  return [
    ZSH_BLOCK_BEGIN,
    "typeset -U path",
    'path=("$HOME/.local/bin" $path)',
    "export PATH",
    'alias omp="$HOME/.local/bin/omp"',
    ZSH_BLOCK_END,
  ].join("\n");
}

function stripManagedZshBlocks(source: string): string {
  const lines = source.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === ZSH_BLOCK_BEGIN) {
      while (i < lines.length && lines[i] !== ZSH_BLOCK_END) i++;
      if (kept.at(-1) === "") kept.pop();
      continue;
    }
    if (line === ALIAS_MARKER) {
      // Legacy two-line block: marker + alias omp=omp-share
      if (lines[i + 1]?.includes("alias omp=")) i++;
      if (kept.at(-1) === "") kept.pop();
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

async function installLauncherAndAlias(): Promise<void> {
  const home = requireHome();
  const sourceCli = await resolveBundledOmpCli();
  if (!(await pathExists(sourceCli))) {
    throw new Error(
      `OMP source CLI not found at ${sourceCli} (package incomplete)`,
    );
  }

  const userBinDir = path.join(home, ".local", "bin");
  await mkdir(userBinDir, { recursive: true });

  const ossPath = path.join(userBinDir, "oss");
  const sharePath = path.join(userBinDir, "omp-share");
  const ompPath = path.join(userBinDir, "omp");

  const installedSetupCli = path.join(
    path.dirname(getInstalledPluginPackagePath()),
    "setup",
    "cli.ts",
  );
  await writeOwnedLauncher(
    ossPath,
    (await pathExists(installedSetupCli))
      ? installedSetupCli
      : path.join(PACKAGE_ROOT, "setup", "cli.ts"),
  );

  // omp-share is always ours; rewrite freely.
  await writeOwnedLauncher(sharePath, sourceCli);

  // Preserve an independently installed OMP; only create or refresh our own.
  if (!(await pathExists(ompPath)) || (await isOwnedLauncher(ompPath))) {
    await writeOwnedLauncher(ompPath, sourceCli);
  }

  const zshrcPath = path.join(home, ".zshrc");
  let zshrc = "";
  try {
    zshrc = await readFile(zshrcPath, "utf8");
  } catch {
    // create on write
  }
  const cleaned = stripManagedZshBlocks(zshrc).replace(/\s+$/, "");
  const separator = cleaned.length === 0 ? "" : "\n\n";
  await writeFile(zshrcPath, `${cleaned}${separator}${zshManagedBlock()}\n`);
}

async function buildConfig(publicOrigin: string): Promise<ShareConfig> {
  const existing = await loadShareConfig();
  if (existing) {
    return {
      ...existing,
      version: 1,
      localOrigin: LOCAL_ORIGIN,
      publicOrigin,
    };
  }
  return {
    version: 1,
    localOrigin: LOCAL_ORIGIN,
    publicOrigin,
    hostToken: secretToken(),
    dashboardPassword: secretToken(),
    cookieSecret: secretToken(),
  };
}

async function removeLegacyExtensionCopy(): Promise<void> {
  const legacyDir = path.join(agentDir(), "extensions", "omp-sessions-share");
  if (!(await pathExists(legacyDir))) return;
  let owned = false;
  try {
    const manifest = JSON.parse(
      await readFile(path.join(legacyDir, "package.json"), "utf8"),
    ) as { name?: unknown };
    owned =
      manifest.name === "omp-sessions-share-extension" ||
      manifest.name === "omp-sessions-share";
  } catch {
    // Older copies were loose extension directories without a manifest.
  }
  if (!owned) {
    try {
      const entry = await readFile(path.join(legacyDir, "index.ts"), "utf8");
      owned =
        entry.includes("OMP sessions-share host extension") &&
        entry.includes("omp-sessions-share");
    } catch {
      owned = false;
    }
  }
  if (!owned) {
    throw new Error(
      `Refusing to replace unrecognized extension directory: ${legacyDir}. Move it manually, then rerun setup.`,
    );
  }
  await rm(legacyDir, { recursive: true, force: true });
}

/**
 * Idempotent local runtime setup. Safe to call from interactive extension first-run
 * or `omp-sessions-share-setup` CLI. Returns the written ShareConfig.
 */
export async function setupLocalRuntime(): Promise<ShareConfig> {
  assertDarwin();
  await removeLegacyExtensionCopy();
  const tailscaleBin = resolveTailscaleBin();
  const publicOrigin = await discoverPublicOrigin(tailscaleBin);
  const staticDir = await resolveStaticBundleDir();
  const runtimeRoot = await copyRuntimeAssets(staticDir);
  const config = await buildConfig(publicOrigin);
  await writeShareConfig(config);
  await installLaunchAgent(runtimeRoot);
  await configureTailscaleServe(tailscaleBin);
  await installLauncherAndAlias();
  return config;
}

async function removeOwnedLauncher(filePath: string): Promise<void> {
  if (!(await pathExists(filePath))) return;
  if (!(await isOwnedLauncher(filePath))) {
    // Leave foreign binaries alone.
    return;
  }
  await rm(filePath, { force: true });
}

async function removeLauncherAlias(home: string): Promise<void> {
  const zshrcPath = path.join(home, ".zshrc");
  let source: string;
  try {
    source = await readFile(zshrcPath, "utf8");
  } catch {
    return;
  }
  const next = stripManagedZshBlocks(source);
  if (next !== source) {
    await writeFile(
      zshrcPath,
      next.endsWith("\n") || next.length === 0 ? next : `${next}\n`,
    );
  }
}

/** Remove persistent runtime state. Run before `omp plugin uninstall`. */
export async function uninstallLocalRuntime(): Promise<void> {
  assertDarwin();
  const home = requireHome();
  const domain = `gui/${process.getuid!()}`;
  run(["launchctl", "bootout", `${domain}/${LAUNCH_LABEL}`], {
    allowFailure: true,
  });
  await cleanupLegacyLocalShareRelay();
  try {
    const tailscaleBin = resolveTailscaleBin();
    run([tailscaleBin, "serve", `--https=${TAILSCALE_HTTPS_PORT}`, "off"], {
      allowFailure: true,
    });
  } catch {
    // Tailscale may already be removed.
  }
  await rm(runtimeDir(), { recursive: true, force: true });
  await rm(getShareConfigPath(), { force: true });
  await rm(getDashboardLocationsPath(), { force: true });
  const dbPath = getDashboardDbPath();
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
  await rm(
    path.join(home, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`),
    {
      force: true,
    },
  );
  await removeOwnedLauncher(path.join(home, ".local", "bin", "omp-share"));
  await removeOwnedLauncher(path.join(home, ".local", "bin", "oss"));
  await removeOwnedLauncher(path.join(home, ".local", "bin", "omp"));
  await removeLegacyExtensionCopy();
  await removeLauncherAlias(home);
}
