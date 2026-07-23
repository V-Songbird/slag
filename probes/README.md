# probes

Drift baselines for this marketplace's own skills. Each JSON is a single-arm proof `watch` probe that fires one skill and asserts on the work product it leaves.

Re-check after a Claude Code update: `node ../proof/bin/proof.js watch check --spec proof-skill-probe.json` (and `assay-audit-probe.json`).
