/**
 * OMP sessions-share host extension.
 *
 * Docs (native `/collab`):
 * - docs/collab.md: native `/collab` owns AES-GCM room + browser deep link; link possession is trust boundary.
 * - ExtensionContext has no collab/start-builtin API; no documented builtin execution API.
 * - TUI emits `input` before builtin slash dispatch → intercept native `/collab` to re-show the captured link.
 * - Managed timers required for background work.
 *
 * Compatibility bridge (isolated, version-checked): capture native collab `webLink` without reimplementing collab.
 * Bundled `omp` inlines CollabHost (minified); source installs keep a separate module. We therefore:
 *   1) best-effort patch CollabHost.prototype when the live class is importable
 *   2) capture browser deep links from OSC-8 sequences that `/collab` prints via showStatus
 * Never log tokens, key material, ciphertext, or collab links.
 *
 * Local runtime: heartbeats hit loopback daemon with Bearer host token when that daemon is already
 * running. This extension never starts/stops launchd or Tailscale. Native host always uses
 * ws://127.0.0.1:7466; password-gated guest links wrap config.publicOrigin via https://my.omp.sh/#…
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadShareConfig, type ShareConfig } from "../shared/config";
import { enableCollabGuestTitleGeneration } from "../setup/install";
import { encryptWithPublicJwk, type PublicKeyJwk } from "./crypto";

// ---- local contracts (standalone; do not import root lib/) ----

type JoinRequestStatus = "pending" | "approved" | "denied" | "expired";

type JoinRequest = {
	id: string;
	sessionId: string;
	deviceName: string;
	publicKeyJwk: PublicKeyJwk;
	createdAt: string;
	status: JoinRequestStatus;
};

type EncryptedLink = {
	algorithm: "RSA-OAEP-256";
	ciphertext: string;
};

const SESSION_ORIGIN_ENV = "OMP_SESSION_ORIGIN";
type SessionOrigin = "workspace" | "adhoc";

export function sessionOriginFromEnv(
	env: Readonly<Record<string, string | undefined>> = process.env,
): SessionOrigin {
	return env[SESSION_ORIGIN_ENV] === "adhoc" ? "adhoc" : "workspace";
}

type SessionHeartbeat = {
	id: string;
	title: string;
	cwd: string;
	startedAt: string;
	origin: SessionOrigin;
	pid: number;
	/** Absolute host path to the session jsonl; host-only, never logged. */
	sessionFile?: string;
};

type ApiOk<T> = { data: T };
type ApiErr = { error: string };

type HostApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

type CollabHostLike = {
	readonly webLink: string;
	start(relayUrl: string, webUrl?: string): Promise<void>;
	stop(reason: string): Promise<void>;
};

type CollabHostCtor = {
	prototype: CollabHostLike;
	new (...args: never[]): CollabHostLike;
};

type CollabQrCodeCtor = {
	prototype: { render(width: number): string[] };
};

type BridgeState = {
	versionOk: boolean;
	version: string | null;
	reason?: string;
	/** Native loopback deep link; never logged. */
	rawWebLink: string | null;
	/** Public guest link (my.omp.sh wrap); never logged. */
	webLink: string | null;
	waiters: Array<(link: string | null) => void>;
	stdoutPatched: boolean;
	pumpPatched: boolean;
	stdoutTail: string;
	protoPatched: boolean;
};

type SessionRuntime = {
	sessionId: string;
	startedAt: string;
	cwd: string;
	origin: SessionOrigin;
	title: string;
	/** Exact session jsonl path when known; never derived from cwd. */
	sessionFile?: string;
	ctx: ExtensionContext;
	pollTimer?: Timer;
	polling: boolean;
	lastHeartbeatAt: number;
	prompted: Set<string>;
	busy: Set<string>;
	collabStartAttempted: boolean;
	shareStopped: boolean;
	lastErrorAt: number;
};

