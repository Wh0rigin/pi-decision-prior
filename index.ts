import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  debugLogPath,
  loadConfig,
  saveConfig,
  type ConfigKey,
  type PriorConfig,
} from "./src/config";
import { consultPrior } from "./src/prior-client";
import {
  formatStats,
  normalizedEntropy,
  summarize,
  topMargin,
  type ConsultRecord,
} from "./src/stats";

const ENTRY_TYPE = "prior-consult";
const MESSAGE_TYPE = "prior-ask";
const TOOL_NAME = "prior_consult";

export default function decisionPrior(pi: ExtensionAPI) {
  let cfg: PriorConfig = { ...DEFAULT_CONFIG };
  let records: ConsultRecord[] = [];
  let currentTurn: number | null = null;
  const flushed = new Set<number>();

  // ---------- helpers ----------

  function updateUi(ctx: { ui: ExtensionContextUi }) {
    ctx.ui.setStatus("prior", cfg.enabled ? `prior:${cfg.debug ? "on+debug" : "on"}` : "");
    ctx.ui.setWidget(
      "prior",
      cfg.debug && records.length > 0
        ? [
            `prior debug: ${records.length} consult | last: "${records[records.length - 1].question.slice(0, 40)}" -> ${records[records.length - 1].choice} (${records[records.length - 1].confidence})`,
          ]
        : [],
    );
  }

  function applyToolAvailability() {
    try {
      const active = pi.getActiveTools();
      if (cfg.enabled) {
        if (!active.includes(TOOL_NAME)) pi.setActiveTools([...active, TOOL_NAME]);
      } else if (active.includes(TOOL_NAME)) {
        pi.setActiveTools(active.filter((n) => n !== TOOL_NAME));
      }
    } catch {
      // Tool registry not ready yet (early session_start); tool is registered anyway.
    }
  }

  function debugBar(p: number, width = 16): string {
    const filled = Math.round(p * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
  }

  function recordToEntryText(r: ConsultRecord, expanded: boolean): string {
    const sorted = Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]);
    let text =
      `prior [${r.model}] Q: ${r.question}\n` +
      sorted.map(([opt, p]) => `  ${debugBar(p)} ${p.toFixed(2)}  ${opt}`).join("\n") +
      `\n  -> ${r.choice} (confidence ${r.confidence.toFixed(2)}, margin ${r.margin.toFixed(2)}, entropy ${r.entropy.toFixed(2)})`;
    if (expanded) {
      text +=
        `\n  state: ${r.state || "(none)"} | tokens: ${r.inputTokens}+${r.outputTokens} | ${r.latencyMs}ms | turn ${r.turnIndex ?? "?"}` +
        (r.followed === null ? "" : `\n  contribution: ${r.followed ? "followed" : r.overridden ? "overridden" : "no action"}`);
    }
    return text;
  }

  async function flushDebugLog() {
    const { appendFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const path = debugLogPath();
    const pending = records.filter((r) => !flushed.has(r.ts));
    if (pending.length === 0) return;
    const lines = pending.map((r) => JSON.stringify(r));
    for (const r of pending) flushed.add(r.ts);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, lines.join("\n") + "\n", "utf8");
  }

  // ---------- lifecycle ----------

  pi.on("session_start", async (_event, ctx) => {
    cfg = await loadConfig();
    records = [];
    flushed.clear();
    applyToolAvailability();
    updateUi(ctx);
  });

  pi.on("turn_start", async (event) => {
    currentTurn = event.turnIndex;
  });

  pi.on("turn_end", async (event, ctx) => {
    const turnRecords = records.filter(
      (r) => r.turnIndex === event.turnIndex && r.followed === null,
    );
    if (turnRecords.length === 0) return;

    // Heuristic contribution check: does the assistant's text or any tool
    // result from this turn act on the prior's chosen option?
    const texts: string[] = [];
    const msg = event.message as { content?: unknown } | undefined;
    if (msg?.content) {
      if (typeof msg.content === "string") texts.push(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const b = block as { type?: string; text?: string };
          if (b?.type === "text" && b.text) texts.push(b.text);
        }
      }
    }
    if (event.toolResults) {
      texts.push(JSON.stringify(event.toolResults));
    }
    const haystack = texts.join("\n").toLowerCase();

    for (const r of turnRecords) {
      const choice = r.choice.toLowerCase();
      if (haystack.includes(choice)) {
        r.followed = true;
      } else if (r.options.some((o) => o.toLowerCase() !== choice && haystack.includes(o.toLowerCase()))) {
        r.followed = false;
        r.overridden = true;
      }
      r.overridden = r.overridden ?? (r.followed === false);
    }
    if (cfg.debug) await flushDebugLog();
    updateUi(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!cfg.enabled) return;
    const decisionRule =
      cfg.mode === "eager"
        ? `- Default to consulting: for any judgment call this turn — including binary yes/no questions and either/or readings — call prior_consult first with a faithful option set before committing to a position. Frame yes/no questions as two options (e.g. options: ["yes", "no"]). If you are unsure whether a decision is worth consulting, consult. If the prior's distribution clearly would not change your action, you may proceed without dwelling on it.`
        : `- At the start of this turn, identify the key decision points of the task. Whenever acting requires choosing among ${2}-${cfg.maxOptions} discrete options (approach, library, design, interpretation of ambiguous instructions, next action), you MUST call prior_consult BEFORE acting on that choice. Yes/no questions count too: when the answer hinges on a factual or design judgment, frame them as two options (e.g. options: ["yes", "no"]) and consult.`;
    const uncertaintyRule =
      cfg.threshold > 0
        ? `- If the prior's top confidence is below ${cfg.threshold}, treat the decision as uncertain: say so and surface the top alternatives to the user before acting.`
        : `- Treat a split distribution (low margin or high entropy) as a signal that the decision is genuinely uncertain; reflect that uncertainty in your answer in proportion to how consequential the decision is.`;
    const section =
      `\n\n<decision-prior enabled mode="${cfg.mode}">\n` +
      `The prior_consult tool is active for this turn. The configured prior is a probabilistic model: given a question and discrete options, it returns a probability distribution over the options.\n` +
      decisionRule + `\n` +
      uncertaintyRule + `\n` +
      `- Weigh the prior's distribution as one input alongside your own analysis; they usually agree, and disagreement is a signal to think harder.\n` +
      `- If the prior's top confidence is below ${cfg.threshold}, treat the decision as uncertain: say so and surface the top alternatives to the user before acting.\n` +
      `- In your final answer, briefly note which decisions were cross-checked with the prior and cite its top probability.\n` +
      `- Prior output is advisory. Do not report probabilities as ground truth; state them as model estimates.\n` +
      `</decision-prior>`;
    return { systemPrompt: event.systemPrompt + section };
  });

  pi.on("session_shutdown", async () => {
    if (cfg.debug) {
      try {
        await flushDebugLog();
      } catch {
        // Best effort.
      }
    }
  });

  // ---------- shared consult flow (tool + /prior ask) ----------

  interface SessionBranchEntry {
    type?: string;
    message?: { role?: string; content?: unknown };
  }

  function extractMessageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => {
          const block = b as { type?: string; text?: string };
          return block?.type === "text" && block.text ? block.text : "";
        })
        .filter(Boolean)
        .join(" ");
    }
    return "";
  }

  /** Pull the last N user/assistant messages from the session for grounding. */
  function buildSessionContext(ctx: ExtensionContextUi): string {
    if (cfg.contextMessages <= 0) return "";
    try {
      const sm = (ctx as { sessionManager?: { getBranch?: () => SessionBranchEntry[] } })
        .sessionManager;
      if (!sm?.getBranch) return "";
      const msgs = sm
        .getBranch()
        .filter((e) => e.type === "message" && e.message && (e.message.role === "user" || e.message.role === "assistant"))
        .slice(-cfg.contextMessages);
      const parts = msgs.map((e) => `${e.message!.role}: ${extractMessageText(e.message!.content).slice(0, 600)}`);
      return parts.join("\n").slice(-4000);
    } catch {
      return "";
    }
  }

  async function runConsult(
    question: string,
    options: string[],
    state: string,
    ctx: ExtensionContextUi,
    signal?: AbortSignal,
    llmContext?: string,
  ): Promise<{ record: ConsultRecord; text: string }> {
    const autoContext = buildSessionContext(ctx);
    const stateParts = [
      llmContext ? `Decision context from the assistant:\n${llmContext.slice(0, 2000)}` : "",
      autoContext ? `Recent conversation for grounding:\n${autoContext}` : "",
      state,
    ].filter(Boolean);
    const composedState = stateParts.join("\n\n").slice(0, 6000);
    const result = await consultPrior(cfg, question, options, composedState, signal);

    const record: ConsultRecord = {
      ts: Date.now(),
      turnIndex: currentTurn,
      question,
      state: composedState,
      options,
      choice: result.choice,
      confidence: result.confidence,
      probabilities: result.probabilities,
      entropy: normalizedEntropy(result.probabilities),
      margin: topMargin(result.probabilities),
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      lowConfidence: result.confidence < cfg.threshold,
      followed: null,
      overridden: false,
    };
    records.push(record);

    const sorted = Object.entries(result.probabilities).sort((a, b) => b[1] - a[1]);
    const distLines = sorted
      .map(([opt, p]) => `  ${opt}: ${p.toFixed(2)}`)
      .join("\n");
    // Distribution-driven guidance: characterize the shape, let the model
    // decide how much weight to give it based on the stakes of the decision.
    const guidance = record.margin < 0.2 || record.entropy > 0.8
      ? `the prior is split on this (top p=${result.confidence.toFixed(2)}, margin ${record.margin.toFixed(2)}, entropy ${record.entropy.toFixed(2)}): no strong opinion. Factor the uncertainty into your reasoning in proportion to how consequential the decision is.`
      : `the prior leans toward "${result.choice}" (p=${result.confidence.toFixed(2)}, margin ${record.margin.toFixed(2)}). Weigh this prior against your own analysis; disagreement is a signal to think harder.`;

    if (cfg.debug) {
      pi.appendEntry(ENTRY_TYPE, record);
      updateUi(ctx);
    }

    const text =
      `prior model probabilities for: ${question}\n${distLines}\n` +
      `top choice: ${result.choice} (confidence ${result.confidence.toFixed(2)})\n` +
      `${guidance}\n` +
      `Note: these are model estimates, not ground truth.`;
    return { record, text };
  }

  // ---------- tool ----------

  pi.registerTool({
    name: TOOL_NAME,
    label: "Prior Consult",
    description:
      `Ask the configured probabilistic prior model for a probability distribution over discrete options. ` +
      `Returns each option's probability plus the top choice and its confidence. ` +
      `Use it as a decision prior when facing 2-${cfg.maxOptions} discrete alternatives; ` +
      `yes/no questions count as two options (use ["yes", "no"]). ` +
      `Recent session history is sent to the prior model automatically; use the context parameter for decision-specific background. ` +
      `Also available via /prior ask.`,
    promptSnippet:
      "Consult the configured prior model for a probability distribution over discrete decision options",
    promptGuidelines: [
      `Use prior_consult BEFORE acting on any choice among discrete options (libraries, approaches, designs, interpretations, next actions); yes/no questions count as two options (["yes", "no"]); pass decision-specific facts via the context parameter and cite the prior's top probability when you decide.`,
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The decision question to evaluate" }),
      options: Type.Array(Type.String(), {
        description: "The discrete candidate options (2-8)",
      }),
      state: Type.Optional(
        Type.String({
          description: "Short context about the current situation for the prior model",
        }),
      ),
      context: Type.Optional(
        Type.String({
          description:
            "Relevant background that grounds the decision: constraints, prior findings, code facts, user preferences. Session history is included automatically; pass only decision-specific facts here.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!cfg.enabled) {
        return {
          content: [
            {
              type: "text",
              text: "Prior assistance is currently disabled. Continue with your own judgment, or ask the user to run /prior on.",
            },
          ],
          details: { disabled: true },
        };
      }
      const options = params.options.map((o) => String(o)).filter(Boolean);
      if (options.length < 2) {
        throw new Error("prior_consult needs at least 2 options");
      }
      if (options.length > cfg.maxOptions) {
        throw new Error(`prior_consult supports at most ${cfg.maxOptions} options`);
      }

      const { record, text } = await runConsult(
        params.question,
        options,
        params.state ?? "",
        ctx,
        signal ?? undefined,
        params.context,
      );
      return { content: [{ type: "text", text }], details: record };
    },
    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const q = String((args as { question?: string })?.question ?? "");
      text.setText(theme.fg("toolTitle", theme.bold("prior_consult ")) + theme.fg("muted", q.slice(0, 60)));
      return text;
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "consulting prior model..."));
        return text;
      }
      const record = result.details as ConsultRecord | undefined;
      if (!record) {
        const raw = result.content?.find((c) => c.type === "text") as
          | { text?: string }
          | undefined;
        text.setText(theme.fg("dim", raw?.text ?? ""));
        return text;
      }
      const color = record.lowConfidence ? "warning" : "success";
      text.setText(theme.fg(color, recordToEntryText(record, expanded)));
      return text;
    },
  });

  // ---------- command ----------

  const SUBS = ["on", "off", "ask", "status", "test", "debug", "set", "reset-stats", "help"];

  const priorCommand = {
    description: "Toggle prior-model decision assistance (/prior on|off|status|debug|set|test)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items: AutocompleteItem[] = [
        ...SUBS.map((s) => ({ value: s, label: s })),
        ...(prefix.startsWith("debug ")
          ? ["on", "off", "log", "summary"].map((s) => ({
              value: `debug ${s}`,
              label: `debug ${s}`,
            }))
          : []),
        ...(prefix.startsWith("set ")
          ? CONFIG_KEYS.map((k) => ({ value: `set ${k}`, label: `set ${k}` }))
          : []),
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      if (prefix.startsWith("set mode")) {
        const values = ["eager", "conservative"]
          .filter((v) => `set mode ${v}`.startsWith(prefix.trimEnd() + " ") || ("set mode " + v).startsWith(prefix) || prefix === "set mode" || prefix === "set mode ")
          .map((v) => ({
            value: `set mode ${v}`,
            label: `set mode ${v}  (consultation policy)`,
          }));
        if (values.length > 0) return values;
      }
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "";

      if (sub === "" ) {
        cfg.enabled = !cfg.enabled;
        await saveConfig(cfg);
        applyToolAvailability();
        updateUi(ctx);
        ctx.ui.notify(
          cfg.enabled
            ? `Prior assistance ENABLED (model: ${cfg.model}, threshold: ${cfg.threshold})`
            : "Prior assistance DISABLED",
          "info",
        );
        return;
      }

      if (sub === "on" || sub === "off") {
        cfg.enabled = sub === "on";
        await saveConfig(cfg);
        applyToolAvailability();
        updateUi(ctx);
        ctx.ui.notify(`Prior assistance ${cfg.enabled ? "ENABLED" : "DISABLED"}`, "info");
        return;
      }

      if (sub === "debug") {
        const arg = parts[1] ?? "";
        if (arg === "log") {
          if (records.length === 0) {
            ctx.ui.notify("No prior consultations recorded yet", "info");
            return;
          }
          const recent = records.slice(-15).reverse().map(recordToEntryText);
          await ctx.ui.select(`Recent prior consultations (${records.length} total, log: ${debugLogPath()})`, recent);
          return;
        }
        if (arg === "summary") {
          ctx.ui.notify(
            records.length === 0
              ? "No prior consultations recorded yet"
              : `Prior contribution summary:\n${formatStats(summarize(records))}`,
            "info",
          );
          return;
        }
        cfg.debug = arg === "on" ? true : arg === "off" ? false : !cfg.debug;
        await saveConfig(cfg);
        updateUi(ctx);
        ctx.ui.notify(
          cfg.debug
            ? `Prior debug ON — consultations are logged to ${debugLogPath()}`
            : "Prior debug OFF",
          "info",
        );
        return;
      }

      if (sub === "set") {
        const key = parts[1] as ConfigKey | undefined;
        const value = parts.slice(2).join(" ");
        if (!key || !CONFIG_KEYS.includes(key) || value === "") {
          ctx.ui.notify(
            `Usage: /prior set <key> <value>\nKeys: ${CONFIG_KEYS.join(", ")}`,
            "warning",
          );
          return;
        }
        if (key === "threshold" || key === "maxOptions" || key === "contextMessages") {
          const num = Number(value);
          if (Number.isNaN(num) || num <= 0) {
            ctx.ui.notify(`${key} must be a positive number`, "error");
            return;
          }
          if (key === "threshold" && (num < 0 || num > 1)) {
            ctx.ui.notify("threshold must be between 0 and 1 (0 disables gating)", "error");
            return;
          }
          (cfg as unknown as Record<string, number>)[key] = num;
        } else if (key === "mode") {
          if (value !== "eager" && value !== "conservative") {
            ctx.ui.notify("mode must be 'eager' or 'conservative'", "error");
            return;
          }
          cfg.mode = value;
        } else {
          (cfg as unknown as Record<string, string>)[key] = value;
        }
        await saveConfig(cfg);
        applyToolAvailability();
        updateUi(ctx);
        ctx.ui.notify(`prior ${key} = ${value}`, "info");
        return;
      }

      if (sub === "status") {
        let toolActive = false;
        try {
          toolActive = pi.getActiveTools().includes(TOOL_NAME);
        } catch {
          // Tool registry not ready.
        }
        const stats = summarize(records);
        ctx.ui.notify(
          `decision-prior status\n` +
            `enabled: ${cfg.enabled} | debug: ${cfg.debug} | mode: ${cfg.mode} | tool active: ${toolActive}\n` +
            `model: ${cfg.model} | endpoint: ${cfg.endpoint}\n` +
            `threshold: ${cfg.threshold === 0 ? "0 (off, distribution-driven)" : cfg.threshold + " (hard gating)"} | maxOptions: ${cfg.maxOptions} | contextMessages: ${cfg.contextMessages}\n` +
            `key source: ${cfg.apiKey ? "config" : process.env.JEV_API_KEY ? "JEV_API_KEY" : `cc-switch:${cfg.providerId}`}\n` +
            (records.length ? `\n${formatStats(stats)}\nlog: ${debugLogPath()}` : "\n(no consultations yet this session)"),
          "info",
        );
        return;
      }

      if (sub === "reset-stats") {
        records = [];
        flushed.clear();
        updateUi(ctx);
        ctx.ui.notify("prior stats cleared", "info");
        return;
      }

      if (sub === "ask") {
        const rest = args.trim().slice(3).trim();
        const segs = rest.split("|").map((s) => s.trim()).filter(Boolean);
        if (segs.length < 3) {
          ctx.ui.notify(
            'Usage: /prior ask "question" | option1 | option2 | ...',
            "warning",
          );
          return;
        }
        const [question, ...options] = segs;
        if (options.length > cfg.maxOptions) {
          ctx.ui.notify(`the prior supports at most ${cfg.maxOptions} options`, "error");
          return;
        }
        ctx.ui.notify("Consulting prior model...", "info");
        try {
          const { record, text } = await runConsult(
            question,
            options,
            "Manual consult via /prior ask.",
            ctx,
          );
          pi.sendMessage(
            { customType: MESSAGE_TYPE, content: text, display: true, details: record },
            { triggerTurn: true },
          );
        } catch (err) {
          ctx.ui.notify(`prior ask failed: ${(err as Error).message}`, "error");
        }
        return;
      }

      if (sub === "test") {
        ctx.ui.notify("Consulting the prior model with a test question...", "info");
        try {
          const result = await consultPrior(
            cfg,
            "A fair six-sided die is rolled once. What is the probability of rolling an even number?",
            ["1/2", "1/3", "2/3", "1/6"],
            "Connectivity test for the pi decision-prior extension (tested with the jev instance).",
          );
          const dist = Object.entries(result.probabilities)
            .sort((a, b) => b[1] - a[1])
            .map(([opt, p]) => `  ${debugBar(p)} ${p.toFixed(2)}  ${opt}`)
            .join("\n");
          ctx.ui.notify(
            `prior OK (${result.model}, ${result.latencyMs}ms, ${result.inputTokens}+${result.outputTokens} tokens)\n${dist}\n-> ${result.choice}`,
            "info",
          );
        } catch (err) {
          ctx.ui.notify(`prior test failed: ${(err as Error).message}`, "error");
        }
        return;
      }

      // help or unknown
      ctx.ui.notify(
        [
          "decision-prior commands:",
          "  /prior            toggle assistance on/off",
          "  /prior on|off     explicit toggle",
          "  /prior debug [on|off]   toggle debug mode (logs consultations + contribution)",
          "  /prior debug log|summary  show recent consultations / contribution stats",
          "  /prior ask \"question\" | opt1 | opt2 | ...  consult the prior now and feed the result to the model",
          "  /prior set <key> <value>  set model|endpoint|threshold|maxOptions|mode|providerId|apiKey",
          "                          mode: conservative (real decision points) | eager (any judgment call, incl. yes/no)",
          "  /prior status     show configuration and stats",
          "  /prior test       verify connectivity with a sample question",
          "  /prior reset-stats",
        ].join("\n"),
        "info",
      );
    },
  };
  pi.registerCommand("prior", priorCommand);
  pi.registerCommand("jev", priorCommand); // legacy alias

  // ---------- entry renderer (debug records in transcript) ----------

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, { expanded }, theme) => {
    const record = entry.data as ConsultRecord;
    return new Text(
      theme.fg(record.lowConfidence ? "warning" : "accent", recordToEntryText(record, expanded)),
      0,
      0,
    );
  });

  // ---------- message renderer (/prior ask results) ----------

  pi.registerMessageRenderer(MESSAGE_TYPE, (message, { expanded }, theme) => {
    const record = message.details as ConsultRecord | undefined;
    if (!record) {
      const first = typeof message.content === "string" ? message.content : "";
      return new Text(theme.fg("dim", first), 0, 0);
    }
    return new Text(
      theme.fg(record.lowConfidence ? "warning" : "accent", recordToEntryText(record, expanded)),
      0,
      0,
    );
  });
}

// Minimal structural type so updateUi works for both ExtensionContext and
// ExtensionCommandContext without importing extra types.
interface ExtensionContextUi {
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string): void;
    setWidget(key: string, lines: string[]): void;
    select(title: string, items: string[]): Promise<string | null>;
  };
}
