/**
 * OpenAI-compatible HTTP surface, hand-rolled on node:http.
 *
 * A hand-rolled route was chosen over an OpenAI-compat library because the
 * only candidate package (@ns/ai-to-openai-hono) does not exist publicly, and
 * the real surface is small. Two services (chat completions, catalog check)
 * and one intended use (non-streaming synthesis) need almost no framework.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { ResponseCache } from "./cache.js";
import { TierChain } from "./chain.js";
import type { RouterConfig } from "./config.js";
import { scan, scanSerializables } from "./egress.js";
import type { Provider } from "./providers.js";
import type { ChatMessage, RouterErrorBody } from "./types.js";

const PROMPT_VERSION = "synth-2026-11-11.1";

/**
 * Sanitize lone surrogate characters (U+D800-U+DFFF) that would produce
 * invalid JSON escapes when serialized. Search result content scraped from
 * the web can contain these, and NIM's JSON parser rejects them.
 */
function sanitizeForJSON(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForJSON);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = sanitizeForJSON(val);
    }
    return result;
  }
  return value;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(sanitizeForJSON(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function errorResponse(
  status: number,
  type: RouterErrorBody["error"]["type"],
  message: string,
  requestId: string,
  tiersAttempted?: string[],
): void {
  void status;
  void type;
  void message;
  void requestId;
  void tiersAttempted;
}

function readBody(req: IncomingMessage): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      // 10 MB is generous for a synthesis prompt carrying several papers.
      if (total > 10 * 1024 * 1024) {
        resolve({ text: "", tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), tooLarge: false }));
    req.on("error", reject);
  });
}

