import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/public", { recursive: true });
await cp("public", "dist/public", { recursive: true });
await mkdir("dist/config", { recursive: true });
await cp("config/models.json", "dist/config/models.json");
