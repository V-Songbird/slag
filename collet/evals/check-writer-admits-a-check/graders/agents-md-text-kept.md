---
type: regex
target: { source: file, path: AGENTS.md }
pattern: '^# prices\n\nA small price-formatting library\. Node 22, ES modules, nothing to install or build\.\n\nRun `npm test` to check a change\.\n\n<!-- collet:begin [^\n]*-->\n(?:(?!<!-- collet:)[\s\S])*<!-- collet:end -->\n$'
---
