import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitManager, normalizeCandidateContent, validateCandidatePath } from "../src/git.js";

describe("GitManager", () => {
  it("normalizes text and rejects third-party package imports", () => {
    expect(normalizeCandidateContent("server.mjs", "import http from 'node:http';  \r\nconst path = '/health';\t"))
      .toBe("import http from 'node:http';\nconst path = '/health';\n");
    expect(normalizeCandidateContent("server.mjs", "import http from 'http'; const path = '/health';"))
      .toBe("import http from 'http'; const path = '/health';\n");
    expect(() => normalizeCandidateContent("server.mjs", "import express from 'express';"))
      .toThrow(/Third-party dependency/u);
    expect(() => normalizeCandidateContent("src/app.js", "const x = require('left-pad')"))
      .toThrow(/Third-party dependency/u);
    expect(() => normalizeCandidateContent("server.mjs", "import http from 'node:http';"))
      .toThrow(/health endpoint/u);
  });
  it("rejects traversal, protected files, and shell-like node identities", async () => {
    expect(() => validateCandidatePath("../secret")).toThrow();
    expect(() => validateCandidatePath("package.json")).toThrow();
    expect(() => validateCandidatePath("src/file.txt:secret")).toThrow();
    expect(() => validateCandidatePath("src/CON.txt")).toThrow();
    expect(() => validateCandidatePath("src/.git/config")).toThrow();
    const git = new GitManager();
    await expect(git.createWorktree(".", ".", "x;echo", 1, "HEAD")).rejects.toThrow();
  });

  it("scaffolds, changes in an isolated worktree, validates evidence, and fast-forwards", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-git-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    const git = new GitManager();
    const base = await git.scaffold(repo);
    const worktree = await git.createWorktree(repo, join(root, "worktrees"), "task1", 1, base);
    await git.applyChanges(worktree.path, [{ path: "server.mjs", content: "console.log('/health');\n" }]);
    const candidate = await git.commit(worktree.path, "feat: safe update");
    await expect(git.assertWorktreeAtCommit(worktree.path, candidate)).resolves.toBeUndefined();
    await expect(git.assertWorktreeAtCommit(worktree.path, base)).rejects.toThrow(/HEAD/u);
    await expect(git.fastForwardMerge(repo, candidate, base, [base])).rejects.toThrow("Evidence");
    await expect(git.fastForwardMerge(repo, candidate, base, [candidate])).resolves.toBe(candidate);
  });

  it("rejects tracked and untracked changes in a candidate worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-integrity-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    const git = new GitManager();
    const base = await git.scaffold(repo);
    const tracked = await git.createWorktree(repo, join(root, "worktrees"), "tracked", 1, base);
    await writeFile(join(tracked.path, "server.mjs"), "console.log('/health changed');\n");
    await expect(git.assertWorktreeAtCommit(tracked.path, base)).rejects.toThrow(/differs/u);

    const untracked = await git.createWorktree(repo, join(root, "worktrees"), "untracked", 1, base);
    await writeFile(join(untracked.path, "generated.txt"), "unexpected\n");
    await expect(git.assertWorktreeAtCommit(untracked.path, base)).rejects.toThrow(/differs/u);
  });

  it("refuses symlink traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-link-"));
    const outside = join(root, "outside");
    const worktree = join(root, "worktree");
    await mkdir(outside);
    await mkdir(worktree);
    await symlink(outside, join(worktree, "src"), "junction");
    await expect(new GitManager().applyChanges(worktree, [{ path: "src/pwned", content: "x" }])).rejects.toThrow("Symbolic link");
  });
});
