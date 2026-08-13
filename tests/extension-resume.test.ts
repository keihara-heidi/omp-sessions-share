import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  disableBundledCollabQrCode,
  disableCollabQrCode,
  sanitizeOpenRouterResponsesPayload,
  submitEditorCommandPreservingDraft,
} from "../extension";

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
