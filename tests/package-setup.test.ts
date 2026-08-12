import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LISTEN_HOST,
  DEFAULT_LISTEN_PORT,
  DEFAULT_LOCAL_ORIGIN,
  getShareConfigPath,
  listenEndpoint,
  loadShareConfig,
  parseShareConfig,
  writeShareConfig,
  type ShareConfig,
} from "../shared/config";
import { resolveWebRoot, safeJoin } from "../daemon/static";
import { setupLocalRuntime } from "../setup/install";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
  name?: string;
  private?: boolean;
  license?: string;
  os?: string[];
  files?: string[];
  bin?: Record<string, string>;
  omp?: { extensions?: string[] };
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const VALID: ShareConfig = {
  version: 1,
  localOrigin: DEFAULT_LOCAL_ORIGIN,
  publicOrigin: "https://mac.tailnet-name.ts.net:8443",
  hostToken: "h".repeat(32),
  dashboardPassword: "p".repeat(32),
  cookieSecret: "c".repeat(32),
};

const tempDirs: string[] = [];
const envSnapshot = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OMP_SESSIONS_SHARE_WEB: process.env.OMP_SESSIONS_SHARE_WEB,
  HOME: process.env.HOME,
};

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (envSnapshot.PI_CODING_AGENT_DIR === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = envSnapshot.PI_CODING_AGENT_DIR;
  }
  if (envSnapshot.OMP_SESSIONS_SHARE_WEB === undefined) {
    delete process.env.OMP_SESSIONS_SHARE_WEB;
  } else {
    process.env.OMP_SESSIONS_SHARE_WEB = envSnapshot.OMP_SESSIONS_SHARE_WEB;
  }
  if (envSnapshot.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = envSnapshot.HOME;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("public package manifest", () => {
  test("is public MIT darwin package with omp extension + setup bin", () => {
    expect(PKG.private).not.toBe(true);
    expect(PKG.publishConfig?.access).toBe("public");
    expect(PKG.license).toBe("MIT");
    expect(PKG.os).toEqual(["darwin"]);
    expect(PKG.bin?.["omp-sessions-share"]).toBe("./setup/cli.ts");
    expect(PKG.omp?.extensions).toEqual(["./extension/index.ts"]);
  });

  test("files include runtime surface and exclude app source", () => {
    const files = PKG.files ?? [];
    for (const required of ["LICENSE", "daemon", "shared", "setup", "out", "extension"]) {
      expect(files).toContain(required);
    }
    // Dashboard is prebuilt into out/; app/ stays publish-time build input only.
    expect(files).not.toContain("app");
    expect(files).not.toContain("tests");
  });

  test("runtime dependencies are only the pinned OMP agent package", () => {
    const deps = PKG.dependencies ?? {};
    expect(Object.keys(deps).sort()).toEqual(["@oh-my-pi/pi-coding-agent"]);
    expect(deps["@oh-my-pi/pi-coding-agent"]).toMatch(/^\d+\.\d+\.\d+$/);
    // UI stack must not ship as runtime deps of the local package.
    for (const name of ["next", "react", "react-dom", "@upstash/redis"]) {
      expect(deps[name]).toBeUndefined();
    }
  });

  test("packaged paths exist on disk for files globs", async () => {
    for (const rel of ["LICENSE", "daemon", "shared", "setup", "extension", "out"]) {
      const st = await stat(path.join(ROOT, rel)).catch(() => null);
      // out/ may be absent pre-build in a fresh checkout; still required in files.
      if (rel === "out" && !st) continue;
      expect(st, rel).not.toBeNull();
    }
    const license = await readFile(path.join(ROOT, "LICENSE"), "utf8");
    expect(license.startsWith("MIT License")).toBe(true);
  });
});

describe("share config parse/write", () => {
  test("accepts exact loopback localOrigin + https *.ts.net:8443 publicOrigin", () => {
    const parsed = parseShareConfig(VALID);
    expect(parsed).toEqual(VALID);
    expect(listenEndpoint(parsed!).hostname).toBe(DEFAULT_LISTEN_HOST);
    expect(listenEndpoint(parsed!).port).toBe(DEFAULT_LISTEN_PORT);
  });

  test("rejects non-loopback, missing/wrong port, http tailnet, and short secrets", () => {
    expect(parseShareConfig({ ...VALID, localOrigin: "http://localhost:7466" })).toBeNull();
    expect(parseShareConfig({ ...VALID, localOrigin: "http://127.0.0.1:80" })).toBeNull();
    expect(parseShareConfig({ ...VALID, publicOrigin: "http://mac.ts.net:8443" })).toBeNull();
    expect(parseShareConfig({ ...VALID, publicOrigin: "https://mac.ts.net" })).toBeNull();
    expect(parseShareConfig({ ...VALID, publicOrigin: "https://mac.ts.net:443" })).toBeNull();
    expect(parseShareConfig({ ...VALID, publicOrigin: "https://example.com:8443" })).toBeNull();
    expect(parseShareConfig({ ...VALID, hostToken: "short" })).toBeNull();
    expect(parseShareConfig({ ...VALID, version: 2 })).toBeNull();
  });

  test("write/load uses PI_CODING_AGENT_DIR and mode 0600", async () => {
    const agent = await makeTemp("omp-share-cfg-");
    process.env.PI_CODING_AGENT_DIR = agent;

    expect(getShareConfigPath()).toBe(path.join(agent, "omp-sessions-share.json"));

    await writeShareConfig(VALID);
    const cfgPath = getShareConfigPath();
    const mode = (await stat(cfgPath)).mode & 0o777;
    expect(mode).toBe(0o600);

    const loaded = await loadShareConfig();
    expect(loaded).toEqual(VALID);

    const raw = JSON.parse(await readFile(cfgPath, "utf8")) as ShareConfig;
    expect(raw.localOrigin).toBe(DEFAULT_LOCAL_ORIGIN);
    expect(raw.publicOrigin).toBe(VALID.publicOrigin);
  });

  test("writeShareConfig refuses invalid payload and stays inside explicit path", async () => {
    const agent = await makeTemp("omp-share-bad-");
    const cfgPath = path.join(agent, "omp-sessions-share.json");
    await expect(
      writeShareConfig({ ...VALID, publicOrigin: "https://not-tailnet.example" }, cfgPath),
    ).rejects.toThrow(/invalid share config/i);
    await expect(stat(cfgPath)).rejects.toThrow();
  });
});

describe("setup contract without system mutation", () => {
  test("setupLocalRuntime is importable and not invoked", () => {
    expect(typeof setupLocalRuntime).toBe("function");
    // Calling would touch launchctl/Tailscale/HOME — deliberately not invoked here.
  });

  test("CLI rejects secret-like argv before setup runs", async () => {
    const cases = [
      ["--host-token=abc"],
      ["--cookie-secret=xyz"],
      ["--password", "nope"],
      ["--token"],
      ["DASHBOARD_PASSWORD=x"],
    ];
    for (const args of cases) {
      const proc = Bun.spawn({
        cmd: ["bun", path.join(ROOT, "setup/cli.ts"), ...args],
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          // Isolate any accidental deeper path; guard should exit first.
          PI_CODING_AGENT_DIR: path.join(tmpdir(), "omp-share-should-not-write"),
          HOME: path.join(tmpdir(), "omp-share-home-should-not-write"),
        },
      });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code, args.join(" ")).toBe(2);
      expect(stderr).toMatch(/Refusing secret-like CLI flags/i);
    }
  });

  test("CLI help exits 0 without running setup", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", path.join(ROOT, "setup/cli.ts"), "--help"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: path.join(tmpdir(), "omp-share-help-no-write"),
        HOME: path.join(tmpdir(), "omp-share-help-home"),
      },
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/omp-sessions-share/);
    expect(stdout).toMatch(/never passed on argv/i);
  });

  test("installer source never accepts secrets via argv and generates them locally", async () => {
    const installSrc = await readFile(path.join(ROOT, "setup/install.ts"), "utf8");
    const cliSrc = await readFile(path.join(ROOT, "setup/cli.ts"), "utf8");

    expect(cliSrc).toMatch(/Refusing secret-like CLI flags/);
    expect(cliSrc).toMatch(/lower\.includes\("token"\)/);
    expect(cliSrc).toMatch(/lower\.includes\("password"\)/);
    expect(cliSrc).toMatch(/lower\.includes\("secret"\)/);

    // setupLocalRuntime takes no secret parameters.
    expect(installSrc).toMatch(/export async function setupLocalRuntime\(\): Promise<ShareConfig>/);
    expect(installSrc).not.toMatch(/setupLocalRuntime\([^)]*(token|password|secret)/i);

    // Secrets are generated, not read from argv/env in installer.
    expect(installSrc).toMatch(/hostToken:\s*secretToken\(\)/);
    expect(installSrc).toMatch(/dashboardPassword:\s*secretToken\(\)/);
    expect(installSrc).toMatch(/cookieSecret:\s*secretToken\(\)/);
    expect(installSrc).not.toMatch(/process\.argv/);
    expect(installSrc).not.toMatch(/OMPI_SHARE_HOST_TOKEN|OMPI_SHARE_COOKIE_SECRET|OMPI_SHARE_DASHBOARD_PASSWORD/);
  });
});

