import { readFileSync } from "node:fs";
import type {
  BrokerPreviewRequest,
  BrokerPreviewResult,
  BrokerRunRequest,
  BrokerRunResult,
} from "./broker.js";

export interface BrokerClientOptions {
  baseUrl?: string;
  token?: string;
  tokenFile?: string;
  fetch?: typeof fetch;
}

export class BrokerClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class BrokerClient {
  readonly baseUrl: string;
  readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BrokerClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.BROKER_URL ?? "http://127.0.0.1:4001").replace(/\/+$/u, "");
    const tokenFile = options.tokenFile ?? process.env.BROKER_TOKEN_FILE;
    this.token = options.token ?? (tokenFile ? readFileSync(tokenFile, "utf8").trim() : "");
    if (this.token.length < 16) throw new Error("A broker token of at least 16 characters is required");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async health(): Promise<{ status: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`);
    return await this.decode<{ status: string }>(response);
  }

  async run(input: BrokerRunRequest): Promise<BrokerRunResult> {
    return await this.post<BrokerRunResult>("/run", input);
  }

  async preview(input: BrokerPreviewRequest): Promise<BrokerPreviewResult> {
    return await this.post<BrokerPreviewResult>("/preview", input);
  }

  private async post<T>(pathname: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return await this.decode<T>(response);
  }

  private async decode<T>(response: Response): Promise<T> {
    const payload = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
    if (!response.ok) {
      const code = typeof payload?.error === "string" ? payload.error : "BROKER_REQUEST_FAILED";
      const message = typeof payload?.message === "string" ? payload.message : `Broker request failed with HTTP ${response.status}`;
      throw new BrokerClientError(response.status, code, message);
    }
    return payload as T;
  }
}
