export class AdminApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
  }
}

interface ApiOptions {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  csrf?: boolean;
}

export async function adminApi<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (method !== "GET" && options.csrf !== false) {
    const token = readCookie("__Host-wovoice-admin-csrf");
    if (token) headers.set("X-WoVoice-CSRF", token);
  }
  const response = await fetch(`/admin/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const value = await response.json().catch(() => null) as { error?: { message?: string } } | T | null;
  if (!response.ok) {
    const message = value && typeof value === "object" && "error" in value
      ? value.error?.message ?? `Admin request failed (${response.status}).`
      : `Admin request failed (${response.status}).`;
    throw new AdminApiError(response.status, message);
  }
  return value as T;
}

export function readCookie(name: string): string {
  for (const part of document.cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/admin") || value.startsWith("//")) return "/admin/";
  try {
    const url = new URL(value, "https://wovoice.invalid");
    return url.origin === "https://wovoice.invalid" && url.pathname.startsWith("/admin")
      ? `${url.pathname}${url.search}${url.hash}`
      : "/admin/";
  } catch {
    return "/admin/";
  }
}

export function signInRedirect(): void {
  const returnTo = `${location.pathname}${location.search}`;
  location.assign(`/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`);
}
