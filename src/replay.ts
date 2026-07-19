import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ForgeStore } from "./store.js";

export function replayDatabase(filename: string): { projects: number; events: number } {
  const store = new ForgeStore(filename);
  try {
    store.rebuildProjections();
    const projects = store.listProjects();
    return {
      projects: projects.length,
      events: projects.reduce((total, project) => total + store.getEvents(project.id).length, 0),
    };
  } finally {
    store.close();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const filename = process.argv[2] ?? process.env.FORGEOS_DB_PATH;
  if (!filename) {
    console.error("Usage: npm run replay -- <sqlite-file>");
    process.exitCode = 2;
  } else {
    const result = replayDatabase(filename);
    console.log(`Rebuilt projections for ${result.projects} project(s) from ${result.events} event(s).`);
  }
}
