---
type: regex
target: { source: file, path: services/booking/src/fees.js }
pattern: '^(?=[\s\S]*\bDE: "eu")(?=[\s\S]*\bES: "eu")(?=[\s\S]*\bFR: "eu")(?=[\s\S]*\bIT: "eu")(?=[\s\S]*\bNL: "eu")(?=[\s\S]*\bCH: "europe")(?=[\s\S]*\bGB: "europe")(?=[\s\S]*\bNO: "europe")(?=[\s\S]*\?\? "non-eu")(?=[\s\S]*\{ eu: 250, europe: 400, "non-eu": 900 \})'
---
