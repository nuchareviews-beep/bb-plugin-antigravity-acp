/**
 * bb.host artifact for the Antigravity provider. Same shape as
 * bb-plugin-omniroute-acp/host.ts (see that file for the protocol notes and
 * why config is shared through a fixed OS-temp-dir path rather than either
 * consumer's own per-process dataDir).
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
  type ThreadEvent,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  initializeParamsSchema,
  modelListParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  experimental_defineProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { antigravityHostContract } from "./contract.js";

const execFileAsync = promisify(execFile);

const configPath = join(tmpdir(), "bb-plugin-antigravity-acp-config.json");

export default experimental_defineHostEntry({
  contract: antigravityHostContract,
  handlers: {
    setConfig: (input) => {
      writeFileSync(configPath, JSON.stringify(input));
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
let turnCounter = 0;
/** Our own threadId -> agy's own conversation_id, once known. */
const agyConversationByThread = new Map<string, string>();
const sessions = new Map<string, string>();

type JsonRpcId = string | number;

function writeMessage(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}
function respondResult(id: JsonRpcId, result: unknown): void {
  writeMessage({ id, result });
}
function respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  writeMessage({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}
function notify(method: string, params: Record<string, unknown>): void {
  writeMessage({ method, params });
}
function emitThreadEvent(threadId: string, event: ThreadEvent): void {
  notify(BRIDGE_NOTIFICATION_METHODS.threadEvent, { threadId, event });
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

function appendUsageLog(config: AntigravityConfig, usage: Record<string, unknown> | undefined): void {
  if (!usage) return;
  try {
    mkdirSync(join(homeDir(), ".antigravity-acp"), { recursive: true });
    const fact = {
      created_at_ms: Date.now(),
      provider: "google",
      model: config.model || "agy-default",
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

async function callAgy(
  threadId: string,
  prompt: string,
): Promise<AgyResult | { error: string }> {
  const config = loadConfig();
  const existingConversationId = agyConversationByThread.get(threadId);
  const args = ["-p", prompt, "--output-format", "json", "--effort", config.effort];
  if (config.model) args.push("--model", config.model);
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
    appendUsageLog(config, parsed.usage);
    return { response: parsed.response ?? "", conversationId: parsed.conversation_id ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function runTurn(args: {
  threadId: string;
  providerThreadId: string;
  input: readonly PromptInput[];
  clientRequestId?: string;
}): Promise<void> {
  turnCounter += 1;
  const turnId = `turn_agy_${instanceNonce}_${turnCounter}`;
  const itemId = `${turnId}_item_1`;
  const scope = { kind: "turn", turnId } as const;
  const base = { threadId: args.threadId, providerThreadId: args.providerThreadId };

  // Matches the ordering fix verified against a live bb 0.39.0 server in
  // bb-plugin-omniroute-acp: turn/started must be stored before
  // turn/input/accepted, or the server rejects the latter with a 409.
  emitThreadEvent(args.threadId, { type: "turn/started", ...base, scope });
  if (args.clientRequestId !== undefined) {
    emitThreadEvent(args.threadId, {
      type: "turn/input/accepted",
      ...base,
      clientRequestId: args.clientRequestId,
      scope,
    });
  }
  emitThreadEvent(args.threadId, {
    type: "item/started",
    ...base,
    item: { type: "agentMessage", id: itemId, text: "" },
    scope,
  });

  const result = await callAgy(args.threadId, promptText(args.input));
  let text: string;
  if ("error" in result) {
    text = `Antigravity (agy) request failed: ${result.error}`;
  } else {
    text = result.response;
    if (result.conversationId) agyConversationByThread.set(args.threadId, result.conversationId);
  }

  emitThreadEvent(args.threadId, {
    type: "item/agentMessage/delta",
    ...base,
    itemId,
    delta: text,
    scope,
  });
  emitThreadEvent(args.threadId, {
    type: "item/completed",
    ...base,
    item: { type: "agentMessage", id: itemId, text },
    scope,
  });
  emitThreadEvent(args.threadId, {
    type: "turn/completed",
    ...base,
    status: "error" in result ? "failed" : "completed",
    scope,
  });
}

type RequestHandler = (id: JsonRpcId, params: unknown) => void;

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  respondError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, `Invalid params for ${method}`, issues);
}

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
      return;
    }
    respondResult(id, { protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION, capabilities: {} });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    // agy resolves its own model internally (config.model overrides it); a
    // single default entry lets bb resolve a default model without the user
    // passing --model explicitly on every spawn.
    respondResult(id, {
      models: [
        {
          id: "default",
          model: "default",
          displayName: "Antigravity (agy default)",
          description: "Uses agy's own configured default model.",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "medium", description: "Medium" },
            { reasoningEffort: "high", description: "High" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
      selectedOnlyModels: [],
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
    sessions.set(parsed.data.threadId, providerThreadId);
    notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
      threadId: parsed.data.threadId,
      providerThreadId,
    });
    respondResult(id, { providerThreadId });
    if (parsed.data.input !== undefined && parsed.data.input.length > 0) {
      void runTurn({ threadId: parsed.data.threadId, providerThreadId, input: parsed.data.input });
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
    sessions.set(parsed.data.threadId, parsed.data.providerThreadId);
    notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
      threadId: parsed.data.threadId,
      providerThreadId: parsed.data.providerThreadId,
    });
    respondResult(id, { providerThreadId: parsed.data.providerThreadId });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    respondResult(id, {});
    void runTurn({
      threadId: parsed.data.threadId,
      providerThreadId: parsed.data.providerThreadId,
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
    respondError(
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
    respondResult(id, {});
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
    respondError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    return;
  }
  handler(id, params);
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
});
