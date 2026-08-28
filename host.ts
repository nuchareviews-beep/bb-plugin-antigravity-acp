/**
 * bb.host artifact for the Antigravity provider. Same shape as
 * bb-plugin-omniroute-acp/host.ts (see that file for the protocol notes and
 * why config is shared through a private OS-temp-dir directory rather than
 * either consumer's own per-process dataDir).
 *
 * Unlike OmniRoute (an HTTP proxy), Antigravity is a local CLI (`agy`) with
 * its own OAuth state — the bridge shells out to it per turn rather than
 * calling an HTTP API.
 *
 * Known limitation: `agy` mints its own conversation id only after the first
 * turn runs, so this bridge mints its own opaque providerThreadId and tracks
 * the underlying agy conversation id in an in-memory map. That map is lost if
 * the bridge process is recycled (idle eviction, reload, crash) — thread
 * resume after that point starts a fresh agy conversation rather than truly
 * continuing the old one. Good enough for single-session use; a durable fix
 * would persist the mapping to disk keyed by providerThreadId.
 */
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  type PromptInput,
  type ThreadDelta,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  initializeParamsSchema,
  modelListParamsSchema,
  runBridgeRequest,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  experimental_defineProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { antigravityHostContract } from "./contract.js";

const execFileAsync = promisify(execFile);

/**
 * `agy models` (no -p flag) hangs indefinitely reading stdin when spawned
 * with execFile's default stdio (an open, never-closed pipe) — confirmed by
 * reproducing it standalone outside the plugin. `agy -p ...` doesn't hit
 * this (the prompt arg makes it non-interactive on its own), so only the
 * model-list path needs this: stdin explicitly closed via spawn.
 */
function runAgyNoStdin(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${bin} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} ${args.join(" ")} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

const configDir = join(tmpdir(), "bb-plugin-antigravity-acp");
const configPath = join(configDir, "config.json");
const legacyConfigPath = join(tmpdir(), "bb-plugin-antigravity-acp-config.json");

function writeConfig(input: object): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  writeFileSync(configPath, JSON.stringify(input), { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);
  try {
    unlinkSync(legacyConfigPath);
  } catch {
    // The legacy file is absent after the first successful migration.
  }
}

export default experimental_defineHostEntry({
  contract: antigravityHostContract,
  handlers: {
    setConfig: (input) => {
      writeConfig(input);
      return { ok: true as const };
    },
  },
});

interface AntigravityConfig {
  agyBin: string;
  model: string;
  effort: "low" | "medium" | "high";
}

function loadConfig(): AntigravityConfig {
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, "utf8")) as AntigravityConfig;
    } catch {
      // fall through to defaults
    }
  }
  return { agyBin: "agy", model: "", effort: "medium" };
}

const instanceNonce = randomUUID().replaceAll("-", "").slice(0, 12);
let threadCounter = 0;
/** Our own threadId -> agy's own conversation_id, once known. */
const agyConversationByThread = new Map<string, string>();
/** threadId -> { providerThreadId, model } — model is frozen at thread construction. */
const sessions = new Map<string, { providerThreadId: string; model: string; reasoningLevel?: string }>();

type JsonRpcId = string | number;

type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;
const io = createBridgeIo<OutboundMessage>();

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}
function emitDeltas(threadId: string, deltas: ThreadDelta[]): void {
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

function promptText(input: readonly PromptInput[]): string {
  return input
    .filter((item): item is Extract<PromptInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("");
}

interface AgyResult {
  response: string;
  conversationId: string | null;
}

/**
 * agy has no session log of its own in a stable, parseable shape, so this
 * bridge is the source of truth for its usage: one JSONL line per turn,
 * shaped like bb-plugin-usage's existing FX collector (`kind: "generation"`,
 * a `fact` object) so that plugin can add an Antigravity source with a
 * small, additive change rather than a new file format.
 */
const usageLogPath = join(homeDir(), ".antigravity-acp", "usage.jsonl");

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "/root";
}

function appendUsageLog(model: string, usage: Record<string, unknown> | undefined): void {
  if (!usage) return;
  try {
    mkdirSync(join(homeDir(), ".antigravity-acp"), { recursive: true });
    const fact = {
      created_at_ms: Date.now(),
      provider: "google",
      model: model || "agy-default",
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      thinking_tokens: usage.thinking_tokens ?? 0,
      cache_read_tokens: usage.cache_read_tokens ?? 0,
      total_cost: null,
    };
    appendFileSync(usageLogPath, `${JSON.stringify({ kind: "generation", fact })}\n`);
  } catch {
    // Usage logging is best-effort; never let it fail a turn.
  }
}

// ---------------------------------------------------------------------------
// Live model catalog: `agy models` prints one tab-separated "id\tdisplay
// name" line per model (no JSON output mode for this subcommand).
// ---------------------------------------------------------------------------

interface AgyModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: { reasoningEffort: "low" | "medium" | "high"; description: string }[];
  defaultReasoningEffort: "low" | "medium" | "high";
  isDefault: boolean;
}

