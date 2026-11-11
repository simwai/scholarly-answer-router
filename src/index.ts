/**
 * Entry point. Single process, single instance.
 *
 * Cluster mode is unsupported on this host (win32) and multi-process access to
 * shared in-memory breaker/cache state would split the quota budget, so the API
 * and any background work share one process.
 */

import { loadConfig } from "./config.js";
import { createRouter } from "./server.js";

async function checkCatalog(): Promise<number> {
  const config = loadConfig();
  const { chain } = createRouter(config);
  const unowned = chain.validateTiers();
  if (unowned.length) {
    console.error(`configured tiers not owned by any provider: ${unowned.join(", ")}`);
    return 1;
  }

  const kiloModels = await fetch(`${config.kiloBaseUrl}/models`, {
    headers: config.kiloApiKey ? { Authorization: `Bearer ${config.kiloApiKey}` } : {},
  })
    .then((r) => (r.ok ? (r.json() as Promise<{ data?: Array<Record<string, unknown>> }>) : null))
    .catch(() => null);
  const kiloIds = new Set((kiloModels?.data ?? []).map((m) => String(m.id)));

  const nimModels = await fetch(`${config.nimBaseUrl}/models`)
    .then((r) => (r.ok ? (r.json() as Promise<{ data?: Array<Record<string, unknown>> }>) : null))
    .catch(() => null);
  const nimIds = new Set((nimModels?.data ?? []).map((m) => String(m.id)));

  let problems = 0;
  for (const tier of config.pin) {
    const onKilo = kiloIds.has(tier);
    const onNim = nimIds.has(tier);
    if (onKilo) console.log(`  OK  ${tier} (Kilo)`);
    else if (onNim) console.log(`  OK  ${tier} (NIM)`);
    else {
      console.error(`  MISSING  ${tier} (not in Kilo or NIM catalogs)`);
      problems += 1;
    }
  }
  for (const tier of [config.lastResort]) {
    if (!kiloIds.has(tier) && !nimIds.has(tier)) {
      console.error(`  MISSING  last resort ${tier}`);
      problems += 1;
    }
  }

  if (problems) {
    console.error(`${problems} configured tier(s) do not resolve; check the live catalogs.`);
    return 1;
  }
  console.log("all configured tiers resolve against the live catalogs.");
  return 0;
}

async function main(): Promise<void> {
  if (process.argv.includes("--check-catalog")) {
    process.exit(await checkCatalog());
  }

  const config = loadConfig();

  let router: ReturnType<typeof createRouter>;
  try {
    router = createRouter(config);
  } catch (err) {
    console.error(`startup failed: ${(err as Error).message}`);
    process.exit(2);
  }

  router.server.listen(config.port, config.host, () => {
    console.log(`router listening on http://${config.host}:${config.port}`);
    console.log(`tiers: ${[...config.pin, config.lastResort].join(" -> ")}`);
    console.log(`reasoning: ${config.reasoning} (Kilo via supported_parameters; NIM via chat_template_kwargs + reasoning_budget)`);
    console.log("POST /v1/chat/completions   GET /healthz   (non-streaming only)");
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      router.server.close(() => process.exit(0));
    });
  }
}

await main();
