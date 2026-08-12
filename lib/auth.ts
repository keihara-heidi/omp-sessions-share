import { isValidId } from "./contracts";

export const DASHBOARD_COOKIE_NAME = "ompi_share_session";

const encoder = new TextEncoder();

export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function base64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw = "";
  for (const byte of value) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array | null {
  if (!isValidId(value)) return null;
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  try {
    const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function signature(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64urlEncode(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
}

type CookiePayload = { v: 1; exp: number };

export async function signSessionCookie(
  maxAgeSeconds: number,
  secret: string,
): Promise<string> {
  if (!secret) throw new Error("missing cookie secret");
  const payload: CookiePayload = {
    v: 1,
    exp: Math.floor(Date.now() / 1000) + maxAgeSeconds,
  };
  const encoded = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await signature(secret, encoded)}`;
}

export async function verifySessionCookie(
  value: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!value || !secret) return false;
  const [payload, supplied, extra] = value.split(".");
  if (!payload || !supplied || extra !== undefined) return false;
  if (!timingSafeEqual(supplied, await signature(secret, payload))) return false;
  const bytes = base64urlDecode(payload);
  if (!bytes) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<CookiePayload>;
    return (
      parsed.v === 1 &&
      typeof parsed.exp === "number" &&
      Number.isFinite(parsed.exp) &&
      parsed.exp >= Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}

export function createSessionCookie(
  value: string,
  options: { maxAge: number; secure: boolean },
): string {
  const parts = [
    `${DASHBOARD_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${options.maxAge}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(options: { secure: boolean }): string {
  const parts = [
    `${DASHBOARD_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(
  header: string | null | undefined,
  name: string,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

export type AuthOk = { ok: true };
