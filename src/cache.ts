/**
 * Exact-key response cache with a short TTL.
 *
 * Deliberately not a semantic cache: an embedding lookup whose validity requires
 * exact key equality is redundant, and this router runs *after* the caller has
 * already paid for retrieval, so a hit can only save the synthesis call. The key
 * therefore includes the prompt-version-equivalent fields that make a replay
 * valid - notably the opaque `sources_digest` the search MCP sends as a Vary
 * token, so two answers grounded in different documents never collide.
 */

import { createHash } from "node:crypto";

export interface CacheEntry {
  payload: unknown;
  storedAt: number;
}

export class ResponseCache {
  private readonly store = new Map<string, CacheEntry>();
  hits = 0;
  misses = 0;

  constructor(private readonly ttlMs: number, private readonly enabled: boolean) {}

  private key(text: string): string {
    return createHash("sha256").update(text).digest("base64url").slice(0, 32);
  }

  buildKey(parts: {
    model: string;
    messages: unknown[];
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    seed?: number;
    sourcesDigest?: string;
    promptVersion: string;
  }): string {
    return this.key(
      JSON.stringify({
        // keyOrder matters for determinism across processes.
        promptVersion: parts.promptVersion,
        model: parts.model,
        messages: parts.messages,
        temperature: parts.temperature ?? null,
        top_p: parts.topP ?? null,
        max_tokens: parts.maxTokens ?? null,
        seed: parts.seed ?? null,
        sources_digest: parts.sourcesDigest ?? null,
      }),
    );
  }

  get(key: string): CacheEntry | null {
    if (!this.enabled) return null;
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.store.delete(key);
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return entry;
  }

  put(key: string, payload: unknown): void {
    if (!this.enabled) return;
    this.store.set(key, { payload, storedAt: Date.now() });
  }

  stats(): Record<string, unknown> {
    return { enabled: this.enabled, ttl_ms: this.ttlMs, entries: this.store.size, hits: this.hits, misses: this.misses };
  }
}
