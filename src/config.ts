/**
 * Environment configuration. Every value has a working default, and the router
 * is deliberately single-instance and dependency-free.
 */

export interface RouterConfig {
  port: number;
  host: string;

  kiloBaseUrl: string;
  kiloApiKey: string;
  nimBaseUrl: string;
  nimApiKey: string;

  /** Ordered tier list, walked in order. */
  pin: string[];
  /** Allow substituting a later tier when an earlier one is unusable. */
  allowFallback: boolean;
  /** Implicit last tier when the chain can serve anonymously. */
  lastResort: string;

  reasoning: string;
  nimReasoningBudget: number;

  cacheEnabled: boolean;
  cacheTtlMs: number;

  requestTimeoutMs: number;
  /** Total per-request deadline, honoured across the whole tier walk. */
  deadlineMs: number;

  /** Egress guardrail: scan requests and responses for secrets. */
  egressEnabled: boolean;
}

const DEFAULT_PIN = [
  "stepfun-ai/step-5-preview", // NIM, free endpoint
  "nvidia/nemotron-3.5-super-vl:free", // Kilo, free
  "kilo-auto/free", // Kilo, free, anonymous
];

function csv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const parsed = value.split(",").map((s) => s.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const pin = csv(env.ROUTER_PIN, DEFAULT_PIN);
  return {
    port: num(env.ROUTER_PORT, 8787),
    host: env.ROUTER_HOST ?? "127.0.0.1",

    kiloBaseUrl: (env.KILO_BASE_URL ?? "https://ai-gateway.kilo.ai/api/v1").replace(/\/+$/, ""),
    kiloApiKey: env.KILO_API_KEY ?? "",
    nimBaseUrl: (env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(/\/+$/, ""),
    nimApiKey: env.NVIDIA_API_KEY ?? "",

    pin,
    allowFallback: bool(env.ROUTER_ALLOW_FALLBACK, true),
    lastResort: env.ROUTER_LAST_RESORT ?? "kilo-auto/free",

    reasoning: env.ROUTER_REASONING ?? "high",
    nimReasoningBudget: num(env.NIM_REASONING_BUDGET, 16384),

    cacheEnabled: bool(env.ROUTER_ENABLE_CACHE, true),
    cacheTtlMs: num(env.ROUTER_CACHE_TTL_MS, 15 * 60 * 1000),

    requestTimeoutMs: num(env.ROUTER_REQUEST_TIMEOUT_MS, 120_000),
    deadlineMs: num(env.ROUTER_DEADLINE_MS, 150_000),

    egressEnabled: bool(env.ROUTER_EGRESS_ENABLED, true),
  };
}
