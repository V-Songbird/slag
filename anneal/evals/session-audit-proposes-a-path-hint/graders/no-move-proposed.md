---
type: regex
pattern: '(?:^|[.:;!?][ \t]+)[ \t>#*_(\-\d.)|]*(?:(?:I|we)(?:''d| would| will)?[ \t]+|(?:my|our|the|one|a|an)[ \t]+)?(?:propos\w*|suggest\w*|recommend\w*|propuest\w*|propong\w*|sugier\w*)(?![ \t]+(?:no|nothing|none|nada|ning[uú]n\w*)\b)(?:(?![.!?](?:\s|$))(?!\b(?:no|not|never|rather|instead|than|nunca)\b|n''t)[^\n])*?\b(?:mov(?:e|ing)|renam\w*|relocat\w*|mover|renombr\w*)\b[^\n]*?(?:defaults\.js|config/)|^[ \t>*_(\-\d.)|]*(?:move|rename|relocate)\b(?:(?!\b(?:no|not|never|rather|instead|than|nunca)\b|n''t)[^\n])*?defaults\.js(?:(?!\b(?:no|not|never|rather|instead|than|nunca)\b|n''t)[^\n])*?\b(?:to|into)\b'
flags: im
match: not_contains
---