const REASONING_EFFORTS = ["low", "medium", "high"] as const;
type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * agy exposes one model id per (model, effort) pair — "gemini-3.5-flash-low",
 * "-medium" and "-high" are three distinct ids. bb's provider picker expects
 * one entry per model plus a separate reasoning-effort picker, so the bridge
 * splits the effort tail back off and advertises the base model, then
 * re-encodes the chosen effort into the full agy id at turn time (agy itself
 * rejects `--model` combined with `--effort`, so the id has to carry it).
 */
function splitEffortSuffix(id: string): { base: string; effort: ReasoningEffort | null } {
  for (const effort of REASONING_EFFORTS) {
    if (id.length > effort.length + 1 && id.endsWith(`-${effort}`)) {
      return { base: id.slice(0, -(effort.length + 1)), effort };
    }
  }
  return { base: id, effort: null };
}

/** Full agy model ids that are valid effort variants of a base model. */
const variantModelIds = new Set<string>();

function composeAgyModelId(model: string, reasoningLevel: string | undefined): string {
  if (reasoningLevel === "low" || reasoningLevel === "medium" || reasoningLevel === "high") {
    const full = `${model}-${reasoningLevel}`;
    if (variantModelIds.has(full)) return full;
  }
  return model;
}

let modelCache: { at: number; models: AgyModel[] } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60_000;

async function fetchAgyModels(config: AntigravityConfig): Promise<AgyModel[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_TTL_MS) return modelCache.models;
  try {
    const stdout = await runAgyNoStdin(config.agyBin, ["models"], 30_000);
    const entries = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.includes("\t"))
      .map((line) => {
        const [id, displayName] = line.split("\t");
        return { id: id!, displayName: displayName || id! };
      });

    const families = new Map<string, { displayName: string; efforts: Set<ReasoningEffort> }>();
    for (const { id, displayName } of entries) {
      const { base, effort } = splitEffortSuffix(id);
      if (effort === null) {
        families.set(id, { displayName, efforts: new Set() });
      } else {
        const fam = families.get(base) ?? { displayName, efforts: new Set<ReasoningEffort>() };
        fam.efforts.add(effort);
        fam.displayName = displayName;
        families.set(base, fam);
      }
    }

    variantModelIds.clear();
    const models: AgyModel[] = [];
    for (const [id, fam] of families) {
      const hasEffortVariants = fam.efforts.size > 1;
      if (hasEffortVariants) {
        for (const effort of fam.efforts) variantModelIds.add(`${id}-${effort}`);
      }
      models.push({
        id,
        model: id,
        displayName: hasEffortVariants
          ? fam.displayName.replace(/\s*\((?:Low|Medium|High)\)\s*$/i, "").trim()
          : fam.displayName,
        description: `Antigravity model available through the local agy CLI.`,
        supportedReasoningEfforts: hasEffortVariants
          ? REASONING_EFFORTS.filter((effort) => fam.efforts.has(effort)).map((effort) => ({
              reasoningEffort: effort,
              description:
                effort === "low" ? "Lower reasoning budget" : effort === "high" ? "Higher reasoning budget" : "Standard",
            }))
          : [{ reasoningEffort: "medium", description: "Standard" }],
        defaultReasoningEffort: hasEffortVariants && fam.efforts.has("medium")
          ? "medium"
          : [...fam.efforts][0] ?? "medium",
        isDefault: id === config.model,
      });
    }
    if (models.length > 0 && !models.some((m) => m.isDefault)) models[0]!.isDefault = true;
    modelCache = { at: Date.now(), models };
    return models;
  } catch {
    return modelCache?.models ?? [];
  }
}

