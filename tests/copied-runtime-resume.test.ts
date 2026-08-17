/**
 * INT-03 — Copied runtime resume durability without node_modules/Prisma.
 *
 * Mirrors setup's package-local runtime layout (daemon/, shared/, lib/*) under a
 * temp agent dir, imports modules from that copy only, and proves:
 * - bun:sqlite resolves without a copied node_modules tree
 * - resume heartbeat state persists across store/DB reopen
 * - public Recent shape never includes sessionFile
 * - exact sessionFile is host-only via getResumeSession
 * - SQLite state lands beside config under PI_CODING_AGENT_DIR, never inside runtime
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_DIR_NAME = "omp-sessions-share-runtime";

const envSnapshot = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  HOME: process.env.HOME,
};

type CopiedStore = {
  configureDashboardDb: (dbPath: string, legacyLocationsPath?: string) => void;
  deactivateSession: (id: string) => boolean;
  getResumeSession: (resumeId: string) => {
    resumeId: string;
    sessionId: string;
    sessionFile: string;
    title: string;
  } | null;
  getSessionDashboard: () => {
    sessions: unknown[];
    recentSessions: Array<Record<string, unknown>>;
  };
  listRecentSessions: () => Array<Record<string, unknown>>;
  resetStoreForTests: () => void;
  setNowForTests: (fn: (() => number) | null) => void;
  upsertSession: (input: {
    id: string;
    title: string;
    cwd: string;
    startedAt: string;
    sessionFile?: string;
    pid?: number;
  }) => Record<string, unknown>;
  SESSION_TTL_SECONDS?: number;
};

type CopiedConfig = {
  getDashboardDbPath: (root?: string) => string;
  getShareConfigPath: (root?: string) => string;
};

type CopiedContracts = {
  SESSION_TTL_SECONDS: number;
};

const temps: string[] = [];
let activeStore: CopiedStore | undefined;

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function restoreEnv(): void {
  if (envSnapshot.PI_CODING_AGENT_DIR === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = envSnapshot.PI_CODING_AGENT_DIR;
  }
  if (envSnapshot.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = envSnapshot.HOME;
  }
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) out.push(full);
    }
  }
  return out;
}

/** Match setup/install.ts copyRuntimeAssets layout (daemon + shared + lib/*). */
function materializeCopiedRuntime(agentDir: string): string {
  const runtimeRoot = join(agentDir, RUNTIME_DIR_NAME);
  mkdirSync(runtimeRoot, { recursive: true });

  for (const name of ["daemon", "shared"] as const) {
    cpSync(join(PACKAGE_ROOT, name), join(runtimeRoot, name), { recursive: true });
  }

  mkdirSync(join(runtimeRoot, "lib"), { recursive: true });
  for (const file of ["contracts.ts", "auth.ts"] as const) {
    cpSync(join(PACKAGE_ROOT, "lib", file), join(runtimeRoot, "lib", file));
  }

  // Minimal web stub so static defaults never reach into the package tree.
  const web = join(runtimeRoot, "daemon", "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>runtime</title>\n");

  // Explicitly ensure no dependency tree is present in the copied runtime.
  rmSync(join(runtimeRoot, "node_modules"), { recursive: true, force: true });
  return runtimeRoot;
}

function assertNoNodeModules(runtimeRoot: string): void {
  expect(existsSync(join(runtimeRoot, "node_modules"))).toBe(false);
  for (const file of walkFiles(runtimeRoot)) {
    const rel = relative(runtimeRoot, file);
    expect(rel.includes(`${"node_modules"}/`)).toBe(false);
  }
}

function assertNoPrisma(runtimeRoot: string): void {
  for (const file of walkFiles(runtimeRoot)) {
    if (!file.endsWith(".ts") && !file.endsWith(".js") && !file.endsWith(".json")) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    expect(text.toLowerCase().includes("prisma"), relative(runtimeRoot, file)).toBe(
      false,
    );
  }
}

function assertNoSqliteUnder(runtimeRoot: string): void {
  for (const file of walkFiles(runtimeRoot)) {
    const base = file.split("/").pop() ?? file;
    expect(base.endsWith(".sqlite"), relative(runtimeRoot, file)).toBe(false);
    expect(base.endsWith(".sqlite-wal"), relative(runtimeRoot, file)).toBe(false);
    expect(base.endsWith(".sqlite-shm"), relative(runtimeRoot, file)).toBe(false);
  }
}

async function importCopiedModules(runtimeRoot: string): Promise<{
  store: CopiedStore;
  config: CopiedConfig;
  contracts: CopiedContracts;
}> {
  // Runtime-selected path: load from temp copied layout, not PACKAGE_ROOT.
  // Static imports would bind in-tree sources and skip the install boundary.
  const storeUrl = pathToFileURL(join(runtimeRoot, "daemon", "store.ts")).href;
  const configUrl = pathToFileURL(join(runtimeRoot, "shared", "config.ts")).href;
  const contractsUrl = pathToFileURL(join(runtimeRoot, "lib", "contracts.ts")).href;

  const [store, config, contracts] = await Promise.all([
    import(storeUrl) as Promise<CopiedStore>,
    import(configUrl) as Promise<CopiedConfig>,
    import(contractsUrl) as Promise<CopiedContracts>,
  ]);
  return { store, config, contracts };
}

