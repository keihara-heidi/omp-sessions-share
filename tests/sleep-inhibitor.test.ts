import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { MacSleepInhibitor } from "../daemon/sleep-inhibitor";

class FakeChild extends EventEmitter {
	killed = false;
	signal: NodeJS.Signals | number | undefined;

	kill(signal?: NodeJS.Signals | number): boolean {
		this.killed = true;
		this.signal = signal;
		return true;
	}
}

describe("macOS sleep inhibitor", () => {
	test("holds one caffeinate assertion until stopped", () => {
		const child = new FakeChild();
		const calls: Array<{ command: string; args: readonly string[]; stdio: string }> = [];
		const inhibitor = new MacSleepInhibitor((command, args, options) => {
			calls.push({ command, args, stdio: options.stdio });
			return child as unknown as ChildProcess;
		}, 4321, "darwin");

		expect(inhibitor.start()).toBe(true);
		expect(inhibitor.start()).toBe(true);
		expect(calls).toEqual([
			{
				command: "/usr/bin/caffeinate",
				args: ["-i", "-w", "4321"],
				stdio: "ignore",
			},
		]);
		expect(inhibitor.active).toBe(true);

		inhibitor.stop();
		expect(child.signal).toBe("SIGTERM");
		expect(inhibitor.active).toBe(false);
	});

	test("can restart after caffeinate exits", () => {
		const children: FakeChild[] = [];
		const inhibitor = new MacSleepInhibitor(() => {
			const child = new FakeChild();
			children.push(child);
			return child as unknown as ChildProcess;
		}, 123, "darwin");

		expect(inhibitor.start()).toBe(true);
		children[0]!.emit("exit", 0, null);
		expect(inhibitor.active).toBe(false);
		expect(inhibitor.start()).toBe(true);
		expect(children).toHaveLength(2);
	});

	test("does nothing outside macOS", () => {
		let spawned = false;
		const inhibitor = new MacSleepInhibitor(() => {
			spawned = true;
			return new FakeChild() as unknown as ChildProcess;
		}, 123, "linux");

		expect(inhibitor.start()).toBe(false);
		expect(spawned).toBe(false);
	});
});
