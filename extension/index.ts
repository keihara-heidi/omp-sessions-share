/**
 * OMP sessions-share host extension.
 *
 * Docs (omp 17.2.x):
 * - docs/collab.md: native `/collab` owns AES-GCM room + browser deep link; link possession is trust boundary.
 * - ExtensionContext has no collab/start-builtin API; no documented builtin execution API.
 * - TUI emits `input` before builtin slash dispatch → `/share` can be owned here (core reserves the name).
 * - Managed timers required for background work.
 *
 * Compatibility bridge (isolated, version-checked): capture native collab `webLink` without reimplementing collab.
 * Bundled `omp` inlines CollabHost (minified); source installs keep a separate module. We therefore:
 *   1) best-effort patch CollabHost.prototype when the live class is importable
 *   2) capture browser deep links from OSC-8 sequences that `/collab` prints via showStatus
 * Never log tokens, key material, ciphertext, or collab links.
 *
 * Local runtime: heartbeats hit loopback daemon with Bearer host token. Native host always uses
 * ws://127.0.0.1:7466; password-gated guest links wrap config.publicOrigin via https://my.omp.sh/#…
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";
import { loadShareConfig, type ShareConfig } from "../shared/config";
import { setupLocalRuntime } from "../setup/install";
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

type SessionHeartbeat = {
	id: string;
	title: string;
	cwd: string;
	startedAt: string;
};

type ApiOk<T> = { data: T };
type ApiErr = { error: string };

type HostApiResult<T> = { ok: true; data: T } | { ok: false; error: string };
type UserMessageContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];

type CollabHostLike = {
	readonly webLink: string;
	start(relayUrl: string, webUrl?: string): Promise<void>;
	stop(reason: string): Promise<void>;
};

type CollabHostCtor = {
	prototype: CollabHostLike;
	new (...args: never[]): CollabHostLike;
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
	stdoutTail: string;
	protoPatched: boolean;
};

type SessionRuntime = {
	sessionId: string;
	startedAt: string;
	cwd: string;
	title: string;
	ctx: ExtensionContext;
	api: ExtensionAPI;
	pollTimer?: Timer;
	polling: boolean;
	lastHeartbeatAt: number;
	prompted: Set<string>;
	busy: Set<string>;
	inputFallbackArmed: boolean;
	autoStartAttempted: boolean;
	pendingUserContent: UserMessageContent | null;
	lastErrorAt: number;
};

const BRIDGE_MAJOR = 17;
const BRIDGE_MINOR = 2;
const OSC8_RE = /\x1b\]8;;(https?:\/\/[^\x07]+)\x07/g;
const COLLAB_FRAGMENT_RE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{64}$/;
const PUBLIC_COLLAB_WEB_ORIGIN = "https://my.omp.sh";
const NATIVE_COLLAB_WS = "ws://127.0.0.1:7466";
const NATIVE_COLLAB_COMMAND = `/collab ${NATIVE_COLLAB_WS}`;
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
	stdoutTail: "",
	protoPatched: false,
};

let runtime: SessionRuntime | null = null;
/** undefined = not loaded yet; null = missing/invalid. */
let cachedConfig: ShareConfig | null | undefined;
let setupPrompted = false;

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
	if (!runtime) return;
	startPollLoop(runtime);
	notifyInfo(
		runtime.ctx,
		`Sessions share (tailnet)\n  URL: ${config.publicOrigin}\n  Password: ${config.dashboardPassword}`,
	);
	void showDashboardQr(runtime.ctx, config.publicOrigin);
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

function versionCompatible(version: string | null): boolean {
	if (!version) return false;
	const m = /^(\d+)\.(\d+)\./.exec(version);
	if (!m) return false;
	return Number(m[1]) === BRIDGE_MAJOR && Number(m[2]) === BRIDGE_MINOR;
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

	try {
		const require = createRequire(import.meta.url);
		const pkgJson = require.resolve("@oh-my-pi/pi-coding-agent/package.json");
		candidates.push(path.dirname(pkgJson));
	} catch {
		// not resolvable from extension path
	}

	for (const root of candidates) {
		if (existsSync(path.join(root, "package.json"))) return root;
	}
	return null;
}

