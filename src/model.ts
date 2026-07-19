import { readFile } from "node:fs/promises";
import { z } from "zod";

const routeSchema = z.object({
  model: z.string().min(1),
  inputTokenLimit: z.number().int().positive(),
  outputTokenLimit: z.number().int().positive(),
  jsonMode: z.boolean().optional().default(true),
  enableThinking: z.boolean().optional(),
  enabled: z.boolean().optional().default(true),
});

const configSchema = z.object({
  baseUrl: z.string().url(),
  routes: z.record(z.string(), routeSchema),
  retry: z.object({
    maxTransientAttempts: z.number().int().positive().default(3),
    maxSchemaRepairAttempts: z.number().int().nonnegative().default(1),
    baseDelayMs: z.number().int().nonnegative().default(1000),
    requestTimeoutMs: z.number().int().positive().default(120_000),
  }),
});

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});

export type ModelRoute = "fast" | "code" | "reasoning" | "independentReview" | (string & {});
export type ModelMessage = { role: "system" | "user" | "assistant"; content: string };

export interface ModelUsage {
  route: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  succeeded: boolean;
  correlationId?: string;
  error?: string;
}

export interface ModelGatewayOptions {
  configPath?: string;
  secretFile?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  onUsage?: (usage: ModelUsage) => void | Promise<void>;
}

export interface ModelCallContext {
  correlationId?: string;
  onUsage?: (usage: ModelUsage) => void | Promise<void>;
}

export class ModelGatewayError extends Error {
  constructor(message: string, public readonly retryable = false, public readonly status?: number) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

function jsonText(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

export class SiliconFlowGateway {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly configPath: string;

  constructor(private readonly options: ModelGatewayOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.configPath = options.configPath ?? "config/models.json";
  }

  async callJson<T>(
    routeName: ModelRoute,
    messages: ModelMessage[],
    outputSchema: z.ZodType<T>,
    context: ModelCallContext = {},
  ): Promise<T> {
    const config = configSchema.parse(JSON.parse(await readFile(this.configPath, "utf8")));
    const route = config.routes[routeName];
    if (!route || !route.enabled) throw new ModelGatewayError(`Model route is unavailable: ${routeName}`);
    const apiKey = await this.readApiKey();
    let schemaRepairs = 0;
    let requestMessages = [...messages];

    for (;;) {
      const started = Date.now();
      let lastError: unknown;
      for (let attempt = 1; attempt <= config.retry.maxTransientAttempts; attempt += 1) {
        try {
          let response: Response;
          try {
            response = await this.fetchImpl(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
              method: "POST",
              headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
              body: JSON.stringify({
                model: route.model,
                messages: requestMessages,
                max_tokens: route.outputTokenLimit,
                response_format: route.jsonMode ? { type: "json_object" } : undefined,
                enable_thinking: route.enableThinking,
                stream: false,
              }),
              signal: AbortSignal.timeout(config.retry.requestTimeoutMs),
            });
          } catch (error) {
            if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
              throw new ModelGatewayError("SiliconFlow request timed out", true);
            }
            throw error;
          }
          if (!response.ok) {
            const retryable = response.status === 429 || response.status >= 500;
            const detail = (await response.text()).slice(0, 500);
            throw new ModelGatewayError(`SiliconFlow HTTP ${response.status}: ${detail}`, retryable, response.status);
          }
          const parsedResponse = responseSchema.parse(await response.json());
          const usage = parsedResponse.usage;
          try {
            const value = outputSchema.parse(jsonText(parsedResponse.choices[0]!.message.content));
            const usageRecord: ModelUsage = {
              route: routeName, model: route.model,
              promptTokens: usage?.prompt_tokens ?? 0,
              completionTokens: usage?.completion_tokens ?? 0,
              totalTokens: usage?.total_tokens ?? 0,
              latencyMs: Date.now() - started, succeeded: true,
              correlationId: context.correlationId,
            };
            await this.emitUsage(usageRecord);
            await context.onUsage?.(usageRecord);
            return value;
          } catch (error) {
            if (schemaRepairs >= config.retry.maxSchemaRepairAttempts) throw error;
            schemaRepairs += 1;
            requestMessages = [
              ...messages,
              { role: "user", content: "Your previous response was not valid JSON matching the requested schema. Return only one corrected JSON object." },
            ];
            break;
          }
        } catch (error) {
          lastError = error;
          const retryable = error instanceof ModelGatewayError ? error.retryable : error instanceof TypeError;
          if (!retryable || attempt === config.retry.maxTransientAttempts) {
            const usageRecord: ModelUsage = {
              route: routeName, model: route.model, promptTokens: 0, completionTokens: 0, totalTokens: 0,
              latencyMs: Date.now() - started, succeeded: false, correlationId: context.correlationId,
              error: error instanceof Error ? error.message : String(error),
            };
            await this.emitUsage(usageRecord);
            await context.onUsage?.(usageRecord);
            throw error;
          }
          await this.sleep(config.retry.baseDelayMs * 2 ** (attempt - 1));
        }
      }
      if (lastError && schemaRepairs > config.retry.maxSchemaRepairAttempts) throw lastError;
    }
  }

  private async readApiKey(): Promise<string> {
    const value = this.options.apiKey
      ?? process.env.SILICONFLOW_API_KEY
      ?? (await readFile(this.options.secretFile ?? process.env.SILICONFLOW_API_KEY_FILE ?? "/run/secrets/siliconflow_api_key", "utf8"));
    const trimmed = value.trim();
    if (!trimmed) throw new ModelGatewayError("SiliconFlow API key is empty");
    return trimmed;
  }

  private async emitUsage(usage: ModelUsage): Promise<void> {
    await this.options.onUsage?.(usage);
  }
}
