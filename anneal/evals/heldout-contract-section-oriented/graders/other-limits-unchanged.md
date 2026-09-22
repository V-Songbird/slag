---
type: regex
target: { source: file, path: integrations/carrier/src/limits.js }
pattern: '^(?=[\s\S]*\bREQUESTS_PER_MINUTE\s*[:=]\s*90\b)(?=[\s\S]*\bLABELS_MAX_BATCH\s*[:=]\s*40\b)'
---
