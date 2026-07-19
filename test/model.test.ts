import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SiliconFlowGateway } from "../src/model.js";

async function fixture(fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}, onUsage?: (usage: import("../src/model.js").ModelUsage) => void) {
  const dir = await mkdtemp(join(tmpdir(), "forge-model-"));
  const configPath = join(dir, "models.json");
  const secretFile = join(dir, "key");
  await writeFile(secretFile, "secret-value\n");
  await writeFile(configPath, JSON.stringify({
    baseUrl: "https://example.invalid/v1",
    routes: { fast: { model: "test/model", inputTokenLimit: 100, outputTokenLimit: 20, jsonMode: true } },
    retry: { maxTransientAttempts: 3, maxSchemaRepairAttempts: 1, baseDelayMs: 0 },
    ...overrides,
  }));
  return new SiliconFlowGateway({ configPath, secretFile, fetch, sleep: async () => undefined, onUsage });
}

const reply = (content: string, status = 200) => new Response(status === 200 ? JSON.stringify({
  choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
}) : content, { status, headers: { "content-type": "application/json" } });

describe("SiliconFlowGateway", () => {
  it("reads a file secret, requests JSON mode, validates output, and reports usage", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret-value");
      expect(JSON.parse(String(init?.body)).response_format).toEqual({ type: "json_object" });
      return reply('{"name":"Forge"}');
    });
    const usage = vi.fn();
    const gateway = await fixture(fetchMock as typeof fetch, {}, usage);
    await expect(gateway.callJson("fast", [{ role: "user", content: "name" }], z.object({ name: z.string() })))
      .resolves.toEqual({ name: "Forge" });
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ model: "test/model", totalTokens: 5, succeeded: true }));
  });

  it("retries transient responses but not authentication errors", async () => {
    const transient = vi.fn()
      .mockResolvedValueOnce(reply("busy", 503))
      .mockResolvedValueOnce(reply('{"ok":true}'));
    const gateway = await fixture(transient as typeof fetch);
    await expect(gateway.callJson("fast", [{ role: "user", content: "x" }], z.object({ ok: z.boolean() })))
      .resolves.toEqual({ ok: true });
    expect(transient).toHaveBeenCalledTimes(2);

    const auth = vi.fn().mockResolvedValue(reply("denied", 401));
    await expect((await fixture(auth as typeof fetch)).callJson("fast", [], z.object({}))).rejects.toThrow("401");
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it("makes one schema repair request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply('{"wrong":1}'))
      .mockResolvedValueOnce(reply('```json\n{"ok":true}\n```'));
    const gateway = await fixture(fetchMock as typeof fetch);
    await expect(gateway.callJson("fast", [], z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports failure after malformed JSON and one exhausted repair", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply("not-json"))
      .mockResolvedValueOnce(reply('{"wrong":true}'));
    const usage = vi.fn();
    const gateway = await fixture(fetchMock as typeof fetch, {}, usage);
    await expect(gateway.callJson("fast", [], z.object({ ok: z.boolean() }))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ succeeded: false }));
  });

  it("retries request timeouts with a bounded attempt count", async () => {
    const timeout = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const gateway = await fixture(timeout as typeof fetch, {
      retry: { maxTransientAttempts: 2, maxSchemaRepairAttempts: 0, baseDelayMs: 0, requestTimeoutMs: 1 },
    });
    await expect(gateway.callJson("fast", [], z.object({ ok: z.boolean() }))).rejects.toThrow(/timed out/u);
    expect(timeout).toHaveBeenCalledTimes(2);
  });
});
