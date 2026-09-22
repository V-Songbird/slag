---
type: regex
target: { source: file, path: apps/storefront/src/shipping.js }
pattern: '^(?=[\s\S]*\bDE: "domestic")(?=[\s\S]*\bAT: "eu")(?=[\s\S]*\bFR: "eu")(?=[\s\S]*\bNL: "eu")(?=[\s\S]*\bDK: "nordic")(?=[\s\S]*\bFI: "nordic")(?=[\s\S]*\bSE: "nordic")(?=[\s\S]*\?\? "world")(?=[\s\S]*\{ domestic: 490, eu: 990, nordic: 1290, world: 2490 \})'
---
