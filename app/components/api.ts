export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Fetch a `{data}` API route; throws ApiError with the server's message. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON error body; fall through
  }
  if (!res.ok) {
    const message = field(body, "error");
    throw new ApiError(
      res.status,
      typeof message === "string" ? message : `Request failed (${res.status})`,
    );
  }
  // Server contract: ok responses are ApiOk<T>; T is caller-declared.
  const data = field(body, "data") as T;
  return data;
}

export function postJson(payload: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}