export function createRouter(config: RouterConfig, providers?: Provider[]) {
  const chain = new TierChain(config, providers);
  const unowned = chain.validateTiers();
  const cache = new ResponseCache(config.cacheTtlMs, config.cacheEnabled);

  // Startup smoke test: a tier nobody owns is a configuration error, and it must
  // be fatal at startup rather than a 404 on the first request.
  if (unowned.length) {
    throw new Error(
      `configured tiers are not owned by any provider: ${unowned.join(", ")}. ` +
        `Router-ownable prefixes: nvidia/, stepfun/, kilo-auto/ (Kilo); stepfun-ai/ (NVIDIA NIM).`,
    );
  }

  const server = createServer(async (req, res) => {
    const requestId = `req_${Math.random().toString(36).slice(2, 10)}`;
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/healthz") {
        json(res, 200, {
          status: "ok",
          contract_version: "1",
          prompt_version: PROMPT_VERSION,
          cache: cache.stats(),
          breakers: chain.breakerSnapshot(),
          tiers: config.pin,
          last_resort: config.lastResort,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const { text, tooLarge } = await readBody(req);
        if (tooLarge) {
          json(res, 413, {
            error: { message: "request body exceeds 10 MB", type: "invalid_request" },
          } satisfies RouterErrorBody);
          return;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(text || "{}") as Record<string, unknown>;
        } catch {
          json(res, 400, {
            error: { message: "body is not valid JSON", type: "invalid_request" },
          } satisfies RouterErrorBody);
          return;
        }

        const messages = parsed.messages as ChatMessage[] | undefined;
        const model = typeof parsed.model === "string" ? parsed.model : "";
        if (!Array.isArray(messages) || !messages.length) {
          json(res, 400, {
            error: { message: "`messages` must be a non-empty array", type: "invalid_request", param: "messages" },
          } satisfies RouterErrorBody);
          return;
        }
        if (parsed.stream === true) {
          // Non-streaming only in v1: the consumer needs the whole answer to
          // post-check citations, and streaming would add SSE proxying,
          // stream-duration proxy pinning and partial-failure semantics.
          json(res, 400, {
            error: { message: "streaming is not supported by this router (v1 is non-streaming only)", type: "invalid_request", param: "stream" },
          } satisfies RouterErrorBody);
          return;
        }

        // Egress scan on the way out: the search MCP sends fetched page text,
        // which can carry secrets or personal data.
        if (config.egressEnabled) {
          const findings = scanSerializables(messages.map((m) => m.content ?? ""));
          if (findings.action === "reject") {
            json(res, 400, {
              error: {
                message: `request blocked by egress guardrail: ${findings.findings.join(", ")}`,
                type: "invalid_request",
              },
            } satisfies RouterErrorBody);
            return;
          }
          if (findings.action === "redact") {
            for (const [index, message] of messages.entries()) {
              const replacement = findings.redacted?.split("\n")[index];
              if (replacement !== undefined) message.content = replacement;
            }
            console.warn(`[${requestId}] egress guardrail redacted: ${findings.findings.join(", ")}`);
          }
        }

        const sourcesDigest = typeof parsed.sources_digest === "string" ? parsed.sources_digest : undefined;
        const cacheKey = cache.buildKey({
          model,
          messages,
          temperature: parsed.temperature as number | undefined,
          topP: parsed.top_p as number | undefined,
          maxTokens: parsed.max_tokens as number | undefined,
          seed: parsed.seed as number | undefined,
          sourcesDigest,
          promptVersion: PROMPT_VERSION,
        });

        const hit = cache.get(cacheKey);
        if (hit) {
          const payload = { ...(hit.payload as Record<string, unknown>), router: { ...((hit.payload as { router?: Record<string, unknown> }).router ?? {}), cached: true, cache_age_seconds: Math.round((Date.now() - hit.storedAt) / 1000), request_id: requestId } };
          json(res, 200, payload);
          return;
        }

        const result = await chain.run(
          messages,
          parsed.temperature as number | undefined,
          parsed.top_p as number | undefined,
          parsed.max_tokens as number | undefined,
          parsed.seed as number | undefined,
        );

        // Egress scan on the way back: a leaked upstream key in an error string
        // would otherwise be forwarded verbatim.
        if (config.egressEnabled) {
          const findings = scan(result.content);
          if (findings.action !== "allow") {
            console.warn(`[${requestId}] egress guardrail redacted response: ${findings.findings.join(", ")}`);
            result.content = findings.redacted ?? result.content;
          }
        }

        const payload = {
          id: requestId,
          object: "chat.completion" as const,
          created: Math.floor(Date.now() / 1000),
          model: result.modelUsed,
          choices: [{ index: 0, message: { role: "assistant" as const, content: result.content }, finish_reason: "stop" as const }],
          usage: result.usage,
          router: {
            model_used: result.modelUsed,
            from_fallback: result.fromFallback,
            cached: false,
            cache_age_seconds: 0,
            request_id: requestId,
            tiers_attempted: result.tiersAttempted,
            upstream_seconds: Math.round(result.upstreamSeconds * 100) / 100,
          },
        };
        cache.put(cacheKey, payload);
        json(res, 200, payload);
        return;
      }

      json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}`, type: "invalid_request" } } satisfies RouterErrorBody);
    } catch (err) {
      const error = err as Error & { tiersAttempted?: string[]; type?: string };
      console.error(`[${requestId}] unhandled:`, error);
      const status = error.type === "pinned_unavailable" ? 503 : 500;
      json(res, status, {
        error: {
          message: error.message || "internal error",
          type: (error.type as RouterErrorBody["error"]["type"]) ?? "upstream_timeout",
          tiers_attempted: error.tiersAttempted,
        },
        router: { request_id: requestId },
      } satisfies RouterErrorBody);
    }
  });

  // A bind failure must be a legible startup error, not an unhandled 'error'
  // event that dumps a stack trace and exits.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" || err.code === "EACCES") {
      console.error(
        `cannot bind ${config.host}:${config.port} (${err.code}): the port is unavailable or restricted by the host. ` +
          `Set ROUTER_PORT to another value.`,
      );
    } else {
      console.error(`server error: ${err.message}`);
    }
    process.exit(2);
  });

  return { server, chain, cache };
}