afterEach(() => {
  try {
    activeStore?.resetStoreForTests();
  } catch {
    // best-effort
  }
  activeStore = undefined;
  restoreEnv();
  while (temps.length > 0) {
    const dir = temps.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("INT-03 copied runtime resume", () => {
  test("bun:sqlite resume heartbeat survives reopen without node_modules or runtime state", async () => {
    const agentDir = makeTemp("omp-int03-agent-");
    const outsideHome = join(agentDir, "outside-home");
    mkdirSync(outsideHome, { recursive: true });

    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = outsideHome;

    const runtimeRoot = materializeCopiedRuntime(agentDir);
    assertNoNodeModules(runtimeRoot);
    assertNoPrisma(runtimeRoot);

    const { store, config, contracts } = await importCopiedModules(runtimeRoot);
    activeStore = store;

    // Prove the built-in resolves from the copied graph (no package deps).
    const sqliteMod = await import("bun:sqlite");
    expect(typeof sqliteMod.Database).toBe("function");

    const dbPath = config.getDashboardDbPath();
    expect(dbPath).toBe(join(agentDir, "omp-sessions-share.sqlite"));
    expect(dbPath.startsWith(runtimeRoot + "/")).toBe(false);
    expect(dbPath.startsWith(outsideHome)).toBe(false);
    expect(config.getShareConfigPath()).toBe(join(agentDir, "omp-sessions-share.json"));

    const worktree = makeTemp("omp-int03-wt-");
    const sessionFile = join(agentDir, "sessions", "exact-resume.jsonl");
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, '{"type":"session"}\n{"type":"message","role":"user"}\n');

    const t0 = 1_700_000_000_000;
    store.setNowForTests(() => t0);
    store.configureDashboardDb(dbPath);

    const live = store.upsertSession({
      id: "copied-sess-1",
      title: "Copied runtime title",
      cwd: worktree,
      startedAt: "2026-08-12T00:00:00.000Z",
      sessionFile,
    });

    expect(live).not.toHaveProperty("sessionFile");
    expect(JSON.stringify(live)).not.toContain(sessionFile);
    expect(store.getSessionDashboard().sessions).toHaveLength(1);
    expect(store.getSessionDashboard().recentSessions).toEqual([]);
    expect(store.listRecentSessions()).toEqual([]);

    // Move off live so Recent can surface the opaque resume id.
    expect(store.deactivateSession("copied-sess-1")).toBe(true);

    const afterDeactivate = store.getSessionDashboard();
    expect(afterDeactivate.sessions).toEqual([]);
    expect(afterDeactivate.recentSessions).toHaveLength(1);
    const recent = afterDeactivate.recentSessions[0]!;
    expect(recent.id).not.toBe("copied-sess-1");
    expect(recent.title).toBe("Copied runtime title");
    expect(recent).not.toHaveProperty("sessionFile");
    expect(recent).not.toHaveProperty("sessionId");
    expect(JSON.stringify(afterDeactivate)).not.toContain(sessionFile);
    expect(JSON.stringify(store.listRecentSessions())).not.toContain(sessionFile);

    const privateRow = store.getResumeSession(String(recent.id));
    expect(privateRow?.sessionId).toBe("copied-sess-1");
    expect(privateRow?.sessionFile).toBe(sessionFile);
    expect(privateRow?.title).toBe("Copied runtime title");

    // DB must live beside agent config, never under the copied runtime tree.
    expect(existsSync(dbPath)).toBe(true);
    assertNoSqliteUnder(runtimeRoot);

    // Simulate daemon restart: wipe in-memory store, reopen same SQLite path.
    store.resetStoreForTests();
    store.setNowForTests(() => t0 + contracts.SESSION_TTL_SECONDS * 1000);
    store.configureDashboardDb(dbPath);

    const reloaded = store.getSessionDashboard();
    expect(reloaded.sessions).toEqual([]);
    expect(reloaded.recentSessions).toHaveLength(1);
    expect(reloaded.recentSessions[0]).toMatchObject({
      id: recent.id,
      title: "Copied runtime title",
    });
    expect(reloaded.recentSessions[0]).not.toHaveProperty("sessionFile");
    expect(JSON.stringify(reloaded)).not.toContain(sessionFile);

    const privateAfterReopen = store.getResumeSession(String(recent.id));
    expect(privateAfterReopen?.sessionId).toBe("copied-sess-1");
    expect(privateAfterReopen?.sessionFile).toBe(sessionFile);

    // Still no dependency tree / ORM and no state files leaked into runtime.
    assertNoNodeModules(runtimeRoot);
    assertNoPrisma(runtimeRoot);
    assertNoSqliteUnder(runtimeRoot);
    expect(existsSync(dbPath)).toBe(true);
  });
});
