import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { TARGET_DOCKERFILE } from "./broker.js";

const execFileAsync = promisify(execFile);

export interface FileChange { path: string; content?: string; delete?: boolean }
export interface WorktreeRef { path: string; branch: string; baseCommit: string }

const ALLOWED_PREFIXES = ["src/", "public/", "test/"];
const ALLOWED_ROOT_FILES = new Set(["README.md", "server.mjs"]);
const PROTECTED = new Set(["package.json", "package-lock.json", "Dockerfile", ".gitignore"]);

async function command(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd, encoding: "utf8", windowsHide: true, shell: false,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return stdout.trim();
}

export function validateCandidatePath(candidate: string): string {
  const normalized = candidate.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const reservedDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  const reservedControl = new Set([".git", ".forgeos", "node_modules"]);
  if (!candidate || candidate.includes("\0") || candidate.includes(":") || isAbsolute(candidate)
    || /^[a-zA-Z]:[\\/]/.test(candidate) || /^(?:\\\\|\/\/)/.test(candidate) || normalized.startsWith("/")
    || segments.some((segment) => !segment || segment === "." || segment === ".." || reservedDevice.test(segment) || reservedControl.has(segment.toLowerCase()))) {
    throw new Error(`Unsafe candidate path: ${candidate}`);
  }
  if (PROTECTED.has(normalized) || (!ALLOWED_ROOT_FILES.has(normalized) && !ALLOWED_PREFIXES.some((p) => normalized.startsWith(p)))) {
    throw new Error(`Candidate path is not allowed: ${candidate}`);
  }
  return normalized;
}

export function normalizeCandidateContent(path: string, content: string): string {
  const normalized = content.replace(/\r\n?/gu, "\n").replace(/[ \t]+$/gmu, "");
  if (/\.(?:[cm]?js|ts)$/iu.test(path)) {
    const specifiers = [
      ...normalized.matchAll(/\bfrom\s*["']([^"']+)["']/gu),
      ...normalized.matchAll(/\bimport\s*["']([^"']+)["']/gu),
      ...normalized.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu),
    ].map((match) => match[1]!);
    const forbidden = specifiers.find((specifier) => !isBuiltin(specifier) && !specifier.startsWith("./") && !specifier.startsWith("../"));
    if (forbidden) throw new Error(`Third-party dependency is forbidden: ${forbidden}`);
  }
  if (path === "server.mjs" && !normalized.includes("/health")) {
    throw new Error("server.mjs must preserve the /health endpoint required by the deployment contract");
  }
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

async function safeTarget(root: string, candidate: string): Promise<string> {
  const normalized = validateCandidatePath(candidate);
  const rootPath = await realpath(root);
  const target = resolve(rootPath, ...normalized.split("/"));
  const rel = relative(rootPath, target);
  if (rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel)) throw new Error(`Path escapes worktree: ${candidate}`);

  let cursor = dirname(target);
  while (cursor !== rootPath && relative(rootPath, cursor) !== "") {
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic link traversal is forbidden: ${candidate}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    cursor = dirname(cursor);
  }
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error(`Symbolic link target is forbidden: ${candidate}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

export class GitManager {
  async scaffold(repository: string): Promise<string> {
    await mkdir(join(repository, "test"), { recursive: true });
    await writeFile(join(repository, "package.json"), JSON.stringify({
      name: "forgeos-target", version: "1.0.0", private: true, type: "module",
      scripts: { start: "node server.mjs", test: "node --test", build: "node --check server.mjs" },
    }, null, 2) + "\n");
    await writeFile(join(repository, "server.mjs"), "import http from 'node:http';\nconst port = Number(process.env.PORT || 3000);\nhttp.createServer((req, res) => {\n  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }\n  res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); res.end('<h1>ForgeOS target</h1>');\n}).listen(port, '0.0.0.0');\n");
    await writeFile(join(repository, "test/server.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('template', () => assert.equal(1, 1));\n");
    await writeFile(join(repository, "Dockerfile"), TARGET_DOCKERFILE);
    await writeFile(join(repository, ".gitignore"), "node_modules/\n");
    await command(repository, ["init", "-b", "main"]);
    await command(repository, ["add", "--", "."]);
    await command(repository, ["-c", "user.name=ForgeOS", "-c", "user.email=forgeos@localhost", "commit", "-m", "chore: scaffold target"]);
    return this.head(repository);
  }

  async createWorktree(repository: string, worktreesRoot: string, nodeId: string, attempt: number, baseCommit: string): Promise<WorktreeRef> {
    if (!/^[a-zA-Z0-9_-]+$/.test(nodeId) || !Number.isInteger(attempt) || attempt < 1) throw new Error("Invalid worktree identity");
    const branch = `forge/task/${nodeId}/${attempt}`;
    const path = resolve(worktreesRoot, `${nodeId}-${attempt}`);
    await mkdir(worktreesRoot, { recursive: true });
    await command(repository, ["worktree", "add", "-b", branch, path, baseCommit]);
    return { path, branch, baseCommit };
  }

  async applyChanges(worktree: string, changes: FileChange[]): Promise<void> {
    await realpath(worktree);
    const seen = new Set<string>();
    for (const change of changes) {
      const normalized = validateCandidatePath(change.path);
      if (seen.has(normalized)) throw new Error(`Duplicate candidate path: ${normalized}`);
      seen.add(normalized);
      if (change.delete === true && change.content !== undefined) throw new Error(`Delete cannot include content: ${normalized}`);
      const target = await safeTarget(worktree, normalized);
      if (change.delete) await rm(target, { force: true });
      else {
        if (typeof change.content !== "string") throw new Error(`Missing content: ${normalized}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, normalizeCandidateContent(normalized, change.content), "utf8");
      }
    }
  }

  async commit(worktree: string, message: string): Promise<string> {
    if (!message.trim() || /[\r\n]/.test(message)) throw new Error("Invalid commit message");
    await command(worktree, ["add", "-A", "--"]);
    await command(worktree, ["-c", "user.name=ForgeOS", "-c", "user.email=forgeos@localhost", "commit", "-m", message]);
    return this.head(worktree);
  }

  head(repository: string): Promise<string> { return command(repository, ["rev-parse", "HEAD"]); }
  diffCheck(repository: string, base = "HEAD^"): Promise<string> { return command(repository, ["diff", "--check", base, "HEAD"]); }
  diff(repository: string, base: string, head = "HEAD"): Promise<string> { return command(repository, ["diff", "--no-ext-diff", base, head, "--"]); }
  status(repository: string): Promise<string> { return command(repository, ["status", "--porcelain"]); }
  async read(repository: string, path: string): Promise<string> { return readFile(await safeTarget(repository, path), "utf8"); }

  async fastForwardMerge(repository: string, candidate: string, expectedBase: string, evidenceCommits: string[]): Promise<string> {
    const mainHead = await this.head(repository);
    if (mainHead !== expectedBase) throw new Error("Main advanced; candidate must be revalidated");
    if ((await this.status(repository)) !== "") throw new Error("Main worktree is dirty");
    const candidateHead = await command(repository, ["rev-parse", candidate]);
    if (!evidenceCommits.length || evidenceCommits.some((sha) => sha !== candidateHead)) throw new Error("Evidence does not match candidate HEAD");
    await command(repository, ["merge-base", "--is-ancestor", expectedBase, candidateHead]);
    await command(repository, ["merge", "--ff-only", candidateHead]);
    return this.head(repository);
  }

  async removeWorktree(repository: string, worktree: string): Promise<void> {
    await command(repository, ["worktree", "remove", "--force", resolve(worktree)]);
  }
}