const OSC8_RE = /\x1b\]8;[^;]*;(https?:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g;
const COLLAB_FRAGMENT_RE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{64}$/;
const PUBLIC_COLLAB_WEB_ORIGIN = "https://my.omp.sh";
const NATIVE_COLLAB_WS = "ws://127.0.0.1:7466";
const NATIVE_COLLAB_COMMAND = `/collab ${NATIVE_COLLAB_WS}`;
const JOIN_REQUEST_POLL_MS = 1_000;
// Enters spaced 1.5s (150 polls x 10ms). OMP 18 wires key dispatch only after
// TUI init completes: ~4s in real terminals, ~20s in bare PTYs.
const SUBMIT_ROUNDS = 20;
const SUBMIT_RETRY_ROUNDS = 4;
const SUBMIT_POLLS_PER_ROUND = 150;
const LOOPBACK_HTTP_ORIGINS: Record<string, true> = {
	"http://127.0.0.1:7466": true,
	"http://localhost:7466": true,
};
const LOOPBACK_WS_PREFIXES = ["ws://127.0.0.1:7466/r/", "ws://localhost:7466/r/"] as const;

const bridge: BridgeState = {
	versionOk: false,
	version: null,
	rawWebLink: null,
	webLink: null,
	waiters: [],
	stdoutPatched: false,
	pumpPatched: false,
	stdoutTail: "",
	protoPatched: false,
};

let runtime: SessionRuntime | null = null;
/** undefined = not loaded yet; null = missing/invalid. */
let cachedConfig: ShareConfig | null | undefined;

// ---- config ----

async function getShareConfig(): Promise<ShareConfig | null> {
	if (cachedConfig !== undefined) return cachedConfig;
	try {
		cachedConfig = await loadShareConfig();
	} catch {
		cachedConfig = null;
	}
	if (cachedConfig) applyConfigToBridge(cachedConfig);
	return cachedConfig;
}

function applyConfigToBridge(config: ShareConfig): void {
	if (!bridge.rawWebLink || bridge.webLink) return;
	const guest = normalizeCollabWebLink(bridge.rawWebLink, config);
	if (!guest) return;
	bridge.webLink = guest;
	settleWaiters(guest);
	if (!runtime || runtime.shareStopped) return;
	startPollLoop(runtime);
	notifyInfo(
		runtime.ctx,
		`Sessions share connected\n  URL: ${config.publicOrigin}`,
	);
}

// ---- version + package root ----

function readPackageVersion(pkgRoot: string | null): string | null {
	if (!pkgRoot) return null;
	try {
		const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as { version?: string };
		return typeof pkg.version === "string" ? pkg.version : null;
	} catch {
		return null;
	}
}

export function versionCompatible(version: string | null): boolean {
	void version;
	return true;
}

/** Locate installed @oh-my-pi/pi-coding-agent root (source tree next to bundled cli). */
function findCodingAgentRoot(): string | null {
	const candidates: string[] = [];

	for (const entry of [process.argv[1], process.execPath]) {
		if (!entry) continue;
		try {
			let dir = path.dirname(path.resolve(entry));
			for (let i = 0; i < 10; i++) {
				const pkgPath = path.join(dir, "package.json");
				if (existsSync(pkgPath)) {
					try {
						const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
						if (pkg.name === "@oh-my-pi/pi-coding-agent") {
							candidates.push(dir);
							break;
						}
					} catch {
						// continue walking
					}
				}
				const parent = path.dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		} catch {
			// ignore
		}
	}

	const home = process.env.HOME;
	if (home) {
		candidates.push(path.join(home, ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent"));
	}

	// createRequire().resolve() can spin at 100% CPU forever inside the compiled
	// omp binary when cwd is outside this package (standalone-bun resolver falls
	// back to cwd-based resolution). The dependency lives at a known relative
	// path (own node_modules, or hoisted sibling) — check those directly instead.
	candidates.push(
		path.join(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent"),
		path.join(import.meta.dir, "../../@oh-my-pi/pi-coding-agent"),
	);

	for (const root of candidates) {
		if (existsSync(path.join(root, "package.json"))) return root;
	}
	return null;
}


// ---- bridge: capture webLink ----

function settleWaiters(link: string | null): void {
	const waiters = bridge.waiters.splice(0, bridge.waiters.length);
	for (const w of waiters) w(link);
}

function parseNativeCollabLink(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (!LOOPBACK_HTTP_ORIGINS[parsed.origin] || parsed.pathname !== "/") return null;
		const fragment = decodeURIComponent(parsed.hash.slice(1));
		for (const prefix of LOOPBACK_WS_PREFIXES) {
			if (!fragment.startsWith(prefix)) continue;
			const secret = fragment.slice(prefix.length);
			if (!COLLAB_FRAGMENT_RE.test(secret)) return null;
			return url;
		}
		return null;
	} catch {
		return null;
	}
}

function normalizeCollabWebLink(url: string, config: ShareConfig): string | null {
	const native = parseNativeCollabLink(url);
	if (!native) return null;
	try {
		const parsed = new URL(native);
		const fragment = decodeURIComponent(parsed.hash.slice(1));
		let secret: string | null = null;
		for (const prefix of LOOPBACK_WS_PREFIXES) {
			if (fragment.startsWith(prefix)) {
				secret = fragment.slice(prefix.length);
				break;
			}
		}
		if (!secret || !COLLAB_FRAGMENT_RE.test(secret)) return null;
		const publicOrigin = new URL(config.publicOrigin);
		if (publicOrigin.protocol !== "https:" || publicOrigin.pathname !== "/" || publicOrigin.search || publicOrigin.hash) {
			return null;
		}
		return `${PUBLIC_COLLAB_WEB_ORIGIN}/#${publicOrigin.host}/r/${secret}`;
	} catch {
		return null;
	}
}

function noteWebLink(link: string): void {
	if (!link || bridge.rawWebLink) return;
	const native = parseNativeCollabLink(link);
	if (!native) return;
	bridge.rawWebLink = native;

	const config = cachedConfig ?? null;
	if (config) applyConfigToBridge(config);
	// Config not ready yet — waiters stay open until applyConfigToBridge.
}

function clearWebLink(): void {
	bridge.stdoutTail = "";
	if (!bridge.rawWebLink && !bridge.webLink) return;
	bridge.rawWebLink = null;
	bridge.webLink = null;
	settleWaiters(null);
	stopPoll();
}

export function extractOsc8Urls(text: string): string[] {
	OSC8_RE.lastIndex = 0;
	return Array.from(text.matchAll(OSC8_RE), match => match[1]).filter((url): url is string => Boolean(url));
}

function scanTextForCollabLink(text: string): void {
	if (!text.includes("\x1b]8;") && !text.includes("Collab stopped") && !text.includes("Collab ended:")) {
		return;
	}
	for (const url of extractOsc8Urls(text)) noteWebLink(url);
	if (/\bCollab stopped\b/.test(text) || /\bCollab ended:/.test(text)) {
		clearWebLink();
	}
}

function installStdoutCapture(): void {
	if (bridge.stdoutPatched) return;
	bridge.stdoutPatched = true;
	for (const output of [process.stdout, process.stderr]) {
		const originalWrite = output.write.bind(output) as (
			chunk: string | Uint8Array,
			...args: unknown[]
		) => boolean;
		output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
			try {
				const text =
					typeof chunk === "string"
						? chunk
						: chunk instanceof Uint8Array
							? Buffer.from(chunk).toString("utf8")
							: "";
				if (text) {
					const combined = bridge.stdoutTail + text;
					scanTextForCollabLink(combined);
					bridge.stdoutTail = combined.slice(-2048);
				}
			} catch {
				// Never break TUI writes.
			}
			return originalWrite(chunk, ...args);
		}) as typeof output.write;
	}
}

type TtyWriterModule = {
	TtyWriter?: { prototype: { write(chunk: string | Uint8Array): number } };
};

// Compiled OMP 18 renders through the pi-natives TtyWriter pump, bypassing
// process.stdout.write; requiring the same .node file yields the live class.
function installTtyPumpCapture(): void {
	if (bridge.pumpPatched) return;
	bridge.pumpPatched = true;
	const home = process.env.HOME;
	if (!home) return;
	const nativesRoot = path.join(home, ".omp/natives");
	let versions: string[];
	try {
		versions = readdirSync(nativesRoot);
	} catch {
		return;
	}
	const nodeRequire = createRequire(import.meta.url);
	let pumpTail = "";
	for (const version of versions) {
		let files: string[];
		try {
			files = readdirSync(path.join(nativesRoot, version));
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".node")) continue;
			try {
				const mod = nodeRequire(path.join(nativesRoot, version, file)) as TtyWriterModule;
				const proto = mod.TtyWriter?.prototype;
				if (!proto || typeof proto.write !== "function") continue;
				const originalWrite = proto.write;
				proto.write = function (chunk: string | Uint8Array) {
					try {
						const text =
							typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
						if (text) {
							const combined = pumpTail + text;
							scanTextForCollabLink(combined);
							pumpTail = combined.slice(-2048);
						}
					} catch {
						// Never break TUI writes.
					}
					return originalWrite.call(this, chunk);
				};
			} catch {
				// Not the natives module we expected; leave it untouched.
			}
		}
	}
}

