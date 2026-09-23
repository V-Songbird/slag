---
type: tool_used
tool: Bash
input_match: '"command":"(?:[^"\\]|\\.)*?(?:(?:(?<![\w./-])|(?<=\\n))(?:npm(?:\s+--?[\w-]+)*\s+(?:test|t|run\s+test|run-script\s+test)\b|node(?:\s+--?[\w=.-]+)*?\s+--test\b)(?:[^"\\;&|]|\\[^n]|&(?![&>])|\|(?!\|))*?(?:\d*>>?(?!&)(?!\s*/dev/null\b)|&>>?(?!\s*/dev/null\b)|(?<![\w-])(?:tee|[Tt]ee-[Oo]bject|[Oo]ut-[Ff]ile|[Ss]et-[Cc]ontent|[Aa]dd-[Cc]ontent)\b)|[{(](?:[^"\\{}()]|\\.|\$\{(?:[^{}"\\]|\\.)*\}|\$\((?:[^()"\\]|\\.)*\))*?(?:(?<![\w./-])|(?<=\\n))(?:npm(?:\s+--?[\w-]+)*\s+(?:test|t|run\s+test|run-script\s+test)\b|node(?:\s+--?[\w=.-]+)*?\s+--test\b)(?:[^"\\{}()]|\\.|\$\{(?:[^{}"\\]|\\.)*\}|\$\((?:[^()"\\]|\\.)*\))*?[})](?:[^"\\;&|]|\\[^n]|&(?![&>])|\|(?!\|))*?(?:\d*>>?(?!&)(?!\s*/dev/null\b)|&>>?(?!\s*/dev/null\b)|(?<![\w-])(?:tee|[Tt]ee-[Oo]bject|[Oo]ut-[Ff]ile|[Ss]et-[Cc]ontent|[Aa]dd-[Cc]ontent)\b))'
min: 0
max: 0
---
