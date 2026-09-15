"""Plot the responsive sweep. Requires matplotlib in an isolated Python environment."""

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

source = Path(sys.argv[1])
rows = json.loads(source.read_text())
fig, ax = plt.subplots(figsize=(11, 4.8), layout="constrained")
for variant, label, color in [
    ("kit", "Font kit 0.2.2", "#c34b22"),
    ("fontaine", "Fontaine 0.8.1 fallbacks", "#2476a6"),
]:
    points = sorted(
        (r["viewport"]["width"], r["cls"])
        for r in rows
        if r["group"] == "responsive" and r["variant"] == variant
    )
    ax.plot(*zip(*points), label=label, color=color, marker="o", markersize=4)
ax.axhline(0.1, color="#777777", linestyle="--", linewidth=1)
ax.text(1055, 0.102, "0.1 CLS reference", ha="right", fontsize=9, color="#666666")
ax.annotate(
    "380 px: 0.1436\nConfirmed in three repeat loads",
    xy=(380, 0.14358410110667175),
    xytext=(530, 0.14),
    arrowprops={"arrowstyle": "->", "color": "#c34b22"},
    color="#9b3514",
    fontsize=10,
)
ax.set(
    title="Font-swap CLS changes sharply with viewport width",
    xlabel="Viewport width (CSS pixels)",
    ylabel="CLS (lower is better)",
    ylim=(-0.005, max(0.165, max(r["cls"] for r in rows if r["group"] == "responsive") * 1.15)),
    xlim=(345, 1075),
)
ax.spines[["top", "right"]].set_visible(False)
ax.grid(axis="y", alpha=0.2)
ax.legend(loc="upper right", bbox_to_anchor=(1, 0.96), frameon=False)
fig.supxlabel(
    "Real TanStack Start app · Manrope + Fraunces · Chrome 152 on macOS\n"
    "Fresh font downloads delayed 2 seconds · 900 px viewport height · 36 widths per strategy",
    fontsize=9,
    color="#555555",
)
fig.savefig(source.with_name("responsive-cls.png"), dpi=160)
fig.savefig(source.with_name("responsive-cls.svg"))