async function tryPatchCollabHostPrototype(pkgRoot: string): Promise<boolean> {
	if (bridge.protoPatched) return true;
	const hostPath = path.join(pkgRoot, "src/collab/host.ts");
	if (!existsSync(hostPath)) return false;
	try {
		// Dynamic: path only exists next to a source install; bundled omp inlines a
		// different CollabHost class, so a static import would be wrong or missing.
		const mod = (await import(pathToFileURL(hostPath).href)) as { CollabHost?: CollabHostCtor };
		const Ctor = mod.CollabHost;
		if (!Ctor?.prototype?.start || !Ctor.prototype.stop) return false;

		const origStart = Ctor.prototype.start;
		const origStop = Ctor.prototype.stop;

		Ctor.prototype.start = async function startPatched(this: CollabHostLike, relayUrl: string, webUrl?: string) {
			await origStart.call(this, relayUrl, webUrl);
			try {
				const link = this.webLink;
				if (typeof link === "string" && link.length > 0) noteWebLink(link);
			} catch {
				// ignore
			}
		};

		Ctor.prototype.stop = async function stopPatched(this: CollabHostLike, reason: string) {
			try {
				await origStop.call(this, reason);
			} finally {
				clearWebLink();
			}
		};

		bridge.protoPatched = true;
		return true;
	} catch {
		return false;
	}
}


