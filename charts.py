#!/usr/bin/env python3
"""Generate the comparison charts embedded in the READMEs.

All data is transcribed from real benchmark runs (see paper §4); the raw
numbers live in the DATA dict below so the charts stay reproducible.

Usage:  python charts.py      # writes PNGs to assets/
"""
import os
import statistics

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")

# ---- 3-seed A/B data (benchmark.py --task <t> --runs 3) --------------------
AB = {
    "ambiguous-optimize": {
        "off": {"wall": [37.6, 43.0, 41.4], "in": [14322, 15229, 3685], "out": [709, 950, 1293]},
        "on": {"wall": [74.8, 69.1, 114.2], "in": [13119, 13914, 57107], "out": [1292, 1181, 2371]},
    },
    "long-explore": {
        "off": {"wall": [39.1, 49.5, 43.3], "in": [17799, 13478, 18624], "out": [961, 1382, 1015]},
        "on": {"wall": [74.7, 65.0, 58.6], "in": [28443, 17902, 14196], "out": [1700, 1307, 1088]},
    },
}

# ---- thinking-level experiment (single runs, ambiguous-optimize) -----------
THINKING = [
    # (label, wall_s, in_tok, out_tok, thinking_chars)
    ("off / high", 37.4, 15441, 873, 971),
    ("on / high", 98.3, 29415, 2089, 1999),
    ("on / low", 81.0, 30746, 1626, 1090),
]

# ---- jev distributions observed in the paper's scenarios -------------------
DISTRIBUTIONS = [
    ("Scenario 1: root-cause hypotheses (multi-file-debug)", [
        ("aggregate: ts-key overwrite", 1.00),
        ("output: file truncation", 0.00),
        ("sources: JSON parse drop", 0.00),
        ("filters: valid record filtered", 0.00),
    ]),
    ("Scenario 2: ambiguous requirement (short task)", [
        ("structured human-readable summary", 0.50),
        ("switch to logging module", 0.34),
        ("JSON output for downstream", 0.14),
        ("progress bar", 0.02),
    ]),
    ("Scenario 4b: repair-strategy arbitration", [
        ("fix code only (strip keys)", 0.65),
        ("fix data file only", 0.22),
        ("fix both data and code", 0.13),
        ("fall back to DEFAULT_RATE", 0.00),
    ]),
]

C_OFF, C_ON = "#4C72B0", "#DD8452"


def fig_ab():
    fig, axes = plt.subplots(1, 3, figsize=(13, 4.2))
    metrics = [("wall", "wall time (s)"), ("in", "input tokens"), ("out", "output tokens")]
    for ax, (key, title) in zip(axes, metrics):
        labels = list(AB.keys())
        for i, (cfg, color) in enumerate((("off", C_OFF), ("on", C_ON))):
            vals = AB[labels[0]][cfg][key], AB[labels[1]][cfg][key]
            means = [statistics.mean(v) for v in vals]
            stds = [statistics.stdev(v) for v in vals]
            xs = [j + (i - 0.5) * 0.32 for j in range(len(labels))]
            ax.bar(xs, means, width=0.3, yerr=stds, capsize=4, color=color,
                   label=f"jev={cfg}", alpha=0.9)
            for x, v in zip(xs, vals):
                ax.scatter([x] * len(v), v, color="black", s=14, zorder=3, alpha=0.6)
        ax.set_xticks(range(len(labels)))
        ax.set_xticklabels(labels)
        ax.set_title(title)
        ax.grid(axis="y", alpha=0.3)
    axes[0].legend()
    fig.suptitle("jev off vs on — 3 independent runs each (bars: mean, whiskers: stdev, dots: per-run)")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "ab-3seed.png"), dpi=150)
    plt.close(fig)


def fig_thinking():
    labels = [t[0] for t in THINKING]
    fig, axes = plt.subplots(1, 4, figsize=(13, 3.6))
    colors = [C_OFF, C_ON, C_ON, C_ON]
    metrics = [("wall_s", "wall time (s)"), ("in", "input tokens"),
               ("out", "output tokens"), ("think", "thinking chars")]
    for ax, ((key, title), color) in zip(axes, zip(metrics, colors)):
        vals = [t[1 + metrics.index((key, title))] for t in THINKING]
        bars = ax.bar(labels, vals, color=color, alpha=0.9)
        ax.bar_label(bars, fmt="%.0f", fontsize=8)
        ax.set_title(title)
        ax.tick_params(axis="x", labelsize=8)
        ax.grid(axis="y", alpha=0.3)
    fig.suptitle("thinking level vs jev prior (ambiguous-optimize, single runs)")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "thinking-levels.png"), dpi=150)
    plt.close(fig)


def fig_distributions():
    fig, axes = plt.subplots(1, 3, figsize=(13.5, 3.8))
    for ax, (title, dist) in zip(axes, DISTRIBUTIONS):
        names = [d[0] for d in dist][::-1]
        probs = [d[1] for d in dist][::-1]
        colors = ["#55A868" if p == max(probs) else "#4C72B0" for p in probs]
        bars = ax.barh(names, probs, color=colors, alpha=0.9)
        ax.bar_label(bars, fmt="%.2f", fontsize=9)
        ax.set_xlim(0, 1.12)
        ax.set_title(title, fontsize=9)
        ax.tick_params(axis="y", labelsize=8)
        ax.grid(axis="x", alpha=0.3)
    fig.suptitle("probability distributions returned by jev in the paper's scenarios")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "consult-distributions.png"), dpi=150)
    plt.close(fig)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    fig_ab()
    fig_thinking()
    fig_distributions()
    for f in sorted(os.listdir(OUT)):
        print("wrote", os.path.join(OUT, f))