async function callAgy(
  threadId: string,
  model: string,
  reasoningLevel: string | undefined,
  prompt: string,
): Promise<AgyResult | { error: string }> {
  const config = loadConfig();
  const existingConversationId = agyConversationByThread.get(threadId);
  const args = ["-p", prompt, "--output-format", "json"];
  if (model) {
    // The variant set is populated by the model-list call; if bb launched a
    // thread before ever listing models, seed it so the composed id is still
    // validated against what agy actually offers.
    if (variantModelIds.size === 0) {
      try {
        await fetchAgyModels(config);
      } catch {
        // best effort — composeAgyModelId falls back to the base id
      }
    }
    args.push("--model", composeAgyModelId(model, reasoningLevel ?? "medium"));
  } else {
    args.push("--effort", config.effort);
  }
  if (existingConversationId) args.push("--conversation", existingConversationId);
  try {
    const { stdout } = await execFileAsync(config.agyBin, args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
    const parsed = JSON.parse(stdout) as {
      status?: string;
      response?: string;
      conversation_id?: string;
      error?: string;
      usage?: Record<string, unknown>;
    };
    if (parsed.status && parsed.status !== "SUCCESS") {
      return { error: parsed.error ?? `agy returned status ${parsed.status}` };
    }
    appendUsageLog(model, parsed.usage);
    return { response: parsed.response ?? "", conversationId: parsed.conversation_id ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function runTurn(args: {
  threadId: string;
  providerThreadId: string;
  model: string;
  reasoningLevel?: string;
  input: readonly PromptInput[];
  clientRequestId?: string;
}): Promise<void> {
  const itemId = `agy_${args.providerThreadId}_${randomUUID()}`;
  const deltas: ThreadDelta[] = [];
  if (args.clientRequestId !== undefined) {
    deltas.push({
      kind: "input.accepted",
      clientRequestId: args.clientRequestId,
    });
  }
  deltas.push({ kind: "turn.open" });
  emitDeltas(args.threadId, deltas);

  const result = await callAgy(args.threadId, args.model, args.reasoningLevel, promptText(args.input));
  let text: string;
  if ("error" in result) {
    text = `Antigravity (agy) request failed: ${result.error}`;
  } else {
    text = result.response;
    if (result.conversationId) agyConversationByThread.set(args.threadId, result.conversationId);
  }

  emitDeltas(args.threadId, [
    {
      kind: "item.open",
      key: { providerItemId: itemId },
      item: { type: "agentMessage", text: "" },
    },
    {
      kind: "item.textClose",
      key: { providerItemId: itemId },
      channel: "agentMessage",
      text,
    },
    { kind: "turn.boundary", status: "error" in result ? "failed" : "completed" },
  ]);
}

type RequestHandler = (id: JsonRpcId, params: unknown) => void;

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, `Invalid params for ${method}`, issues);
}

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
      return;
    }
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        sessionRestore: false,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        approvalEnforcedBy: "runtime",
        steerMode: "queue",
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    const config = loadConfig();
    void fetchAgyModels(config).then((models) => {
      io.sendResult(id, { models, selectedOnlyModels: [] });
    });
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStart, parsed.error.issues);
      return;
    }
    threadCounter += 1;
    const providerThreadId = `agy_${instanceNonce}_${threadCounter}`;
    const config = loadConfig();
    const model = parsed.data.options?.model || config.model;
    const reasoningLevel = parsed.data.options?.reasoningLevel;
    sessions.set(parsed.data.threadId, { providerThreadId, model, reasoningLevel });
    notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
      threadId: parsed.data.threadId,
      providerThreadId,
    });
    emitDeltas(parsed.data.threadId, [{ kind: "session.reset" }]);
    io.sendResult(id, { providerThreadId, sessionRestorable: false });
    if (parsed.data.input !== undefined && parsed.data.input.length > 0) {
      void runTurn({ threadId: parsed.data.threadId, providerThreadId, model, reasoningLevel, input: parsed.data.input });
    }
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadResume, parsed.error.issues);
      return;
    }
    // See the file-level note: the underlying agy conversation id is not
    // recoverable across a bridge process restart, so resume re-adopts our
    // own providerThreadId but starts a fresh agy conversation on next turn.
    const config = loadConfig();
    const model = parsed.data.options?.model || config.model;
    const reasoningLevel = parsed.data.options?.reasoningLevel;
    sessions.set(parsed.data.threadId, { providerThreadId: parsed.data.providerThreadId, model, reasoningLevel });
    notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
      threadId: parsed.data.threadId,
      providerThreadId: parsed.data.providerThreadId,
    });
    emitDeltas(parsed.data.threadId, [{ kind: "session.reset" }]);
    io.sendResult(id, { providerThreadId: parsed.data.providerThreadId, sessionRestorable: false });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, `No session for thread ${parsed.data.threadId}; send thread/start or thread/resume first`);
      return;
    }
    io.sendResult(id, {});
    const config = loadConfig();
    const model = parsed.data.options?.model || session?.model || config.model;
    const reasoningLevel = parsed.data.options?.reasoningLevel || session?.reasoningLevel;
    void runTurn({
      threadId: parsed.data.threadId,
      providerThreadId: parsed.data.providerThreadId,
      model,
      reasoningLevel,
      input: parsed.data.input,
      clientRequestId: parsed.data.clientRequestId,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
      `No active turn to steer (expected ${parsed.data.expectedTurnId})`,
    );
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    sessions.delete(parsed.data.threadId);
    agyConversationByThread.delete(parsed.data.threadId);
    io.sendResult(id, {});
  },
};

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return;
  }
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof method !== "string") return;
  if (typeof id !== "string" && typeof id !== "number") return;
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    return;
  }
  void runBridgeRequest({
    request: { id, method, params },
    sendError: io.sendError,
    handleRequest: async (request) => handler(request.id, request.params),
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
});