const QR_BUNDLE_PATCH_MARKER = "omp-sessions-share:no-collab-qr";

/** Patch the bundled CLI used by global OMP launchers; takes effect on the next process. */
export function disableBundledCollabQrCode(pkgRoot: string): boolean {
	const cliPath = path.join(pkgRoot, "dist/cli.js");
	try {
		const source = readFileSync(cliPath, "utf8");
		if (source.includes(QR_BUNDLE_PATCH_MARKER)) return true;
		const errorAt = source.indexOf("Failed to render collab QR code");
		if (errorAt < 0) return false;
		const windowStart = Math.max(0, errorAt - 500);
		const prefix = source.slice(windowStart, errorAt);
		const calls = [
			...prefix.matchAll(/[A-Za-z_$][\w$]*\.present\(\[new [A-Za-z_$][\w$]*\(1\),new [A-Za-z_$][\w$]*\([^)]+\)\]\)/g),
		];
		if (calls.length !== 1 || calls[0].index === undefined) return false;
		const start = windowStart + calls[0].index;
		const end = start + calls[0][0].length;
		const patched = `${source.slice(0, start)}"${QR_BUNDLE_PATCH_MARKER}"${source.slice(end)}`;
		writeFileSync(cliPath, patched);
		return true;
	} catch {
		return false;
	}
}

/** Disable the native QR transcript component while retaining the link status line. */
export async function disableCollabQrCode(pkgRoot: string): Promise<boolean> {
	const qrPath = path.join(pkgRoot, "src/slash-commands/helpers/collab-qrcode.ts");
	if (!existsSync(qrPath)) return false;
	try {
		// Runtime-selected package root; a static import would bind this plugin's dependency copy.
		const mod = (await import(pathToFileURL(qrPath).href)) as { CollabQrCodeComponent?: CollabQrCodeCtor };
		const Ctor = mod.CollabQrCodeComponent;
		if (!Ctor?.prototype?.render) return false;
		Ctor.prototype.render = () => [];
		return true;
	} catch {
		return false;
	}
}

