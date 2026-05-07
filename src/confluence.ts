import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type ConfluenceCliErrorKind = "fetch-conflict" | "draft-conflict" | "config" | "crash";

export type ApplyResult =
  | { ok: true; appliedCount: number; oldVersion: number; newVersion: number; mode: string }
  | { ok: false; kind: ConfluenceCliErrorKind; stderr: string; stdout: string };

export type RenderResult = {
  markdown: string;
  pageId: string;
  version: number;
  title: string;
};

export type HasDraftResult = {
  exists: boolean;
  publishedVersion: number;
  draftVersion: number | null;
  title: string;
};

const CONFLUENCE_ENV_KEYS = [
  "CONFLUENCE_BASE_URL",
  "CONFLUENCE_EMAIL",
  "CONFLUENCE_API_TOKEN",
];

let resolvedBin: string | null = null;
let resolveAttempted = false;

function which(cmd: string): string | null {
  const pathEnv = process.env.PATH || "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {}
  }
  return null;
}

export function resolveConfluenceBin(): string | null {
  if (resolveAttempted) return resolvedBin;
  resolveAttempted = true;
  const fromEnv = process.env.CONFLUENCE_ADF_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) {
    resolvedBin = fromEnv;
    return resolvedBin;
  }
  const fromPath = which("confluence-adf");
  if (fromPath) {
    resolvedBin = fromPath;
    return resolvedBin;
  }
  const fallback = path.resolve(process.cwd(), ".venv/bin/confluence-adf");
  if (fs.existsSync(fallback)) {
    resolvedBin = fallback;
    return resolvedBin;
  }
  return null;
}

export function isConfluenceConfigured(): boolean {
  if (!resolveConfluenceBin()) return false;
  return CONFLUENCE_ENV_KEYS.every((key) => Boolean(process.env[key]));
}

export function getConfluenceBaseUrl(): string | null {
  return process.env.CONFLUENCE_BASE_URL || null;
}

export async function runConfluenceCli(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<CliResult> {
  const bin = resolveConfluenceBin();
  if (!bin) {
    return {
      exitCode: 3,
      stdout: "",
      stderr:
        "confluence-adf binary not found. Set CONFLUENCE_ADF_BIN, install confluence-adf on PATH, or use .venv/bin/confluence-adf.",
      durationMs: 0,
      timedOut: false,
    };
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
  };
  for (const key of CONFLUENCE_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  const timeoutMs = opts.timeoutMs ?? 30000;
  const start = Date.now();

  return await new Promise<CliResult>((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
        timedOut: false,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 2000);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: (Buffer.concat(stderrChunks).toString("utf8") + "\n" + error.message).trim(),
        durationMs: Date.now() - start,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({
        exitCode: timedOut ? 1 : (code ?? 1),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: timedOut ? `${stderr}\ntimeout after ${timeoutMs}ms` : stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

const FRONT_MATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

function parseFrontMatter(markdown: string): Record<string, string> {
  const match = markdown.match(FRONT_MATTER_RE);
  if (!match) return {};
  const block = match[1];
  const out: Record<string, string> = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export async function renderAnnotated(pageId: string): Promise<RenderResult> {
  const result = await runConfluenceCli(["render", pageId, "--no-compress"], { timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || `confluence-adf render exited ${result.exitCode}`;
    throw new Error(message);
  }
  const markdown = result.stdout;
  const fm = parseFrontMatter(markdown);
  const version = Number(fm.version);
  if (!Number.isFinite(version)) {
    throw new Error("confluence-adf render: missing or invalid version in front-matter");
  }
  return {
    markdown,
    pageId: fm.page_id || pageId,
    version,
    title: fm.title || "untitled",
  };
}

const APPLY_OK_RE =
  /<!--\s*applied\s+(\d+)\s+edit\(s\)[^>]*v(\d+)\s*->\s*v(\d+)\s*\(([^)]+)\)\s*-->/;
const APPLY_NO_CHANGES_RE = /No changes detected/;

export async function applyAnnotated(
  pageId: string,
  markdown: string,
  opts: { tempDir?: string } = {},
): Promise<ApplyResult> {
  const tmpDir = opts.tempDir || (process.env.TMPDIR || "/tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tempfile = path.join(
    tmpDir,
    `jot-push-${pageId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.md`,
  );
  const fd = fs.openSync(tempfile, "wx", 0o600);
  try {
    fs.writeSync(fd, markdown);
  } finally {
    fs.closeSync(fd);
  }

  try {
    const result = await runConfluenceCli(["apply", pageId, tempfile], { timeoutMs: 60000 });
    if (result.exitCode === 0) {
      const stdout = result.stdout;
      const okMatch = stdout.match(APPLY_OK_RE);
      if (okMatch) {
        return {
          ok: true,
          appliedCount: Number(okMatch[1]),
          oldVersion: Number(okMatch[2]),
          newVersion: Number(okMatch[3]),
          mode: okMatch[4],
        };
      }
      if (APPLY_NO_CHANGES_RE.test(stdout)) {
        return { ok: true, appliedCount: 0, oldVersion: 0, newVersion: 0, mode: "no-op" };
      }
      return {
        ok: false,
        kind: "crash",
        stderr: result.stderr,
        stdout,
      };
    }

    let kind: ConfluenceCliErrorKind = "crash";
    if (result.exitCode === 3) kind = "config";
    else if (result.exitCode === 4) kind = "fetch-conflict";
    else if (result.exitCode === 5) kind = "draft-conflict";

    // confluence-adf returns EXIT_CRASH (1) for some version conflicts during apply
    // (parser-level version mismatch). Detect from stderr.
    if (result.exitCode === 1 && /version conflict/i.test(result.stderr)) {
      kind = "fetch-conflict";
    }

    return {
      ok: false,
      kind,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    try { fs.unlinkSync(tempfile); } catch {}
  }
}

export async function hasDraft(pageId: string): Promise<HasDraftResult> {
  const result = await runConfluenceCli(["has-draft", pageId], { timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `confluence-adf has-draft exited ${result.exitCode}`);
  }
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const exists = fields.draft === "yes";
  const publishedVersion = Number(fields.published_version);
  const draftVersion = exists ? Number(fields.draft_version) : null;
  return {
    exists,
    publishedVersion: Number.isFinite(publishedVersion) ? publishedVersion : 0,
    draftVersion: draftVersion !== null && Number.isFinite(draftVersion) ? draftVersion : null,
    title: fields.title || "",
  };
}
