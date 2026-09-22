export interface ConsultRecord {
  ts: number;
  turnIndex: number | null;
  question: string;
  state: string;
  options: string[];
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  /** Normalized Shannon entropy of the distribution (0 = certain, 1 = uniform). */
  entropy: number;
  /** Top probability minus runner-up probability. */
  margin: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  lowConfidence: boolean;
  /** Did the assistant's turn act on jev's top choice? null = undetermined. */
  followed: boolean | null;
  /** Did the turn clearly pick a different option? */
  overridden: boolean | null;
}

export function normalizedEntropy(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities).filter((p) => p > 0);
  if (values.length < 2) return 0;
  let h = 0;
  for (const p of values) h -= p * Math.log(p);
  return h / Math.log(values.length);
}

export function topMargin(probabilities: Record<string, number>): number {
  const sorted = Object.values(probabilities).sort((a, b) => b - a);
  return (sorted[0] ?? 0) - (sorted[1] ?? 0);
}

export interface JevStats {
  total: number;
  resolved: number;
  followedRate: number | null;
  overriddenRate: number | null;
  avgConfidence: number;
  avgEntropy: number;
  avgMargin: number;
  lowConfidenceCount: number;
  decisiveCount: number;
  tokens: number;
  avgLatencyMs: number;
}

/**
 * Aggregate stats. "decisive" = jev gave a clear signal (margin >= 0.4).
 * Entropy close to 1 means the decision was genuinely uncertain, so a
 * consultation there actually contributed information.
 */
export function summarize(records: ConsultRecord[]): JevStats {
  const resolved = records.filter((r) => r.followed !== null);
  const followed = resolved.filter((r) => r.followed === true).length;
  const overridden = resolved.filter((r) => r.overridden === true).length;
  const n = records.length || 1;
  return {
    total: records.length,
    resolved: resolved.length,
    followedRate: resolved.length ? followed / resolved.length : null,
    overriddenRate: resolved.length ? overridden / resolved.length : null,
    avgConfidence: records.reduce((s, r) => s + r.confidence, 0) / n,
    avgEntropy: records.reduce((s, r) => s + r.entropy, 0) / n,
    avgMargin: records.reduce((s, r) => s + r.margin, 0) / n,
    lowConfidenceCount: records.filter((r) => r.lowConfidence).length,
    decisiveCount: records.filter((r) => r.margin >= 0.4).length,
    tokens: records.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0),
    avgLatencyMs: records.reduce((s, r) => s + r.latencyMs, 0) / n,
  };
}

export function formatStats(stats: JevStats): string {
  const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
  return [
    `consultations: ${stats.total} (resolved/followed check: ${stats.resolved})`,
    `followed rate: ${pct(stats.followedRate)}  overridden: ${pct(stats.overriddenRate)}`,
    `avg confidence: ${stats.avgConfidence.toFixed(2)}  avg margin: ${stats.avgMargin.toFixed(2)}`,
    `avg normalized entropy: ${stats.avgEntropy.toFixed(2)} (1.0 = genuinely uncertain question)`,
    `decisive calls (margin>=0.4): ${stats.decisiveCount}  low-confidence flags: ${stats.lowConfidenceCount}`,
    `jev token overhead: ${stats.tokens}  avg latency: ${Math.round(stats.avgLatencyMs)}ms`,
  ].join("\n");
}
