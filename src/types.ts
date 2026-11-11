/**
 * Wire types. The surface is OpenAI-shaped plus documented router extensions,
 * declared as such rather than pretending to be pure OpenAI compatibility.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  seed?: number;
  /** Router extension: opaque grounding token from the search MCP. */
  sources_digest?: string;
  /** Router extension: why this call is happening. */
  purpose?: string;
}

export interface RouterProvenance {
  model_used: string;
  from_fallback: boolean;
  cached: boolean;
  cache_age_seconds: number;
  request_id: string;
  /** Ordered list of tiers attempted, for diagnostics. */
  tiers_attempted: string[];
  /** Seconds spent on the winning upstream call. */
  upstream_seconds: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop" | "length";
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  router: RouterProvenance;
}

export interface RouterErrorBody {
  error: {
    message: string;
    type: "pinned_unavailable" | "upstream_rate_limited" | "upstream_timeout" | "config_error" | "invalid_request";
    param?: string;
    tiers_attempted?: string[];
  };
  router?: { request_id: string };
}
