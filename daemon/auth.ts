/** Config-bound cookie + Bearer auth for the local daemon. */

import type { ShareConfig } from "../shared/config";
import {
  DASHBOARD_COOKIE_NAME,
  clearSessionCookie,
  createSessionCookie,
  readCookie,
  signSessionCookie,
  timingSafeEqual,
  verifySessionCookie,
  type AuthOk,
} from "../lib/auth";
import { jsonError } from "../lib/contracts";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function isAuthOk(v: AuthOk | Response): v is AuthOk {
  return !(v instanceof Response) && v.ok === true;
}

export function verifyPassword(
  provided: string,
  config: ShareConfig,
): boolean {
  if (!provided || !config.dashboardPassword) return false;
  return timingSafeEqual(provided, config.dashboardPassword);
}

export async function issueDashboardCookie(
  config: ShareConfig,
  secure = true,
): Promise<string> {
  const value = await signSessionCookie(COOKIE_MAX_AGE_SECONDS, config.cookieSecret);
  return createSessionCookie(value, {
    maxAge: COOKIE_MAX_AGE_SECONDS,
    secure,
  });
}

export function expireDashboardCookie(secure = true): string {
  return clearSessionCookie({ secure });
}

export async function requireDashboardAuth(
  request: Request,
  config: ShareConfig,
): Promise<AuthOk | Response> {
  const raw = readCookie(request.headers.get("cookie"), DASHBOARD_COOKIE_NAME);
  if (!(await verifySessionCookie(raw, config.cookieSecret))) {
    return jsonError("unauthorized", 401);
  }
  return { ok: true };
}

/** Host Bearer gate — token from share config only. */
export function requireHostAuth(
  request: Request,
  config: ShareConfig,
): AuthOk | Response {
  const expected = config.hostToken;
  if (!expected) return jsonError("server misconfigured", 500);
  const header = request.headers.get("authorization");
  if (!header) return jsonError("unauthorized", 401);
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return jsonError("unauthorized", 401);
  const token = m[1]!.trim();
  if (!token || !timingSafeEqual(token, expected)) {
    return jsonError("unauthorized", 401);
  }
  return { ok: true };
}
