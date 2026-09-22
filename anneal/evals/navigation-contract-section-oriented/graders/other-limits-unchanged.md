---
type: regex
target: { source: file, path: packages/partner-client/src/limits.js }
pattern: '^(?=[\s\S]*\bREQUESTS_PER_MINUTE\s*[:=]\s*120\b)(?=[\s\S]*\bLABELS_MAX_BATCH\s*[:=]\s*25\b)'
---
