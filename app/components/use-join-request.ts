"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  EncryptedLink,
  JoinRequest,
  JoinRequestResult,
} from "@/lib/contracts";
import { api, ApiError, postJson } from "./api";

const POLL_INTERVAL_MS = 250;
const SESSION_START_ATTEMPTS = 120;
const POLL_DEADLINE_MS = 5 * 60 * 1_000;
const COLLAB_FRAGMENT_RE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{64}$/;
const PUBLIC_COLLAB_WEB_ORIGIN = "https://my.omp.sh";

export type JoinPhase =
  | "preparing"
  | "awaiting"
  | "connecting"
  | "denied"
  | "expired"
  | "error";

function deviceName(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows PC"
            : "Device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "browser";
  return `${device} (${browser})`;
}

function base64urlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * The daemon's configured tailnet origin, fetched at runtime (the dashboard
 * is a static export — nothing is baked in at build time). The endpoint is
 * cookie-authenticated same-origin, so only a logged-in dashboard can read it.
 */
async function fetchRelayOrigin(): Promise<URL> {
  const meta = await api<{ publicOrigin: string }>("/api/meta");
  const origin = new URL(meta.publicOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/") {
    throw new Error("unexpected relay origin");
  }
  return origin;
}

async function decryptLink(
  privateKey: CryptoKey,
  relayOrigin: URL,
  link: EncryptedLink,
): Promise<string> {
  if (link.algorithm !== "RSA-OAEP-256") {
    throw new Error("unexpected algorithm");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    base64urlToBytes(link.ciphertext),
  );
  const url = new URL(new TextDecoder().decode(plaintext));
  const fragment = decodeURIComponent(url.hash.slice(1));
  const relayPrefix = `${relayOrigin.host}/r/`;
  if (
    url.origin !== PUBLIC_COLLAB_WEB_ORIGIN ||
    url.pathname !== "/" ||
    !fragment.startsWith(relayPrefix) ||
    !COLLAB_FRAGMENT_RE.test(fragment.slice(relayPrefix.length))
  ) {
    throw new Error("unexpected collab link");
  }
  return url.href;
}

/**
 * Drives one join request: keypair → create → poll → decrypt → navigate.
 * The non-extractable private CryptoKey lives only in a ref; the decrypted
 * link never touches React state — it goes straight to location.assign.
 */
export function useJoinRequest(sessionId: string) {
  const [phase, setPhase] = useState<JoinPhase>("preparing");
  // Refs, not state: key material and secrets must never enter render data.
  const privateKeyRef = useRef<CryptoKey | null>(null);
  const relayOriginRef = useRef<URL | null>(null);
  const deadlineRef = useRef(0);
  const settledRef = useRef(false);

  const create = useMutation({
    mutationFn: async () => {
      const [keyPair, relayOrigin] = await Promise.all([
        crypto.subtle.generateKey(
          {
            name: "RSA-OAEP",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
          },
          false, // private key non-extractable; never exported or persisted
          ["encrypt", "decrypt"],
        ),
        fetchRelayOrigin(),
      ]);
      privateKeyRef.current = keyPair.privateKey;
      relayOriginRef.current = relayOrigin;
      const publicKeyJwk = await crypto.subtle.exportKey(
        "jwk",
        keyPair.publicKey,
      );
      const path = `/api/sessions/${encodeURIComponent(sessionId)}/requests`;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await api<JoinRequest>(
            path,
            postJson({ deviceName: deviceName(), publicKeyJwk }),
          );
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            error.status !== 425 ||
            attempt + 1 >= SESSION_START_ATTEMPTS
          ) {
            throw error;
          }
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, POLL_INTERVAL_MS);
          await promise;
        }
      }
    },
    onSuccess: () => {
      deadlineRef.current = Date.now() + POLL_DEADLINE_MS;
      setPhase("awaiting");
    },
    onError: (err) => {
      privateKeyRef.current = null;
      setPhase(
        err instanceof ApiError && (err.status === 404 || err.status === 410)
          ? "expired"
          : "error",
      );
    },
  });

  const startedRef = useRef(false);
  const createOnce = create.mutate;
  useEffect(() => {
    // StrictMode re-runs effects; one keypair + one request per dialog open.
    if (startedRef.current) return;
    startedRef.current = true;
    createOnce();
  }, [createOnce]);

  // Unmount = user bailed: drop the only reference to the private key.
  useEffect(
    () => () => {
      privateKeyRef.current = null;
    },
    [],
  );

  const requestId = create.data?.id;
  const poll = useQuery({
    queryKey: ["join-request", requestId],
    enabled: requestId !== undefined && phase === "awaiting",
    gcTime: 0,
    queryFn: async (): Promise<JoinRequestResult> => {
      try {
        return await api<JoinRequestResult>(
          `/api/requests/${encodeURIComponent(requestId!)}`,
        );
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.status === 404 || err.status === 410)
        ) {
          return { ...create.data!, status: "expired" };
        }
        throw err; // transient failure — react-query retries/refetches
      }
    },
    refetchInterval: POLL_INTERVAL_MS,
    retry: true,
  });

  // Hard stop if the encrypted session link is not delivered within the window.
  useEffect(() => {
    if (phase !== "awaiting") return;
    const timer = setTimeout(() => {
      if (settledRef.current) return;
      settledRef.current = true;
      privateKeyRef.current = null;
      setPhase("expired");
    }, deadlineRef.current - Date.now());
    return () => clearTimeout(timer);
  }, [phase]);

  const result = poll.data;
  useEffect(() => {
    if (!result || settledRef.current) return;
    if (result.status === "denied" || result.status === "expired") {
      settledRef.current = true;
      privateKeyRef.current = null;
      setPhase(result.status);
      return;
    }
    if (result.status === "approved" && result.encryptedLink) {
      const key = privateKeyRef.current;
      const relayOrigin = relayOriginRef.current;
      settledRef.current = true;
      privateKeyRef.current = null; // drop before async work; single use
      if (!key || !relayOrigin) {
        setPhase("error");
        return;
      }
      setPhase("connecting");
      decryptLink(key, relayOrigin, result.encryptedLink)
        .then((href) => {
          window.location.assign(href);
        })
        .catch(() => setPhase("error"));
      return;
    }
  }, [result]);

  return phase;
}