async function showDashboardQr(ctx: ExtensionContext, url: string): Promise<void> {
	const packageRoot = findCodingAgentRoot();
	if (!packageRoot) return;
	try {
		const modulePath = path.join(
			packageRoot,
			"src/slash-commands/helpers/collab-qrcode.ts",
		);
		// Runtime-selected source path: OMP does not export this internal helper and host install roots differ.
		const qrModule = (await import(pathToFileURL(modulePath).href)) as {
			CollabQrCodeComponent?: new (url: string) => Component;
		};
		const QrCode = qrModule.CollabQrCodeComponent;
		if (!QrCode) return;
		ctx.ui.setWidget("omp-sessions-share-qr", () => new QrCode(url), {
			placement: "aboveEditor",
		});
	} catch {
		// The URL and password notification remains usable without QR rendering.
	}
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

function scanTextForCollabLink(text: string): void {
	if (!text.includes("\x1b]8;;") && !text.includes("Collab stopped") && !text.includes("Collab ended:")) {
		return;
	}
	OSC8_RE.lastIndex = 0;
	for (const match of text.matchAll(OSC8_RE)) {
		if (match[1]) noteWebLink(match[1]);
	}
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

async function installCollabBridge(): Promise<{ ok: boolean; reason?: string }> {
	const pkgRoot = findCodingAgentRoot();
	const version = readPackageVersion(pkgRoot);
	bridge.version = version;
	bridge.versionOk = versionCompatible(version);

	if (!bridge.versionOk) {
		bridge.reason = `Share bridge requires @oh-my-pi/pi-coding-agent ${BRIDGE_MAJOR}.${BRIDGE_MINOR}.x (found ${version ?? "unknown"})`;
		installStdoutCapture();
		return { ok: false, reason: bridge.reason };
	}

	installStdoutCapture();
	if (pkgRoot) await tryPatchCollabHostPrototype(pkgRoot);
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

/** Prefer Shared Context worktree path when present; fall back to session cwd. */
function sessionCwdOf(ctx: ExtensionContext): string {
	const worktree = process.env.SUPERCONDUCTOR_WORKTREE_PATH?.trim();
	return worktree || ctx.cwd;
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

function ensureRuntime(ctx: ExtensionContext, api: ExtensionAPI): SessionRuntime {
	const sessionId = ctx.sessionManager.getSessionId();
	if (runtime && runtime.sessionId === sessionId) {
		runtime.ctx = ctx;
		runtime.api = api;
		runtime.cwd = sessionCwdOf(ctx);
		runtime.title = sessionTitleOf(ctx);
		return runtime;
	}
	stopPoll();
	runtime = {
		sessionId,
		startedAt: new Date().toISOString(),
		cwd: sessionCwdOf(ctx),
		title: sessionTitleOf(ctx),
		ctx,
		api,
		prompted: new Set(),
		busy: new Set(),
		inputFallbackArmed: false,
		autoStartAttempted: false,
		pendingUserContent: null,
		lastErrorAt: 0,
		polling: false,
		lastHeartbeatAt: 0,
	};
	return runtime;
}

function startPollLoop(rt: SessionRuntime): void {
	if (rt.pollTimer) return;
	if (!bridge.webLink) return;
	void pollOnce(rt);
	rt.pollTimer = rt.ctx.setInterval(() => {
		void pollOnce(rt);
	}, 250);
}

async function pollOnce(rt: SessionRuntime): Promise<void> {
	if (!bridge.webLink || rt.polling) return;
	if (rt.sessionId !== rt.ctx.sessionManager.getSessionId()) return;
	rt.polling = true;
	try {
		rt.title = sessionTitleOf(rt.ctx);
		rt.cwd = sessionCwdOf(rt.ctx);
		const now = Date.now();
		if (now - rt.lastHeartbeatAt >= 5_000) {
			const heartbeat = await hostApi<unknown>("/api/host/sessions", {
				method: "POST",
				body: JSON.stringify({
					id: rt.sessionId,
					title: rt.title,
					cwd: rt.cwd,
					startedAt: rt.startedAt,
				} satisfies SessionHeartbeat),
			});
			if (!heartbeat.ok) notifyError(rt.ctx, `Share heartbeat failed: ${heartbeat.error}`);
			else rt.lastHeartbeatAt = now;
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

function flushPendingUserText(rt: SessionRuntime): void {
	const content = rt.pendingUserContent;
	rt.pendingUserContent = null;
	if (content === null) return;
	if (typeof content === "string" && !content.trim()) return;
	if (Array.isArray(content) && content.length === 0) return;
	try {
		rt.api.sendUserMessage(content);
	} catch (err) {
		notifyError(rt.ctx, `Share re-queue input failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

type EditorTextApi = Pick<ExtensionContext["ui"], "getEditorText" | "setEditorText">;

/** Submit an internal command without consuming a resumed session's editor prefill. */
export async function submitEditorCommandPreservingDraft(
	ui: EditorTextApi,
	command: string,
	submit: () => boolean,
	waitForDispatch: () => Promise<void>,
): Promise<boolean> {
	let draft: string;
	try {
		draft = ui.getEditorText() ?? "";
		ui.setEditorText(command);
	} catch {
		return false;
	}

	let submitted = false;
	try {
		submitted = submit();
	} catch {
		// Restore the draft below.
	}
	if (!submitted) {
		try {
			ui.setEditorText(draft);
		} catch {
			// ignore
		}
		return false;
	}

	// stdin dispatch is asynchronous. Wait until the editor consumed the
	// command before restoring the prefill, or Enter submits the prefill itself.
	for (let attempt = 0; attempt < 20; attempt++) {
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

	try {
		ui.setEditorText(draft);
	} catch {
		// ignore
	}
	return false;
}

async function tryTriggerNativeCollab(rt: SessionRuntime): Promise<boolean> {
	if (bridge.webLink) return true;
	if (!rt.ctx.hasUI) return false;

	const submitted = await submitEditorCommandPreservingDraft(
		rt.ctx.ui,
		NATIVE_COLLAB_COMMAND,
		injectEnter,
		() =>
			new Promise<void>(resolve => {
				rt.ctx.setTimeout(() => resolve(), 10);
			}),
	);
	if (!submitted) return false;

	const link = await waitForWebLink(12_000, rt.ctx);
	return Boolean(link);
}

async function offerFirstRunSetup(ctx: ExtensionContext): Promise<ShareConfig | null> {
	if (setupPrompted) return null;
	setupPrompted = true;
	if (!ctx.hasUI) return null;

	let accepted = false;
	try {
		accepted = await ctx.ui.confirm(
			"Set up sessions share?",
			"omp-sessions-share is installed but not configured.\nRun local setup now? (generates secrets, installs daemon + Tailscale Serve)",
		);
	} catch {
		return null;
	}
	if (!accepted) {
		notifyInfo(ctx, "Share setup skipped. Restart OMP later to configure sessions share.");
		return null;
	}

	try {
		const config = await setupLocalRuntime();
		cachedConfig = config;
		applyConfigToBridge(config);
		notifyInfo(
			ctx,
			"Share setup complete. Restart OMP or open a new shell so the daemon and PATH take effect, then start a new session.",
		);
		return config;
	} catch (err) {
		notifyError(ctx, `Share setup failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

async function onSessionReady(ctx: ExtensionContext, api: ExtensionAPI): Promise<void> {
	if (!ctx.hasUI) return;

	const rt = ensureRuntime(ctx, api);
	if (rt.autoStartAttempted) {
		if (bridge.webLink) startPollLoop(rt);
		return;
	}
	rt.autoStartAttempted = true;

	const installed = await installCollabBridge();
	if (!installed.ok) {
		notifyError(ctx, `Share: ${installed.reason ?? "collab bridge unavailable"}`);
		rt.inputFallbackArmed = true;
		return;
	}

	const config = await getShareConfig();
	if (!config) {
		const setupConfig = await offerFirstRunSetup(ctx);
		// Fresh setup needs restart/new shell before daemon/PATH are guaranteed.
		if (setupConfig) return;
		return;
	}

	const { promise: delayDone, resolve: resolveDelay } = Promise.withResolvers<void>();
	ctx.setTimeout(() => resolveDelay(), 75);
	await delayDone;

	const live = ensureRuntime(ctx, api);
	if (bridge.webLink) {
		startPollLoop(live);
		return;
	}

	const started = await tryTriggerNativeCollab(live);
	if (started && bridge.webLink) {
		startPollLoop(live);
		flushPendingUserText(live);
		return;
	}

	live.inputFallbackArmed = true;
}

function isShareCommand(text: string): boolean {
	return /^\/share(?:\s|$)/i.test(text.trim());
}

function isCollabCommand(text: string): boolean {
	return /^\/collab(?:\s+start)?\s*$/i.test(text.trim());
}

export default function ompSessionsShareExtension(pi: ExtensionAPI): void {
	// Install capture early so a manual `/collab` before delayed auto-start is still observed.
	void installCollabBridge();

	pi.on("session_start", (_event, ctx) => {
		void onSessionReady(ctx, pi);
	});

	pi.on("session_switch", (_event, ctx) => {
		clearWebLink();
		clearRuntime();
		void onSessionReady(ctx, pi);
	});

	pi.on("session_shutdown", () => {
		runtime = null;
		bridge.rawWebLink = null;
		bridge.webLink = null;
		settleWaiters(null);
	});

	pi.on("input", (event, ctx) => {
		const text = event.text ?? "";
		ctx.ui.setWidget("omp-sessions-share-qr", undefined);

		if (isShareCommand(text)) {
			void getShareConfig().then(config => {
				if (config?.publicOrigin && config.dashboardPassword) {
					notifyInfo(
						ctx,
						`Sessions share\n  URL: ${config.publicOrigin}\n  Password: ${config.dashboardPassword}`,
					);
					void showDashboardQr(ctx, config.publicOrigin);
				} else {
					notifyError(
						ctx,
						"Share: not configured. Confirm setup on session start, then restart OMP.",
					);
				}
			});
			return { handled: true };
		}

		const rt = runtime && runtime.sessionId === ctx.sessionManager.getSessionId() ? runtime : null;
		if (isCollabCommand(text)) {
			if (cachedConfig === null) {
				notifyError(ctx, "Share: not configured");
				return { handled: true };
			}
			void waitForWebLink(15_000, ctx).then(link => {
				if (!link || !runtime) return;
				startPollLoop(runtime);
				flushPendingUserText(runtime);
			});
			return { text: NATIVE_COLLAB_COMMAND };
		}

		if (!rt?.inputFallbackArmed || event.source !== "interactive") return;
		if (bridge.webLink) {
			rt.inputFallbackArmed = false;
			startPollLoop(rt);
			return;
		}

		if (cachedConfig === null) {
			rt.inputFallbackArmed = false;
			notifyError(ctx, "Share: not configured");
			return;
		}
		rt.inputFallbackArmed = false;
		rt.pendingUserContent = event.images?.length
			? [...(text ? [{ type: "text" as const, text }] : []), ...event.images]
			: text;
		void waitForWebLink(15_000, ctx).then(link => {
			if (!runtime) return;
			if (link) {
				startPollLoop(runtime);
				flushPendingUserText(runtime);
			} else {
				notifyError(runtime.ctx, "Share: failed to start native /collab");
				flushPendingUserText(runtime);
			}
		});
		return { text: NATIVE_COLLAB_COMMAND, images: [] };
	});
}