describe("packaged path resolution fixtures", () => {
  test("resolveWebRoot prefers OMP_SESSIONS_SHARE_WEB over sibling web/", async () => {
    const fixture = await makeTemp("omp-share-web-");
    const sibling = path.join(fixture, "daemon");
    const envWeb = path.join(fixture, "env-web");
    await mkdir(path.join(sibling, "web"), { recursive: true });
    await mkdir(envWeb, { recursive: true });
    await writeFile(path.join(sibling, "web", "index.html"), "<html>sibling</html>\n");
    await writeFile(path.join(envWeb, "index.html"), "<html>env</html>\n");

    delete process.env.OMP_SESSIONS_SHARE_WEB;
    expect(resolveWebRoot(sibling)).toBe(path.resolve(sibling, "web"));

    process.env.OMP_SESSIONS_SHARE_WEB = envWeb;
    expect(resolveWebRoot(sibling)).toBe(path.resolve(envWeb));
  });

  test("safeJoin blocks traversal outside packaged web root", async () => {
    const web = await makeTemp("omp-share-safe-");
    await writeFile(path.join(web, "index.html"), "<html>ok</html>\n");
    expect(safeJoin(web, "/index.html")).toBe(path.join(web, "index.html"));
    expect(safeJoin(web, "/../package.json")).toBeNull();
    expect(safeJoin(web, "/%2e%2e/package.json")).toBeNull();
  });

  test("installer runtime layout constants point at package-local assets", async () => {
    const installSrc = await readFile(path.join(ROOT, "setup/install.ts"), "utf8");
    // Runtime copy sources are package dirs, not absolute user paths.
    expect(installSrc).toMatch(/PACKAGE_ROOT\s*=\s*path\.resolve\(import\.meta\.dir,\s*"\.\."\)/);
    expect(installSrc).toMatch(/path\.join\(PACKAGE_ROOT,\s*"web"\)/);
    expect(installSrc).toMatch(/path\.join\(PACKAGE_ROOT,\s*"out"\)/);
    expect(installSrc).toMatch(/LOCAL_ORIGIN\s*=\s*"http:\/\/127\.0\.0\.1:7466"/);
    expect(installSrc).toMatch(/TAILSCALE_HTTPS_PORT\s*=\s*8443/);
    expect(installSrc).toMatch(/LAUNCH_LABEL\s*=\s*"sh\.omp\.sessions-share"/);
    expect(installSrc).toMatch(/RUNTIME_DIR_NAME\s*=\s*"omp-sessions-share-runtime"/);
    // Launcher wraps pinned OMP CLI from dependency tree, not a global binary guess.
    expect(installSrc).toMatch(/@oh-my-pi\/pi-coding-agent/);
    expect(installSrc).toMatch(/src", "cli\.ts"/);
    expect(installSrc).toMatch(/\.local", "bin"/);
    expect(installSrc).toMatch(/omp-share/);
  });

  test("getShareConfigPath honors temp agent dir without touching ~/.omp", async () => {
    const agent = await makeTemp("omp-share-path-");
    const outside = path.join(agent, "outside-home");
    process.env.HOME = outside;
    process.env.PI_CODING_AGENT_DIR = agent;
    expect(getShareConfigPath()).toBe(path.join(agent, "omp-sessions-share.json"));
    expect(getShareConfigPath().startsWith(outside)).toBe(false);
  });
});
