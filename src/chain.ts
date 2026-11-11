/**
 * Ordered tier walking with lazy circuit breaking.
 *
 * Config errors (400/404, bad ID, missing key) never open a circuit - they are
 * surfaced as config_error and the walk moves on, because they will not fix
 * themselves on a retry. Rate limits and timeouts open the circuit.
 *
 * The breaker is lazy: it opens on failure and half-opens on the next request,
 * so there is no scheduler. Consecutive failures are halved once a cooldown has
 * elapsed, which stops every tier reopening in a synchronised burst.
 */

import type { RouterConfig } from "./config.js";
import type { ChatMessage } from "./types.js";
import { KiloProvider, NimProvider, type Provider, type TierOutcome } from "./providers.js";

const COOLDOWN_MS = 60_000;
const FAILURE_THRESHOLD = 3;

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
}

export interface ChainResult {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  modelUsed: string;
  fromFallback: boolean;
  tiersAttempted: string[];
  upstreamSeconds: number;
}

export class TierChain {
  private readonly providers: Provider[];
  private readonly breakers = new Map<string, BreakerState>();

  constructor(private readonly config: RouterConfig, providers?: Provider[]) {
    // Providers are injectable so the tier order, breaker and fallback rules can
    // be tested without network calls.
    this.providers = providers ?? [new KiloProvider(config), new NimProvider(config)];
  }

  private providerFor(modelId: string): Provider | null {
    for (const provider of this.providers) {
      if (provider.owns(modelId)) return provider;
    }
    return null;
  }

  /** Startup check: every configured tier must be owned by some provider. */
  validateTiers(): string[] {
    const unowned = this.config.pin.filter((id) => !this.providerFor(id));
    const lastResortOwner = this.providerFor(this.config.lastResort);
    if (!lastResortOwner) unowned.push(this.config.lastResort);
    return unowned;
  }

  isOpen(modelId: string): boolean {
    const state = this.breakers.get(modelId);
    if (!state || state.openedAt === null) return false;
    if (Date.now() - state.openedAt >= COOLDOWN_MS) {
      // Half-open: allow a probe.
      state.openedAt = null;
      state.consecutiveFailures = Math.floor(state.consecutiveFailures / 2);
      return false;
    }
    return true;
  }

  private recordSuccess(modelId: string): void {
    this.breakers.set(modelId, { consecutiveFailures: 0, openedAt: null });
  }

  private recordFailure(modelId: string, errorType: TierOutcome extends never ? never : string): void {
    if (errorType === "config_error") return; // never a circuit
    const state = this.breakers.get(modelId) ?? { consecutiveFailures: 0, openedAt: null };
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= FAILURE_THRESHOLD) state.openedAt = Date.now();
    this.breakers.set(modelId, state);
  }

  async run(
    messages: ChatMessage[],
    temperature?: number,
    topP?: number,
    maxTokens?: number,
    seed?: number,
  ): Promise<ChainResult> {
    // Dedupe: the last resort is usually already in the pin, and appending it
    // again would attempt the same exhausted tier twice in one request.
    const tiers = [...new Set([...this.config.pin, this.config.lastResort])];

    const attempted: string[] = [];
    const failures: string[] = [];
    const errorTypes = new Set<string>();

    for (const modelId of tiers) {
      if (attempted.length > 0 && !this.config.allowFallback) break;

      const provider = this.providerFor(modelId);
      if (!provider) {
        failures.push(`${modelId}: no provider owns this model id`);
        continue;
      }
      if (this.isOpen(modelId)) {
        failures.push(`${modelId}: circuit open`);
        continue;
      }

      attempted.push(modelId);
      const outcome: TierOutcome = await provider.call(modelId, messages, temperature, topP, maxTokens, seed);

      if (outcome.ok) {
        this.recordSuccess(modelId);
        return {
          content: outcome.content,
          usage: outcome.usage,
          modelUsed: outcome.modelUsed,
          fromFallback: attempted.length > 1,
          tiersAttempted: attempted,
          upstreamSeconds: outcome.upstreamSeconds,
        };
      }

      this.recordFailure(modelId, outcome.errorType);
      errorTypes.add(outcome.errorType);
      failures.push(`${modelId}: ${outcome.error}`);
    }

    // Classify by the most informative cause actually seen, not a blanket guess.
    const type =
      errorTypes.has("config_error") && attempted.length <= 1
        ? "config_error"
        : errorTypes.has("upstream_timeout")
          ? "upstream_timeout"
          : "upstream_rate_limited";
    const status = type === "config_error" ? 400 : 503;

    const error = new Error(`no tier produced a completion; ${failures.join(" | ")}`) as Error & {
      tiersAttempted: string[];
      type: string;
      status: number;
    };
    error.tiersAttempted = attempted;
    error.type = type;
    error.status = status;
    throw error;
  }

  breakerSnapshot(): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};
    for (const [modelId, state] of this.breakers) {
      snapshot[modelId] = {
        consecutive_failures: state.consecutiveFailures,
        open: this.isOpen(modelId),
      };
    }
    return snapshot;
  }
}
