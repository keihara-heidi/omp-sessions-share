import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  EXIT_USAGE,
  USAGE,
  getDaemonLogPath,
  isAccessLogLine,
  parseCliArgs,
  parseMainCommit,
} from "../setup/cli";
import { formatAccessLogLine } from "../daemon/server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "setup/cli.ts");

function argv(...args: string[]): string[] {
  return ["bun", CLI, ...args];
}

describe("cli parse/dispatch", () => {
  test("help is deterministic for empty, help, --help, -h", () => {
    for (const args of [[], ["help"], ["--help"], ["-h"]]) {
      expect(parseCliArgs(argv(...args))).toEqual({
        ok: true,
        command: { name: "help" },
      });
    }
    expect(USAGE).toContain("oss <command>");
    expect(USAGE).toContain("setup");
    expect(USAGE).toContain("start");
    expect(USAGE).toContain("status");
    expect(USAGE).toContain("register [path]");
    expect(USAGE).toContain("logs [--follow]");
    expect(USAGE).toContain("update");
    expect(USAGE).toContain("uninstall");
    expect(USAGE).not.toContain(" run ");
  });

  test("parses lifecycle and utility commands without side effects", () => {
    expect(parseCliArgs(argv("setup"))).toEqual({
      ok: true,
      command: { name: "setup" },
    });
    expect(parseCliArgs(argv("start"))).toEqual({
      ok: true,
      command: { name: "start" },
    });
    expect(parseCliArgs(argv("stop"))).toEqual({
      ok: true,
      command: { name: "stop" },
    });
    expect(parseCliArgs(argv("restart"))).toEqual({
      ok: true,
      command: { name: "restart" },
    });
    expect(parseCliArgs(argv("status"))).toEqual({
      ok: true,
      command: { name: "status" },
    });
    expect(parseCliArgs(argv("open"))).toEqual({
      ok: true,
      command: { name: "open" },
    });
    expect(parseCliArgs(argv("credentials"))).toEqual({
      ok: true,
      command: { name: "credentials" },
    });
    expect(parseCliArgs(argv("update"))).toEqual({
      ok: true,
      command: { name: "update" },
    });
    expect(parseCliArgs(argv("uninstall"))).toEqual({
      ok: true,
      command: { name: "uninstall" },
    });
    expect(parseCliArgs(argv("register"))).toEqual({
      ok: true,
      command: { name: "register", path: undefined },
    });
    expect(parseCliArgs(argv("register", "/tmp/project"))).toEqual({
      ok: true,
      command: { name: "register", path: "/tmp/project" },
    });
    expect(parseCliArgs(argv("logs"))).toEqual({
      ok: true,
      command: { name: "logs", follow: false },
    });
    expect(parseCliArgs(argv("logs", "--follow"))).toEqual({
      ok: true,
      command: { name: "logs", follow: true },
    });
  });

  test("rejects unknown, extra args, run, and secret-like flags", () => {
    expect(parseCliArgs(argv("run"))).toEqual({
      ok: false,
      error: 'Unknown command "run". Use --help.',
      exitCode: EXIT_USAGE,
    });
    expect(parseCliArgs(argv("status", "--json")).ok).toBe(false);
    expect(parseCliArgs(argv("logs", "--all")).ok).toBe(false);
    expect(parseCliArgs(argv("register", "a", "b")).ok).toBe(false);
    expect(parseCliArgs(argv("--password=nope"))).toMatchObject({
      ok: false,
      exitCode: EXIT_USAGE,
    });
    expect(parseCliArgs(argv("setup", "--token=abc")).ok).toBe(false);
    expect(parseCliArgs(argv("--host-token")).ok).toBe(false);
  });

  test("subprocess help prints usage and exits 0", () => {
    const result = Bun.spawnSync(["bun", CLI, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const out = new TextDecoder().decode(result.stdout);
    expect(out).toContain("Usage: oss <command>");
    expect(out).toContain("credentials");
    expect(out).not.toMatch(/token|cookieSecret|hostToken/i);
  });

  test("subprocess unknown command exits 2 with usage error", () => {
    const result = Bun.spawnSync(["bun", CLI, "run"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    const err = new TextDecoder().decode(result.stderr);
    expect(err).toContain('Unknown command "run"');
  });

  test("daemon log path matches LaunchAgent StandardOutPath layout", () => {
    expect(getDaemonLogPath("/Users/example")).toBe(
      "/Users/example/.omp/logs/omp-sessions-share.log",
    );
  });
});

describe("data-safe update", () => {
  test("accepts only the exact main commit response", () => {
    const sha = "a".repeat(40);
    expect(parseMainCommit(`${sha}\trefs/heads/main\n`)).toBe(sha);
    expect(parseMainCommit(`${sha}\trefs/heads/other\n`)).toBeNull();
    expect(parseMainCommit("not-a-commit\trefs/heads/main\n")).toBeNull();
  });

  test("reinstalls and runs setup without invoking local cleanup", async () => {
    const source = await readFile(CLI, "utf8");
    const update = source.slice(
      source.indexOf("async function cmdUpdate"),
      source.indexOf("async function cmdUninstall"),
    );
    expect(update).toContain('"git", "ls-remote"');
    expect(update).toContain('"plugin", "install"');
    expect(update).toContain("resolveInstalledSetupEntry()");
    expect(update).not.toContain("uninstallLocalRuntime");
    expect(update).not.toContain("getDashboardDbPath");
  });
});

describe("sanitized access log line", () => {
  test("includes timestamp method pathname status duration only", () => {
    const line = formatAccessLogLine({
      at: new Date("2026-08-18T12:41:03.000Z"),
      method: "get",
      pathname: "/api/dashboard",
      status: 200,
      durationMs: 14.4,
    });
    expect(line).toBe(
      "2026-08-18T12:41:03.000Z GET /api/dashboard 200 14ms",
    );
    expect(line).not.toContain("?");
    expect(line).not.toContain("authorization");
    expect(line).not.toContain("password");
    expect(isAccessLogLine(line)).toBe(true);
    expect(isAccessLogLine("  config: /Users/private/.omp/config.json")).toBe(false);
    expect(isAccessLogLine("startup failed: secret stderr")).toBe(false);
  });
});