async function installCollabBridge(): Promise<{ ok: boolean; reason?: string }> {
	const pkgRoot = findCodingAgentRoot();
	const version = readPackageVersion(pkgRoot);
	bridge.version = version;
	// Native /collab output capture is version-agnostic. Prototype and QR
	// patches validate their target shapes and safely fall back when they differ.
	bridge.versionOk = versionCompatible(version);
	installStdoutCapture();
	installTtyPumpCapture();

	if (pkgRoot) {
		enableCollabGuestTitleGeneration(pkgRoot);
		disableBundledCollabQrCode(pkgRoot);
		await disableCollabQrCode(pkgRoot);
		await tryPatchCollabHostPrototype(pkgRoot);
	}
	// Bundle path relies on OSC-8 capture after native /collab prints the deep link.
	return { ok: true };
}

function waitForWebLink(timeoutMs: number, ctx: ExtensionContext): Promise<string | null> {
	if (bridge.webLink) return Promise.resolve(bridge.webLink);
	const { promise, resolve } = Promise.withResolvers<string | null>();
	const timer = ctx.setTimeout(() => {
		const idx = bridge.waiters.indexOf(onLink);
		if (idx >= 0) bridge.waiters.splice(idx, 1);
		resolve(bridge.webLink);
	}, timeoutMs);
	const onLink = (link: string | null) => {
		ctx.clearTimer(timer);
		resolve(link);
	};
	bridge.waiters.push(onLink);
	return promise;
}

function injectEnter(): boolean {
	try {
		if (!process.stdin.isTTY) return false;
		process.stdin.emit("data", "\r");
		return true;
	} catch {
		return false;
	}
}

// ---- HTTP host client ----

