import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_SCHEMA, type EvalError } from "../core/evalPrompt";
import { type Result, err, ok } from "../lib/result";
import { exec, type RunError, runError } from "./runner";

export type EvaluatorId = "claude" | "codex";

/**
 * `--bare` is the cheapest mode (no hooks/plugins/CLAUDE.md/skills in context) but it also skips
 * keychain reads, so it only works with an API key. Without one, fall back to a normal `-p` run
 * that still disables tools, MCP servers and skills so the evaluation context stays small.
 */
const claudeArgv = (bare: boolean, model?: string): string[] => [
  "claude", "-p",
  ...(bare ? ["--bare"] : ["--strict-mcp-config", "--disable-slash-commands"]),
  "--output-format", "json", "--json-schema", JSON.stringify(EVAL_SCHEMA), "--tools", "", "--no-session-persistence",
  ...(model ? ["--model", model] : []),
];

const notLoggedIn = (e: RunError): boolean => e.kind === "exit" && /Not logged in/.test(e.stdout + e.stderr);

/** claude -p with structured output; returns the JSON text (structured_output if present). */
export const evalWithClaude = async (prompt: string, model?: string): Promise<Result<string, EvalError>> => {
  const bare = await exec(claudeArgv(true, model), { stdin: prompt, timeoutMs: 600_000 });
  const r = !bare.ok && notLoggedIn(bare.error) ? await exec(claudeArgv(false, model), { stdin: prompt, timeoutMs: 600_000 }) : bare;
  if (!r.ok) return err({ kind: "run", detail: runError(r.error) });
  try {
    const j = JSON.parse(r.value.stdout) as Record<string, unknown>;
    if (j["is_error"] === true) return err({ kind: "run", detail: String(j["result"] ?? "claude reported an error") });
    const so = j["structured_output"];
    if (so !== undefined) return ok(JSON.stringify(so));
    if (typeof j["result"] === "string") return ok(j["result"]);
    return ok(r.value.stdout);
  } catch {
    return ok(r.value.stdout);
  }
};

/** codex exec with an output schema; the last message is written to a file we read back. */
export const evalWithCodex = async (prompt: string, model?: string): Promise<Result<string, EvalError>> => {
  const dir = await mkdtemp(join(process.env["SKM_TMP"] ?? tmpdir(), "skm-eval-"));
  const schemaPath = join(dir, "schema.json");
  const outPath = join(dir, "out.json");
  await writeFile(schemaPath, JSON.stringify(EVAL_SCHEMA));
  const argv = ["codex", "exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--color", "never", "--output-schema", schemaPath, "-o", outPath, ...(model ? ["-m", model] : []), "-"];
  const r = await exec(argv, { stdin: prompt, timeoutMs: 600_000 });
  const text = await readFile(outPath, "utf8").catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
  if (text !== undefined) return ok(text);
  return r.ok ? ok(r.value.stdout) : err({ kind: "run", detail: runError(r.error) });
};

export const evaluators: Record<EvaluatorId, (prompt: string, model?: string) => Promise<Result<string, EvalError>>> = {
  claude: evalWithClaude,
  codex: evalWithCodex,
};
