/**
 * Per-provider reasoning adapters.
 *
 * The two upstreams disagree completely on how "thinking" is expressed, and
 * neither matches OpenAI's documented shape:
 *
 * - Kilo: its published request schema omits any reasoning field, yet the
 *   gateway accepts `reasoning: {effort}` or `reasoning_effort` for models that
 *   advertise support via `supported_parameters` on GET /models. Support is
 *   discovered per model, then the field is chosen by advertisement. A 400
 *   naming an unknown field falls back once to no reasoning field at all.
 *
 * - NIM: `chat_template_kwargs: {"enable_thinking": true}` plus a top-level
 *   `reasoning_budget`. NIM's OpenAPI marks the body `additionalProperties:
 * false`, yet every NVIDIA example passes `chat_template_kwargs`, so the
 *   documented schema and the real API disagree; the examples are followed.
 *   `stream` defaults to TRUE there, so it is set false explicitly. Thinking
 *   comes back on `message.reasoning_content` and is stripped here.
 */

export type ProviderKind = "kilo" | "nim";

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ReasoningDecision {
  /** Whether a reasoning knob was actually applied. */
  applied: boolean;
  /** Which knob, for logging. */
  mechanism: "reasoning_object" | "reasoning_effort" | "chat_template_kwargs" | "none";
  reason?: string;
}

const KILO_REASONING_FIELDS = ["reasoning", "reasoning_effort"] as const;

export function buildKiloRequest(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
  reasoning: string;
  supportedParameters: Set<string> | null;
  decision: ReasoningDecision;
}): UpstreamRequest {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.topP !== undefined) body.top_p = opts.topP;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.seed !== undefined) body.seed = opts.seed;

  if (opts.supportedParameters && opts.supportedParameters.has("reasoning")) {
    body.reasoning = { effort: opts.reasoning };
    opts.decision.applied = true;
    opts.decision.mechanism = "reasoning_object";
  } else if (opts.supportedParameters && opts.supportedParameters.has("reasoning_effort")) {
    body.reasoning_effort = opts.reasoning;
    opts.decision.applied = true;
    opts.decision.mechanism = "reasoning_effort";
  } else if (opts.supportedParameters === null) {
    // Catalog unreachable: try the OpenRouter-style field and let the 400
    // fallback handle rejection, rather than silently dropping reasoning.
    body.reasoning = { effort: opts.reasoning };
    opts.decision.applied = false;
    opts.decision.mechanism = "none";
    opts.decision.reason = "catalog unreachable; speculative reasoning field sent";
  } else {
    opts.decision.applied = false;
    opts.decision.mechanism = "none";
    opts.decision.reason = `model advertises no reasoning parameter (supported_parameters: ${[...opts.supportedParameters].sort().join(", ") || "empty"})`;
  }

  return {
    url: `${opts.baseUrl}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body,
  };
}

export function kiloReasoningFields(): readonly string[] {
  return KILO_REASONING_FIELDS;
}

export function stripKiloReasoningFields(body: Record<string, unknown>): void {
  for (const field of KILO_REASONING_FIELDS) delete body[field];
}

export function buildNimRequest(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
  reasoningBudget: number;
}): UpstreamRequest {
  // Budget must leave headroom inside max_tokens.
  const maxTokens = Math.max(opts.maxTokens ?? opts.reasoningBudget, opts.reasoningBudget);
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false, // NIM defaults to true; explicit false is required
    temperature: opts.temperature ?? 1,
    top_p: opts.topP ?? 0.95,
    max_tokens: maxTokens,
    reasoning_budget: opts.reasoningBudget,
    chat_template_kwargs: { enable_thinking: true },
  };
  if (opts.seed !== undefined) body.seed = opts.seed;

  return {
    url: `${opts.baseUrl}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body,
  };
}

/**
 * Providers return thinking in different fields, and both are non-OpenAI:
 *
 * - NIM: `message.reasoning_content` (and streaming `delta.reasoning_content`).
 * - Kilo: `message.reasoning` plus a parallel `message.reasoning_details` array,
 *   as seen on live responses from `kilo-auto/free` and the Nemotron tiers.
 *
 * A model that produces reasoning but no content has failed to answer at all,
 * which must be reported distinctly from "returned nothing" - otherwise a
 * degraded free tier is indistinguishable from a transport failure. `hadReasoning`
 * exists precisely so the caller can say which happened.
 */
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_details"] as const;

export function stripReasoningContent(raw: unknown): { content: string; hadReasoning: boolean } {
  if (!raw || typeof raw !== "object") return { content: "", hadReasoning: false };
  const root = raw as Record<string, unknown>;
  const choice = (root.choices as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
  const message = (choice?.message as Record<string, unknown> | undefined) ?? {};
  const content = typeof message.content === "string" ? message.content : "";
  const hadReasoning = REASONING_FIELDS.some((field) => {
    const value = message[field];
    if (typeof value === "string") return value.length > 0;
    return Array.isArray(value) && value.length > 0;
  });
  return { content, hadReasoning };
}

export function extractUsage(raw: unknown): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const usage = (raw as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
  const prompt = Number(usage?.prompt_tokens ?? 0) || 0;
  const completion = Number(usage?.completion_tokens ?? 0) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage?.total_tokens ?? prompt + completion) || 0,
  };
}
