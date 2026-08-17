import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { enableCollabGuestTitleGeneration } from "../setup/install";
import ompSessionsShareExtension, {
  disableBundledCollabQrCode,
  disableCollabQrCode,
  extractOsc8Urls,
  onSessionReady,
  parseShareCommand,
  sanitizeOpenRouterResponsesPayload,
  submitEditorCommandPreservingDraft,
  versionCompatible,
} from "../extension";

test("OMP startup and resume automatically enable dashboard sharing", async () => {
  let shareStarts = 0;
  let sessionId = "started_session";
  const ctx = {
    hasUI: true,
    cwd: "/tmp/collab-startup",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => "Collab startup",
    },
  } as unknown as ExtensionContext;

  await onSessionReady(ctx, async () => {
    shareStarts++;
  });
  await onSessionReady(ctx, async () => {
    shareStarts++;
  });
  expect(shareStarts).toBe(1);

  sessionId = "resumed_session";
  await onSessionReady(ctx, async () => {
    shareStarts++;
  });
  expect(shareStarts).toBe(2);
});

test("session lifecycle waits for automatic sharing startup", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  const ctx = { hasUI: false } as ExtensionContext;

  ompSessionsShareExtension(pi);

  const started = handlers.get("session_start")?.({}, ctx);
  const switched = handlers.get("session_switch")?.({}, ctx);
  expect(started).toBeInstanceOf(Promise);
  expect(switched).toBeInstanceOf(Promise);
  await Promise.all([started, switched]);
});

test("collab bridge accepts OMP versions without a hard-coded gate", () => {
  expect(versionCompatible("16.0.0")).toBe(true);
  expect(versionCompatible("17.2.15")).toBe(true);
  expect(versionCompatible("17.3.5")).toBe(true);
  expect(versionCompatible("18.0.0")).toBe(true);
  expect(versionCompatible(null)).toBe(true);
});

test("share command supports start, stop, and registration", () => {
  expect(parseShareCommand("/share")).toEqual({ action: "start" });
  expect(parseShareCommand("  /SHARE  ")).toEqual({ action: "start" });
  expect(parseShareCommand("/share stop")).toEqual({ action: "stop" });
  expect(parseShareCommand("/SHARE STOP  ")).toEqual({ action: "stop" });
  expect(parseShareCommand("/share register")).toEqual({ action: "register" });
  expect(parseShareCommand("/share register ../Project One")).toEqual({
    action: "register",
    path: "../Project One",
  });
});

test("share command rejects unsupported arguments", () => {
  expect(parseShareCommand("/share start")).toBeNull();
  expect(parseShareCommand("/share stop now")).toBeNull();
  expect(parseShareCommand("/shared")).toBeNull();
});

test("collab capture extracts OSC-8 links with metadata", () => {
  const link =
    "http://127.0.0.1:7466/#ws://127.0.0.1:7466/r/dpBzOexmyixGfX0i7ni7Zw.eG7PT9tK-n4gK6UXYZ_hEV8EU1wkZDu11J7N2Pr0v-CN6GGSnQwVN-Ap3f2OcP8o";
  const output = `\x1b]8;id=8b3e37d1;${link}\x07${link.slice("http://".length)}\x1b]8;;\x07`;

  expect(extractOsc8Urls(output)).toEqual([link]);
});

test("auto-collab preserves a resumed session prefill", async () => {
  let editorText = "continue existing task";
  let submitted = "";
  const ui = {
    getEditorText: () => editorText,
    setEditorText: (text: string) => {
      editorText = text;
    },
  };

  const ok = await submitEditorCommandPreservingDraft(
    ui,
    "/collab ws://127.0.0.1:7466",
    () => {
      submitted = editorText;
      return true;
    },
    async () => {
      editorText = "";
    },
  );

  expect(ok).toBe(true);
  expect(submitted).toBe("/collab ws://127.0.0.1:7466");
  expect(editorText).toBe("continue existing task");
});

test("collab QR component is suppressed", async () => {
  const packageRoot = new URL("../node_modules/@oh-my-pi/pi-coding-agent/", import.meta.url).pathname;
  expect(await disableCollabQrCode(packageRoot)).toBe(true);

  // Intentionally exercises the runtime-loaded upstream module boundary.
  const { CollabQrCodeComponent } = await import(
    "../node_modules/@oh-my-pi/pi-coding-agent/src/slash-commands/helpers/collab-qrcode"
  );
  expect(new CollabQrCodeComponent("https://example.com").render(200)).toEqual([]);
});

test("bundled OMP collab QR component is suppressed", async () => {
  const packageRoot = await mkdtemp(path.join(tmpdir(), "omp-no-collab-qr-"));
  const bundlePath = path.join(packageRoot, "dist", "cli.js");
  const bundle =
    'function ETf(i,n){try{i.present([new g0(1),new C9i(n)])}catch(h){i.showError(`Failed to render collab QR code: ${Hh(h)}`)}}';
  await mkdir(path.dirname(bundlePath));
  await writeFile(bundlePath, bundle);
  try {
    expect(disableBundledCollabQrCode(packageRoot)).toBe(true);
    const patched = await readFile(bundlePath, "utf8");
    expect(patched).toContain("omp-sessions-share:no-collab-qr");
    expect(patched).not.toContain(".present([new g0(1),new C9i(n)])");
    expect(disableBundledCollabQrCode(packageRoot)).toBe(true);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("collab guest prompts start OMP title generation", async () => {
  const packageRoot = await mkdtemp(path.join(tmpdir(), "omp-collab-title-"));
  const hostPath = path.join(packageRoot, "src", "collab", "host.ts");
  const source = [
    "class CollabHost {",
    "\t#handlePrompt(text: string, name: string): void {",
    "\t\tconst details: CollabPromptDetails = { from: name };",
    "\t\tthis.#ctx.session.promptCustomMessage({ details });",
    "\t}",
    "}",
  ].join("\n");
  await mkdir(path.dirname(hostPath), { recursive: true });
  await writeFile(hostPath, source);
  try {
    expect(await enableCollabGuestTitleGeneration(packageRoot)).toBe(true);
    const patched = await readFile(hostPath, "utf8");
    expect(patched).toContain("this.#ctx.session.maybeStartTitleGeneration(text);");
    expect(await enableCollabGuestTitleGeneration(packageRoot)).toBe(true);
    expect((await readFile(hostPath, "utf8")).match(/maybeStartTitleGeneration/g)).toHaveLength(1);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("OpenRouter resume strips unsupported reasoning content", () => {
  const payload = {
    model: "openai/gpt-5.6-sol",
    input: [
      {
        type: "reasoning",
        id: "rs_saved",
        summary: [],
        content: [{ type: "reasoning_text", text: "private prior reasoning" }],
      },
      { role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  };

  expect(sanitizeOpenRouterResponsesPayload(payload)).toEqual({
    ...payload,
    input: [
      { type: "reasoning", id: "rs_saved", summary: [] },
      payload.input[1],
    ],
  });
  expect(payload.input[0]).toHaveProperty("content");
});
