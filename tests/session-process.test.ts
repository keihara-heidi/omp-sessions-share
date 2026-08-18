import { describe, expect, test } from "bun:test";
import {
  buildCloseTerminalArgs,
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
    expect(isKillableSessionCommand("Electron")).toBe(false);
    expect(isKillableSessionCommand("/System/Applications/Utilities/Terminal.app")).toBe(
      false,
    );
  });
});

describe("buildCloseTerminalArgs", () => {
  test("closes only a single-tab Terminal window owning the process TTY", () => {
    const tty = "/dev/ttys123";
    const args = buildCloseTerminalArgs(tty);
    const script = args.slice(1, -1).join(" ");

    expect(args[0]).toBe("/usr/bin/osascript");
    expect(script).toContain("(count of tabs of w) is 1");
    expect(script).toContain("tty of selected tab of w is item 1 of argv");
    expect(script).toContain("close w");
    expect(script).not.toContain(tty);
    expect(args.at(-1)).toBe(tty);
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
