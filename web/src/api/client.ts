import type {
  LoginRequest,
  LoginResponse,
  VerifyTotpRequest,
  VerifyTotpResponse,
  WhoAmIResponse,
} from "@claudex/shared";

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(`api ${status}: ${code}`);
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, headers, ...rest } = init ?? {};
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    ...rest,
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) code = body.error;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login(body: LoginRequest): Promise<LoginResponse> {
    return request("/api/auth/login", { method: "POST", json: body });
  },
  verifyTotp(body: VerifyTotpRequest): Promise<VerifyTotpResponse> {
    return request("/api/auth/verify-totp", { method: "POST", json: body });
  },
  logout(): Promise<{ ok: true }> {
    return request("/api/auth/logout", { method: "POST" });
  },
  whoami(): Promise<WhoAmIResponse> {
    return request("/api/auth/whoami");
  },
};
