/**
 * Thin HTTP client for the COD Network seller API.
 * Docs: https://developer.cod.network/v2
 */

const DEFAULT_BASE_URL = "https://api.cod.network/v2";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CodClientOptions {
  /**
   * Bearer token from My profile -> API developer -> API Token.
   *
   * Optional if `email` + `password` are provided; in that case the client
   * will obtain a token via `POST /seller/login` on first use and refresh
   * it automatically when the API reports an expired token.
   */
  token?: string;
  /** Seller account email (used for auto-login when `token` is missing or expired). */
  email?: string;
  /** Seller account password (used with `email`). */
  password?: string;
  /** Override base URL. Defaults to https://api.cod.network/v2. */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CodRequestOptions {
  method?: HttpMethod;
  /** Path under the base URL, with or without a leading slash. */
  path: string;
  /** Query string parameters. Values are stringified; arrays repeat the key. */
  query?: Record<string, string | number | boolean | string[] | undefined | null>;
  /** JSON body. */
  body?: unknown;
  /** Extra headers to merge with defaults. */
  headers?: Record<string, string>;
}

export class CodApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "CodApiError";
  }
}

interface LoginResponse {
  status?: string;
  access_token?: string;
  expires_in?: number;
}

export class CodClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly email?: string;
  private readonly password?: string;
  private token: string | undefined;
  private loginPromise: Promise<string> | undefined;

  constructor(opts: CodClientOptions) {
    if (!opts.token && !(opts.email && opts.password)) {
      throw new Error(
        "CodClient: provide either `token`, or `email` + `password` for auto-login",
      );
    }
    this.token = opts.token;
    this.email = opts.email;
    this.password = opts.password;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Force-refresh the cached token (re-runs login). Throws if no email/password. */
  async login(): Promise<string> {
    if (!this.email || !this.password) {
      throw new CodApiError(
        "Cannot auto-login: COD_NETWORK_EMAIL / COD_NETWORK_PASSWORD not configured. " +
          "Set them, or provide a fresh COD_NETWORK_API_TOKEN.",
        401,
      );
    }
    // Coalesce concurrent login attempts.
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const data = await this.rawRequest<LoginResponse>({
        method: "POST",
        path: "/seller/login",
        body: { email: this.email, password: this.password },
        skipAuth: true,
      });
      if (!data?.access_token) {
        throw new CodApiError("Login response missing access_token", 0, undefined, data);
      }
      this.token = data.access_token;
      return data.access_token;
    })();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = undefined;
    }
  }

  async request<T = unknown>(opts: CodRequestOptions): Promise<T> {
    if (!this.token) {
      await this.login();
    }
    try {
      return await this.rawRequest<T>(opts);
    } catch (err) {
      if (
        err instanceof CodApiError &&
        err.status === 401 &&
        this.email &&
        this.password
      ) {
        // Token expired or invalidated -> re-login once and retry.
        await this.login();
        return await this.rawRequest<T>(opts);
      }
      throw err;
    }
  }

  /** Single-shot HTTP request without retry/login logic. */
  private async rawRequest<T = unknown>(
    opts: CodRequestOptions & { skipAuth?: boolean },
  ): Promise<T> {
    const method = opts.method ?? "GET";
    const path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
    const url = new URL(`${this.baseUrl}${path}`);

    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, String(v));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "cod-network-mcp/0.1.0",
      ...(opts.headers ?? {}),
    };
    if (!opts.skipAuth && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      clearTimeout(timeout);
      if ((err as Error).name === "AbortError") {
        throw new CodApiError(
          `Request to ${method} ${url.pathname} timed out after ${this.timeoutMs}ms`,
          0,
        );
      }
      throw new CodApiError(
        `Network error calling ${method} ${url.pathname}: ${(err as Error).message}`,
        0,
      );
    }
    clearTimeout(timeout);

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const message =
        (isErrorBody(parsed) && parsed.message) ||
        `HTTP ${res.status} from ${method} ${url.pathname}`;
      const code = isErrorBody(parsed) ? parsed.code : undefined;
      throw new CodApiError(message, res.status, String(code ?? ""), parsed);
    }

    return parsed as T;
  }
}

interface ErrorBody {
  status?: string;
  message?: string;
  code?: string;
}

function isErrorBody(value: unknown): value is ErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    ("message" in value || "code" in value || "status" in value)
  );
}