async function hostApi<T>(pathSuffix: string, init?: RequestInit): Promise<HostApiResult<T>> {
	const config = await getShareConfig();
	if (!config?.localOrigin || !config.hostToken) {
		return { ok: false, error: "Share runtime not configured" };
	}
	const base = config.localOrigin.replace(/\/+$/, "");
	try {
		const res = await fetch(`${base}${pathSuffix}`, {
			...init,
			headers: {
				authorization: `Bearer ${config.hostToken}`,
				accept: "application/json",
				...(init?.body ? { "content-type": "application/json" } : {}),
				...(init?.headers ?? {}),
			},
		});
		const body = (await res.json().catch(() => null)) as ApiOk<T> | ApiErr | null;
		if (!res.ok) {
			const msg =
				body && typeof body === "object" && "error" in body && typeof body.error === "string"
					? body.error
					: `HTTP ${res.status}`;
			return { ok: false, error: msg };
		}
		if (!body || typeof body !== "object" || !("data" in body)) {
			return { ok: false, error: "Invalid response shape" };
		}
		return { ok: true, data: (body as ApiOk<T>).data };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ---- session runtime ----

function sessionTitleOf(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionName()?.trim() || "untitled";
}


/** Exact session jsonl from OMP when present; never derived from cwd or logged. */
export function sessionFileOf(ctx: ExtensionContext): string | undefined {
	const manager = ctx.sessionManager as {
		getSessionFile?: () => unknown;
	};
	const raw = manager.getSessionFile?.();
	if (typeof raw !== "string") return undefined;
	const exact = raw.trim();
	return exact.length > 0 ? exact : undefined;
}

function notifyError(ctx: ExtensionContext, message: string): void {
	const now = Date.now();
	if (runtime && now - runtime.lastErrorAt < 4000) return;
	if (runtime) runtime.lastErrorAt = now;
	try {
		ctx.ui.notify(message, "error");
	} catch {
		// never crash OMP
	}
}

function notifyInfo(ctx: ExtensionContext, message: string): void {
	try {
		ctx.ui.notify(message, "info");
	} catch {
		// ignore
	}
}

function stopPoll(): void {
	if (!runtime?.pollTimer) return;
	try {
		runtime.ctx.clearTimer(runtime.pollTimer);
	} catch {
		// ignore
	}
	runtime.pollTimer = undefined;
}

function clearRuntime(): void {
	stopPoll();
	runtime = null;
}

function ensureRuntime(ctx: ExtensionContext): SessionRuntime {
	const sessionId = ctx.sessionManager.getSessionId();
	const sessionFile = sessionFileOf(ctx);
	if (runtime && runtime.sessionId === sessionId) {
		runtime.ctx = ctx;
		runtime.cwd = ctx.cwd;
		runtime.title = sessionTitleOf(ctx);
		if (sessionFile !== undefined) runtime.sessionFile = sessionFile;
		else delete runtime.sessionFile;
		return runtime;
	}
	stopPoll();
	runtime = {
		sessionId,
		startedAt: new Date().toISOString(),
		cwd: ctx.cwd,
		origin: sessionOriginFromEnv(),
		title: sessionTitleOf(ctx),
		...(sessionFile !== undefined ? { sessionFile } : {}),
		ctx,
		prompted: new Set(),
		busy: new Set(),
		collabStartAttempted: false,
		shareStopped: true,
		lastErrorAt: 0,
		polling: false,
		lastHeartbeatAt: 0,
	};
	return runtime;
}

function startPollLoop(rt: SessionRuntime): void {
	if (rt.pollTimer) return;
	if (rt.shareStopped) return;
	if (!bridge.webLink) return;
	void pollOnce(rt);
	rt.pollTimer = rt.ctx.setInterval(() => {
		void pollOnce(rt);
	}, JOIN_REQUEST_POLL_MS);
}

async function sendSessionHeartbeat(rt: SessionRuntime): Promise<HostApiResult<unknown>> {
	const sentAt = Date.now();
	const heartbeat = await hostApi<unknown>("/api/host/sessions", {
		method: "POST",
		body: JSON.stringify({
			id: rt.sessionId,
			title: rt.title,
			cwd: rt.cwd,
			startedAt: rt.startedAt,
			origin: rt.origin,
			pid: process.pid,
			...(rt.sessionFile !== undefined ? { sessionFile: rt.sessionFile } : {}),
		} satisfies SessionHeartbeat),
	});
	if (heartbeat.ok) rt.lastHeartbeatAt = sentAt;
	return heartbeat;
}

async function pollOnce(rt: SessionRuntime): Promise<void> {
	if (rt.shareStopped || !bridge.webLink || rt.polling) return;
	if (rt.sessionId !== rt.ctx.sessionManager.getSessionId()) return;
	rt.polling = true;
	try {
		rt.title = sessionTitleOf(rt.ctx);
		rt.cwd = rt.ctx.cwd;
		const sessionFile = sessionFileOf(rt.ctx);
		if (sessionFile !== undefined) rt.sessionFile = sessionFile;
		else delete rt.sessionFile;
		if (Date.now() - rt.lastHeartbeatAt >= 5_000) {
			const heartbeat = await sendSessionHeartbeat(rt);
			if (!heartbeat.ok) notifyError(rt.ctx, `Share heartbeat failed: ${heartbeat.error}`);
		}

		const pending = await hostApi<JoinRequest[]>(
			`/api/host/requests?sessionId=${encodeURIComponent(rt.sessionId)}`,
		);
		if (!pending.ok) {
			notifyError(rt.ctx, `Share poll failed: ${pending.error}`);
			return;
		}
		if (rt.busy.size > 0) return;
		const requests = Array.isArray(pending.data) ? pending.data : [];
		for (const req of requests) {
			if (req.sessionId !== rt.sessionId || req.status !== "pending") continue;
			if (rt.prompted.has(req.id)) continue;
			rt.prompted.add(req.id);
			rt.busy.add(req.id);
			void handleJoinRequest(rt, req).finally(() => rt.busy.delete(req.id));
			break;
		}
	} finally {
		rt.polling = false;
	}
}

async function postDecision(
	requestId: string,
	body: {
		sessionId: string;
		status: "approved" | "denied";
		encryptedLink?: EncryptedLink;
	},
): Promise<string | null> {
	const result = await hostApi<unknown>(`/api/host/requests/${encodeURIComponent(requestId)}`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	return result.ok ? null : result.error;
}

async function handleJoinRequest(rt: SessionRuntime, req: JoinRequest): Promise<void> {
	const webLink = bridge.webLink;
	if (!webLink) {
		await postDecision(req.id, { sessionId: rt.sessionId, status: "denied" });
		return;
	}
	try {
		const ciphertext = await encryptWithPublicJwk(webLink, req.publicKeyJwk);
		const encryptedLink: EncryptedLink = { algorithm: "RSA-OAEP-256", ciphertext };
		const error = await postDecision(req.id, {
			sessionId: rt.sessionId,
			status: "approved",
			encryptedLink,
		});
		if (error) notifyError(rt.ctx, `Share delivery failed: ${error}`);
		else notifyInfo(rt.ctx, `Shared session with ${req.deviceName}`);
	} catch (err) {
		notifyError(rt.ctx, `Share encrypt failed: ${err instanceof Error ? err.message : String(err)}`);
		const denyError = await postDecision(req.id, {
			sessionId: rt.sessionId,
			status: "denied",
		});
		if (denyError) notifyError(rt.ctx, `Share deny-after-encrypt-fail failed: ${denyError}`);
	}
}

type EditorTextApi = Pick<ExtensionContext["ui"], "getEditorText" | "setEditorText">;

// OMP 18 drops keys until TUI init finishes wiring dispatch; dropped Enters
// never resurface, so rounds re-submit with the command left in the editor.
/** Submit an internal command without consuming a resumed session's editor prefill. */
export async function submitEditorCommandPreservingDraft(
	ui: EditorTextApi,
	command: string,
	submit: () => boolean,
	waitForDispatch: () => Promise<void>,
	rounds = SUBMIT_ROUNDS,
	pollsPerRound = SUBMIT_POLLS_PER_ROUND,
): Promise<boolean> {
	let draft: string;
	try {
		draft = ui.getEditorText() ?? "";
	} catch {
		return false;
	}

	for (let round = 0; round < rounds; round++) {
		try {
			ui.setEditorText(command);
		} catch {
			break;
		}
		let submitted = false;
		try {
			submitted = submit();
		} catch {
			// Restore the draft below.
		}
		if (!submitted) break;

		// stdin dispatch is asynchronous. Wait until the editor consumed the
		// command before restoring the prefill, or Enter submits the prefill itself.
		for (let attempt = 0; attempt < pollsPerRound; attempt++) {
			await waitForDispatch();
			let current: string;
			try {
				current = ui.getEditorText() ?? "";
			} catch {
				return false;
			}
			if (current === draft) return true;
			if (current !== "" && current !== command) return false;
			if (current === "") {
				try {
					ui.setEditorText(draft);
					return true;
				} catch {
					return false;
				}
			}
		}
	}

	try {
		ui.setEditorText(draft);
	} catch {
		// ignore
	}
	return false;
}

let triggerInFlight: Promise<boolean> | null = null;

async function tryTriggerNativeCollab(rt: SessionRuntime): Promise<boolean> {
	if (bridge.rawWebLink || bridge.webLink) return true;
	if (!rt.ctx.hasUI) return false;

	triggerInFlight ??= (async () => {
		for (const rounds of [SUBMIT_ROUNDS, SUBMIT_RETRY_ROUNDS]) {
			const submitted = await submitEditorCommandPreservingDraft(
				rt.ctx.ui,
				NATIVE_COLLAB_COMMAND,
				injectEnter,
				() =>
					new Promise<void>(resolve => {
						rt.ctx.setTimeout(() => resolve(), 10);
					}),
				rounds,
			);
			// A cleared editor can also be TUI init resetting it; the link is
			// the only reliable signal, so re-submit once before giving up.
			if (submitted && (await waitForWebLink(12_000, rt.ctx))) return true;
			if (bridge.rawWebLink || bridge.webLink) return true;
		}
		return Boolean(bridge.rawWebLink || bridge.webLink);
	})().finally(() => {
		triggerInFlight = null;
	});
	return triggerInFlight;
}

async function isConfiguredDaemonReachable(config: ShareConfig): Promise<boolean> {
	const base = config.localOrigin.replace(/\/+$/, "");
	try {
		const res = await fetch(`${base}/healthz`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(1_500),
		});
		if (!res.ok) return false;
		const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
		return body?.ok === true;
	} catch {
		return false;
	}
}

/** Connect collab + heartbeats only when the configured local daemon is already up. */
async function startShare(rt: SessionRuntime): Promise<void> {
	rt.shareStopped = false;

	const config = await getShareConfig();
	if (runtime !== rt || rt.shareStopped) return;
	if (!config) {
		notifyInfo(rt.ctx, "Sessions share is not configured. Run: oss setup");
		rt.shareStopped = true;
		return;
	}
	const reachable = await isConfiguredDaemonReachable(config);
	if (runtime !== rt || rt.shareStopped) return;
	if (!reachable) {
		notifyInfo(rt.ctx, "Sessions share daemon is not running. Start it with: oss start");
		rt.shareStopped = true;
		return;
	}

	// Register as soon as OMP is ready; native collab setup can take seconds.
	const heartbeat = await sendSessionHeartbeat(rt);
	if (runtime !== rt || rt.shareStopped) return;
	if (!heartbeat.ok) notifyError(rt.ctx, `Share heartbeat failed: ${heartbeat.error}`);

	const installed = await installCollabBridge();
	if (!installed.ok) {
		notifyError(rt.ctx, `Share: ${installed.reason ?? "collab bridge unavailable"}`);
		rt.shareStopped = true;
		return;
	}
	if (runtime !== rt || rt.shareStopped) return;
	if (bridge.webLink) {
		startPollLoop(rt);
		notifyInfo(rt.ctx, `Share dashboard connected\n  URL: ${config.publicOrigin}`);
		return;
	}

	const started = await tryTriggerNativeCollab(rt);
	if (runtime !== rt || rt.shareStopped) return;
	if (!started || !bridge.webLink) {
		notifyError(rt.ctx, "Share: failed to start native /collab");
		rt.shareStopped = true;
		return;
	}
	startPollLoop(rt);
	notifyInfo(rt.ctx, `Share dashboard connected\n  URL: ${config.publicOrigin}`);
}

type StartDashboardShare = (rt: SessionRuntime) => Promise<void>;

export async function onSessionReady(
	ctx: ExtensionContext,
	startDashboardShare: StartDashboardShare = startShare,
): Promise<void> {
	if (!ctx.hasUI) return;
	const rt = ensureRuntime(ctx);
	if (rt.collabStartAttempted) return;
	rt.collabStartAttempted = true;

	// Every interactive host session joins the running dashboard when available.
	// startShare never launches the daemon; it only starts native /collab + heartbeats.
	await startDashboardShare(rt);
}

function isCollabCommand(text: string): boolean {
	return /^\/collab(?:\s+start)?\s*$/i.test(text.trim());
}


/** OpenAI rejects replayed reasoning items whose `content` array is non-empty. */
export function sanitizeOpenRouterResponsesPayload(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
	const record = payload as Record<string, unknown>;
	if (!Array.isArray(record.input)) return payload;

	let changed = false;
	const input = record.input.map(item => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
		const inputItem = item as Record<string, unknown>;
		if (inputItem.type !== "reasoning" || !Object.hasOwn(inputItem, "content")) return item;
		const replayable = { ...inputItem };
		delete replayable.content;
		changed = true;
		return replayable;
	});
	return changed ? { ...record, input } : payload;
}

export default function ompSessionsShareExtension(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openrouter" || ctx.model.api !== "openai-responses") return;
		return sanitizeOpenRouterResponsesPayload(event.payload);
	});

	pi.on("session_start", (_event, ctx) => onSessionReady(ctx));

	pi.on("session_switch", (_event, ctx) => {
		clearWebLink();
		clearRuntime();
		return onSessionReady(ctx);
	});

	pi.on("session_shutdown", () => {
		clearRuntime();
		bridge.rawWebLink = null;
		bridge.webLink = null;
		settleWaiters(null);
	});

	pi.on("input", (event, ctx) => {
		const text = event.text ?? "";
		if (isCollabCommand(text) && bridge.webLink) {
			notifyInfo(ctx, bridge.webLink);
			return { handled: true };
		}
	});
}
