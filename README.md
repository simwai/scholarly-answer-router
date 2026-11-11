# Scholarly Answer Router

A free-tier LLM router for the Scholarly Answer Engine. Walks an ordered tier list
over Kilo AI Gateway and NVIDIA NIM, OpenAI-compatible, non-streaming, single
process, zero runtime dependencies.

## What it does

```
POST /v1/chat/completions   OpenAI-shaped request + two documented router extensions
GET  /healthz               tiers, breakers, cache stats
```

`nvidia/nemotron...` and `stepfun/...` model IDs go to Kilo. `stepfun-ai/...` IDs go
to NIM. The publisher prefix is the discriminator, and it matters: the same model
is `stepfun/step-5-preview` (Kilo, **paid**) or `stepfun-ai/step-5-preview` (NIM,
**free endpoint**).

Every response carries provenance in the body:

```json
{
  "choices": [{"message": {"content": "..."}}],
  "router": {
    "model_used": "nvidia/nemotron-3.5-super-vl:free",
    "from_fallback": true,
    "cached": false,
    "cache_age_seconds": 0,
    "request_id": "req_ab12cd34",
    "tiers_attempted": ["stepfun-ai/step-5-preview", "nvidia/nemotron-3.5-super-vl:free"],
    "upstream_seconds": 36.21
  }
}
```

## Default tier list

| # | Tier | Provider | Cost | Reasoning |
|---|---|---|---|---|
| 1 | `stepfun-ai/step-5-preview` | NIM | **free endpoint** ($0/$0 per 1M, no card) | 600B MoE, 1M ctx, reasoning + tools |
| 2 | `nvidia/nemotron-3.5-super-vl:free` | Kilo | **free** | `reasoning`, `include_reasoning` |
| 3 | `kilo-auto/free` | Kilo | **free** | `reasoning` |

Tier 1 requires a free `NVIDIA_API_KEY` from <https://build.nvidia.com/settings>.
Without it the router skips straight to tier 2, which works anonymously.

**Step 5 Preview is free on NIM, not on Kilo.** Kilo also lists a Step 5 as
`stepfun/step-5-preview` at ~$1/M in — a different ID for the same model. Sending
the NIM id to Kilo returns 404.

## Setup

```bash
npm install
npm run build
npm test                                   # 43 tests, no network
node dist/index.js --check-catalog         # verify tiers against live catalogs
ROUTER_PORT=3000 node dist/index.js
```

Live model verification matters because free-tier IDs vanish without notice. The
`--check-catalog` command and `check:catalog` script both do it.

## Configuration

| Var | Default | Meaning |
|---|---|---|
| `ROUTER_PORT` / `ROUTER_HOST` | `8787` / `127.0.0.1` | listen address |
| `KILO_BASE_URL` | `https://ai-gateway.kilo.ai/api/v1` | Kilo upstream |
| `KILO_API_KEY` | unset | optional; anonymous free tier works without it |
| `NIM_BASE_URL` | `https://integrate.api.nvidia.com/v1` | NIM upstream |
| `NVIDIA_API_KEY` | unset | required for tier 1 only |
| `ROUTER_PIN` | the table above | ordered tiers, comma separated |
| `ROUTER_LAST_RESORT` | `kilo-auto/free` | appended implicit final tier |
| `ROUTER_ALLOW_FALLBACK` | `true` | allow substituting a later tier |
| `ROUTER_REASONING` | `high` | requested reasoning depth |
| `NIM_REASONING_BUDGET` | `16384` | NIM thinking budget |
| `ROUTER_ENABLE_CACHE` / `ROUTER_CACHE_TTL_MS` | `true` / `900000` | exact-key TTL cache |
| `ROUTER_EGRESS_ENABLED` | `true` | scan requests and responses for secrets |

## Design decisions

**Reasoning is per-provider, because the two upstreams disagree.** Kilo's
published request schema has no reasoning field, yet the gateway accepts
`reasoning: {effort}` or `reasoning_effort` for models that advertise it via
`supported_parameters` on `GET /models` — support is discovered per model. NIM
uses `chat_template_kwargs: {"enable_thinking": true}` plus top-level
`reasoning_budget`, and defaults `stream` to **true**, so it is set false
explicitly. Thinking returns on `message.reasoning` / `message.reasoning_content`
and is stripped.

**A reasoning-only response is not an "empty completion".** Live Kilo free tiers
return `content: null` with text in `reasoning` when they fail to answer; that is
reported distinctly so the chain advances and the cause is diagnosable.

**The cache is exact-key, not semantic.** An embedding lookup whose validity
requires exact key equality is redundant, and the router runs *after* the caller
has already paid for retrieval — so a hit can only save the synthesis call. The
key includes the caller's `sources_digest` as a Vary token, so answers grounded
in different documents never collide.

**Config errors never open a circuit.** A 400/404 (bad model ID, rejected field)
is a `config_error` surfaced to the caller, not a breaker — it will not fix
itself on retry. 429 and 503 open the breaker, which half-opens after a 60s
cooldown. Consecutive failures are halved on half-open, so tiers do not all
reopen in a synchronised burst.

**Non-streaming only.** The consumer needs the complete answer to post-check
citations. `stream: true` is rejected with a clear 400 rather than silently
ignored.

**Single instance.** Cluster mode is unsupported on win32, and multi-process
access to in-memory breaker/cache state would split the quota budget and produce
conflicting circuit states.

**Egress guardrail scans both directions.** The search MCP sends fetched paper
text in the prompt, so a credential hidden in a page can leave through the
request. Outbound scanning is the half usually forgotten.

## Tests

```
npm test   # 43 tests: config, both reasoning adapters, stripping, cache, egress,
           # tier ordering, fallback rules, breaker behaviour, HTTP surface
```

## Not in v1

Streaming, DI framework, ORM/database, vector index, multi-provider consensus,
prompt evolution, proxy rotation (no provider here benefits from it).
