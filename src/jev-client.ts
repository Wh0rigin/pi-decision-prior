import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { PriorConfig } from "./config";

export interface PriorUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface PriorConsultResult {
  model: string;
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * Resolve the prior API key. Order:
 * 1. explicit config override
 * 2. JEV_API_KEY environment variable
 * 3. apiKey field inside the cc-switch provider settings (SQLite db)
 */
export async function resolveApiKey(cfg: PriorConfig): Promise<string | null> {
  if (cfg.apiKey) return cfg.apiKey;
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  return keyFromCcSwitch(cfg.providerId);
}

async function keyFromCcSwitch(providerId: string): Promise<string | null> {
  const dbPath = join(homedir(), ".cc-switch", "cc-switch.db");
  // Preferred: real SQLite access (Node >= 22.5) to a local credential store.
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT settings_config FROM providers WHERE id = ?")
        .get(providerId) as { settings_config?: string } | undefined;
      if (row?.settings_config) {
        const parsed = JSON.parse(row.settings_config) as { apiKey?: string };
        if (parsed.apiKey) return parsed.apiKey;
      }
    } finally {
      db.close();
    }
  } catch {
    // Fall through to raw scan.
  }
  // Fallback: scan the raw db file for the provider's apiKey field.
  try {
    const raw = await readFile(dbPath, "utf8");
    const marker = JSON.stringify(providerId).slice(1, -1);
    const idx = raw.indexOf(marker);
    if (idx >= 0) {
      const slice = raw.slice(idx, idx + 2000);
      const m = slice.match(/"apiKey":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse(`"${m[1]}"`) as string;
    }
  } catch {
    // Ignore: no key found.
  }
  return null;
}

/**
 * Consult the configured prior model through a proprietary relay protocol (POST; bearer auth).
 * The endpoint URL, payload shape, and model id are intentionally redacted
 * from the open-source distribution — configure them locally via /prior set.
 */
export async function consultPrior(
  cfg: PriorConfig,
  question: string,
  options: string[],
  state: string,
  signal?: AbortSignal,
): Promise<PriorConsultResult> {
  const apiKey = await resolveApiKey(cfg);
  if (!apiKey) {
    throw new Error(
      "No prior API key found. Set one via `/prior set apiKey <key>`, the JEV_API_KEY env var, or your local credential store.",
    );
  }

  const criteria: Record<string, string> = {};
  for (const opt of options) {
    criteria[opt] = `Choose '${opt}' only if it best satisfies the question.`;
  }

  const payload = {
    model: cfg.model,
    state: state || "Decision support for a coding assistant.",
    questions: {
      q: {
        type: "choice",
        question,
        options,
        criteria,
      },
    },
  };

  if (!cfg.endpoint || !cfg.model) {
    throw new Error(
      "Prior endpoint/model are not configured (intentionally absent from the open-source distribution). " +
        "Set them via `/prior set endpoint <url>` and `/prior set model <id>` in your local config."
    );
  }

  const started = Date.now();
  const response = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`prior request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    model?: string;
    answers?: Record<
      string,
      { choice?: string; confidence?: number; probabilities?: Record<string, number> }
    >;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const answer = data.answers?.q;
  if (!answer || answer.choice === undefined) {
    throw new Error(`prior returned no answer: ${JSON.stringify(data).slice(0, 300)}`);
  }

  return {
    model: data.model ?? cfg.model,
    choice: answer.choice,
    confidence: answer.confidence ?? 0,
    probabilities: answer.probabilities ?? {},
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    latencyMs: Date.now() - started,
  };
}
