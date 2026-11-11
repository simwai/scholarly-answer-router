/**
 * Egress guardrail.
 *
 * Scans BOTH directions, because the search MCP sends fetched page text in the
 * prompt: a paper's HTML can carry credentials or personal data into the
 * upstream request. Outbound scanning is the half that is usually forgotten.
 *
 * Costs no quota and protects the most fragile assets - upstream API keys and
 * the proxy credentials - so it runs on every request.
 */

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "openai-style key", re: /\bsk-[A-Za-z0-9_\-]{20,}/ },
  { name: "NVIDIA NIM key", re: /\bnvapi-[A-Za-z0-9_\-]{20,}/ },
  { name: "Kilo key", re: /\bkilo(?:code)?_[A-Za-z0-9_\-]{16,}/i },
  { name: "OpenRouter key", re: /\bsk-or-v1-[A-Za-z0-9_\-]{20,}/ },
  { name: "bearer token", re: /\bBearer\s+[A-Za-z0-9._\-]{20,}/ },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "aws access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "proxy credentials", re: /\/\/(?:[A-Za-z0-9._%+-]+:[^\s/@]+)@[A-Za-z0-9.-]+:\d{2,5}/ },
];

export interface GuardrailResult {
  action: "allow" | "reject" | "redact";
  findings: string[];
  redacted?: string;
}

export function scan(value: string): GuardrailResult {
  const findings: string[] = [];
  let redacted = value;
  for (const { name, re } of PATTERNS) {
    if (re.test(redacted)) {
      findings.push(name);
      redacted = redacted.replace(re, `[${name} redacted]`);
    }
  }
  if (!findings.length) return { action: "allow", findings: [] };
  return { action: "redact", findings, redacted };
}

export function scanSerializables(values: string[]): GuardrailResult {
  const all: string[] = [];
  let redacted: string[] = [];
  for (const value of values) {
    const result = scan(value);
    if (result.action !== "allow") {
      all.push(...result.findings);
      redacted.push(result.redacted ?? value);
    } else {
      redacted.push(value);
    }
  }
  return all.length ? { action: "redact", findings: [...new Set(all)], redacted: redacted.join("\n") } : { action: "allow", findings: [] };
}
