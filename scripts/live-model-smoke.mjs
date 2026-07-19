import { z } from "zod";
import { SiliconFlowGateway } from "../dist/src/model.js";

const usage = [];
const gateway = new SiliconFlowGateway({
  configPath: process.env.MODEL_CONFIG_PATH || "config/models.json",
  secretFile: process.env.SILICONFLOW_API_KEY_FILE,
  onUsage: (entry) => usage.push({ model: entry.model, totalTokens: entry.totalTokens, succeeded: entry.succeeded }),
});
const result = await gateway.callJson("fast", [
  { role: "system", content: "Return a JSON object matching the requested fields." },
  { role: "user", content: "Return {\"ok\":true,\"service\":\"forgeos\"}." },
], z.object({ ok: z.literal(true), service: z.literal("forgeos") }));
console.log(JSON.stringify({ result, usage }));
