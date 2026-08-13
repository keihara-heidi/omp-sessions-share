import { describe, expect, test } from "bun:test";
import {
  isKillableSessionCommand,
  killSessionProcess,
} from "../daemon/session-process";

describe("isKillableSessionCommand", () => {
  test("allows omp/bun/node, blocks IDE and terminal apps", () => {
    expect(isKillableSessionCommand("bun /Users/dev/.local/bin/omp")).toBe(true);
    expect(isKillableSessionCommand("/Users/dev/.local/bin/omp")).toBe(true);
    expect(
      isKillableSessionCommand("bun node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts"),
    ).toBe(true);
    expect(isKillableSessionCommand(null)).toBe(false);
    expect(isKillableSessionCommand("/Applications/Cursor.app/Contents/MacOS/Cursor")).toBe(
      false,
    );
    expect(
      isKillableSessionCommand("/Applications/Superconductor.app/Contents/MacOS/superconductor"),
    ).toBe(false);
    expect(isKillableSessionCommand("Electron")).toBe(false);
    expect(isKillableSessionCommand("/System/Applications/Utilities/Terminal.app")).toBe(
      false,
    );
  });
});

describe("killSessionProcess", () => {
  test("SIGTERM a bun child and refuses the daemon pid", async () => {
    const child = Bun.spawn(["bun", "-e", "await new Promise(() => {})"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const pid = child.pid;
    expect(pid).toBeGreaterThan(1);
    expect(killSessionProcess(process.pid)).toBe(false);
    expect(killSessionProcess(pid)).toBe(true);
    expect(await child.exited).not.toBe(0);
  });
});
