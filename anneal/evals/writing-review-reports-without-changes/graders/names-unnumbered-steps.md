---
type: regex
pattern: '\bunnumbered\b|\bunordered list|(?:\bnot|n[''’]t|\bnever|\bwithout|\binstead of|\brather than)\s+(?:be\s+|a\s+|an\s+)?numbered\b|\b(?:no|without)\s+(?:step\s+)?numbers?\b(?![ \t]+(?:for|of|on|showing|about)\b)[^.\n]{0,30}\b(?:steps?|bullets?)\b|\b(?:steps?|bullets?)\b[^.\n]{0,40}\b(?:no|without)\s+numbers?\b(?![ \t]+(?:for|of|on|showing|about)\b)|\b(?:steps?|bullets?)\b[^.\n]{0,40}\b(?:instead of|rather than)\s+numbers\b(?![ \t]+(?:for|of|on|showing|about)\b)|\ban? (?:numbered|ordered) list (?:would|should|could)\b|\bnumbered steps?\b|\bnumbered list\b[^.\n]{0,40}\bsteps?\b|\bsteps?\b[^.\n]{0,40}\bnumbered list\b|\bnumber (?:the|each|these|your) (?:steps?|bullets?|items?|list)\b|\bnumber them\b|\b(?:use|make|turn|convert|switch|change|should be|needs? to be|must be)\b[^.!?;:\n]{0,40}\b(?:numbered|ordered)\b(?! by\b)'
flags: i
---
