import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface PriorConfig {
  /** Master switch for prior assistance. */
  enabled: boolean;
  /** Debug mode: record every consultation and measure contribution. */
  debug: boolean;
  /** Model id on the configured prior endpoint. */
  model: string;
  /** Prior endpoint URL. */
  endpoint: string;
  /** Confidence below this (0-1) is flagged as low-confidence; 0 disables the flag. */
  threshold: number;
  /** Maximum number of options per question. */
  maxOptions: number;
  /** Consultation policy: "conservative" = consult on real decision points, "eager" = consult on any judgment call. */
  mode: "conservative" | "eager";
  /** Recent session messages auto-included in the prior's state for grounding; 0 disables. */
  contextMessages: number;
  /** cc-switch provider id used for API key lookup. */
  providerId: string;
  /** Explicit API key override (wins over env + cc-switch lookup). */
  apiKey?: string;
}

export const DEFAULT_CONFIG: PriorConfig = {
  enabled: false,
  debug: false,
  // All endpoint/model/credential defaults are intentionally left empty in
  // the open-source version: the protocol details are redacted on purpose.
  // Configure them via ~/.pi/decision-prior.json, /prior set ..., or JEV_API_KEY.
  model: "",
  endpoint: "",
  threshold: 0,
  maxOptions: 8,
  mode: "conservative",
  contextMessages: 6,
  providerId: "",
};

export const CONFIG_KEYS = [
  "model",
  "endpoint",
  "threshold",
  "maxOptions",
  "mode",
  "contextMessages",
  "providerId",
  "apiKey",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function configPath(): string {
  return join(homedir(), ".pi", "decision-prior.json");
}

/** Legacy path used before the neutral rename; still read for migration. */
export function legacyConfigPath(): string {
  return join(homedir(), ".pi", "jev-assistant.json");
}

export function debugLogPath(): string {
  return join(homedir(), ".pi", "decision-prior-debug.jsonl");
}

export async function loadConfig(): Promise<PriorConfig> {
  const cfg = { ...DEFAULT_CONFIG };
  // Prefer the neutral-named config; fall back to the legacy jev-assistant.json
  // so pre-rename installations keep working.
  let raw: string | null = null;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch {
    try {
      raw = await readFile(legacyConfigPath(), "utf8");
    } catch {
      raw = null;
    }
  }
  if (raw) {
    const parsed = JSON.parse(raw) as Partial<PriorConfig>;
    for (const key of CONFIG_KEYS) {
      if (parsed[key] !== undefined) {
        (cfg as Record<string, unknown>)[key] = parsed[key];
      }
    }
    if (parsed.enabled !== undefined) cfg.enabled = Boolean(parsed.enabled);
    if (parsed.debug !== undefined) cfg.debug = Boolean(parsed.debug);
  }
  return cfg;
}

export async function saveConfig(cfg: PriorConfig): Promise<void> {
  const path = configPath();
  await mkdir(join(path, ".."), { recursive: true });
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) out[key] = cfg[key];
  out.enabled = cfg.enabled;
  out.debug = cfg.debug;
  await writeFile(path, JSON.stringify(out, null, 2) + "\n", "utf8");
}
