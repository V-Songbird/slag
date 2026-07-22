"use strict";

// Plain-text report — one table. Per arm: N, compliance, lift, CI, verdict, and
// realized spend. No HTML, no charts, no ">99%"-style claims.

function fmt(x, d = 2) {
  return x == null ? "—" : x.toFixed(d);
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function renderReport(analysis) {
  const lines = [];
  lines.push(`proof — ${analysis.id}`);
  lines.push(`model=${analysis.model}  seed=${analysis.seed}  cells=${analysis.cells} (${analysis.usable} usable)`);
  lines.push("");
  const cols = [["arm", 12], ["N", 4], ["compliance", 11], ["lift", 7], ["95% CI", 16], ["verdict", 12], ["cost $", 8]];
  lines.push(cols.map(([h, w]) => pad(h, w)).join(" "));
  lines.push(cols.map(([, w]) => "-".repeat(w)).join(" "));
  for (const [arm, d] of Object.entries(analysis.arms)) {
    const ci = d.ci ? `[${fmt(d.ci[0])}, ${fmt(d.ci[1])}]` : "—";
    lines.push([
      pad(arm, 12),
      pad(d.n, 4),
      pad(fmt(d.mean), 11),
      pad(arm === "baseline" ? "—" : fmt(d.lift), 7),
      pad(arm === "baseline" ? "—" : ci, 16),
      pad(arm === "baseline" ? "—" : d.verdict, 12),
      pad(fmt(d.costUsd, 4), 8),
    ].join(" "));
  }
  lines.push("");
  lines.push(`total spend: $${fmt(analysis.totalCostUsd, 4)}`);
  return lines.join("\n");
}

module.exports = { renderReport };
