"use strict";

// Tier-awareness UX (component 5). The default tier is chosen FOR the user based
// on the config surface, and explained — encoding the wording-effect research
// findings (spec §6):
//
//   rule wording  → haiku. Sonnet saturates at 1.00 regardless of wording, so a
//                   rule A/B on sonnet returns a TRUE NULL that reads as tool
//                   failure. Haiku is the only tier where a wording effect is
//                   detectable — the only CORRECT tier for the question.
//   skill firing  → any tier (haiku default for cost only). Firing does not
//                   saturate, so the measurement is valid on any tier.

const RULE_SURFACES = new Set(["instructions", "rule", "claudemd", "claude.md"]);
const SKILL_SURFACES = new Set(["skill", "skill-firing"]);

function isRuleSurface(s) { return RULE_SURFACES.has(String(s || "").toLowerCase()); }
function isSkillSurface(s) { return SKILL_SURFACES.has(String(s || "").toLowerCase()); }

// Recommend a tier for a spec, and flag a requested model that fights the
// surface. `requested` is the model the user forced (opts.model || spec.model).
function tierFor(spec, requested) {
  const surface = spec.surface || (spec.tasks && spec.tasks[0] && spec.tasks[0].surface) || (spec.task && spec.task.surface) || "instructions";
  const req = requested || spec.model;

  if (isRuleSurface(surface)) {
    const warnSonnet = /sonnet|opus|fable/i.test(String(req || ""));
    return {
      surface, tier: "haiku",
      valid: !warnSonnet,
      reason: "rule wording saturates on sonnet (every wording hits ceiling); haiku is the only tier where a wording effect is detectable, so it is the correct tier for this question.",
      warning: warnSonnet
        ? `rule A/B forced onto ${req}: rule wording saturates there, so a null is expected and does NOT mean the rule is worthless. Re-run on haiku to detect a wording effect.`
        : null,
    };
  }

  if (isSkillSurface(surface)) {
    return {
      surface, tier: req || "haiku",
      valid: true,
      reason: "skill firing does not saturate — the measurement is valid on any tier. Haiku is the default for cost, not correctness.",
      warning: null,
    };
  }

  return {
    surface, tier: req || "haiku",
    valid: true,
    reason: "surface is not a known rule/skill surface — running at the requested tier; interpret with the surface in mind.",
    warning: null,
  };
}

module.exports = { tierFor, isRuleSurface, isSkillSurface };
