export const meta = {
  name: 'forge-pipeline',
  description: 'Forge Steps 2–6: scout + spike, parallel experts, synthesize, critique (+ optional panel), revise',
  phases: [
    { title: 'Research', detail: 'structural search, expert selection, reality-check spike' },
    { title: 'Experts', detail: 'one forge-expert per chosen domain' },
    { title: 'Plan', detail: 'synthesize expert reports into a master plan' },
    { title: 'Critique', detail: 'single adversarial-critic pass' },
    { title: 'Verify', detail: 'deep only — two refuters per Blocking finding' },
    { title: 'Revise', detail: 'verify each finding, fold into the plan' },
  ],
}

// ---- budget floors (constants, not config — see F2) ----
const EXPERT_BUDGET_FLOOR = 30_000 // below this remaining, fail before the expert fan-out instead of dying mid-dispatch
const VERIFY_BUDGET_FLOOR = 60_000 // below this remaining, skip the ~2xN-agent refuter panel; reviser verifies directly

// ---- schemas ----
const CITED = {
  type: 'object', required: ['cite', 'note'],
  properties: { cite: { type: 'string', description: 'file:line, or a doc URL for externally-verified claims' }, note: { type: 'string' } },
}
const SCOUT = {
  type: 'object',
  required: ['structural_summary', 'anchors', 'domains', 'spike'],
  properties: {
    structural_summary: { type: 'string', description: 'what the feature touches, in ≤10 bullet-equivalents' },
    anchors: {
      type: 'array',
      items: { type: 'object', required: ['path', 'why'], properties: { path: { type: 'string' }, why: { type: 'string' } } },
    },
    domains: {
      type: 'array',
      description: 'expert domains to dispatch, ≤5, chosen by the selection heuristic',
      items: { type: 'string', enum: ['architecture', 'performance', 'data-state', 'ui-ux', 'security', 'testing', 'build-tooling'] },
    },
    spike: {
      type: 'object', required: ['assumption', 'verdict', 'evidence'],
      properties: {
        assumption: { type: 'string', description: 'the single riskiest assumption checked, or "(none — no risky assumption)"' },
        verdict: { type: 'string', enum: ['confirmed', 'refuted', 'none'] },
        evidence: { type: 'string', description: 'file:line grounding the verdict; empty when verdict=none' },
      },
    },
  },
}
const EXPERT_REPORT = {
  type: 'object',
  required: ['domain', 'integration_points', 'patterns', 'risks', 'open_questions', 'not_investigated'],
  properties: {
    domain: { type: 'string' },
    integration_points: { type: 'array', items: CITED },
    patterns: {
      type: 'array',
      items: { type: 'object', required: ['name', 'cite', 'implication'], properties: { name: { type: 'string' }, cite: { type: 'string' }, implication: { type: 'string' } } },
    },
    risks: {
      type: 'array',
      items: { type: 'object', required: ['risk', 'cite'], properties: { risk: { type: 'string' }, cite: { type: 'string' }, mitigation: { type: 'string' } } },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
    not_investigated: { type: 'array', items: { type: 'string' } },
  },
}
const PLAN = {
  type: 'object', required: ['plan', 'gate'],
  properties: {
    plan: { type: 'string', description: 'the full master plan markdown' },
    gate: {
      type: 'object', required: ['domains', 'conflicts', 'assumptions'],
      properties: { domains: { type: 'integer' }, conflicts: { type: 'integer' }, assumptions: { type: 'integer' } },
    },
  },
}
const FINDING = {
  type: 'object', required: ['id', 'summary', 'where', 'claim', 'reality', 'suggested_fix'],
  properties: {
    id: { type: 'string' }, summary: { type: 'string' }, where: { type: 'string' },
    claim: { type: 'string' }, reality: { type: 'string' }, why_blocks: { type: 'string' }, suggested_fix: { type: 'string' },
  },
}
const CRITIQUE = {
  type: 'object', required: ['verdict', 'blocking', 'high_priority', 'open_questions', 'got_right', 'ungrounded', 'rationale'],
  properties: {
    verdict: { type: 'string', enum: ['SOUND', 'NEEDS REVISION', 'UNSOUND'] },
    blocking: { type: 'array', items: FINDING },
    high_priority: { type: 'array', items: FINDING },
    open_questions: {
      type: 'array',
      items: { type: 'object', required: ['id', 'question', 'context'], properties: { id: { type: 'string' }, question: { type: 'string' }, context: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } } },
    },
    got_right: { type: 'array', items: { type: 'string' } },
    ungrounded: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
}
const VERDICT = {
  type: 'object', required: ['refuted', 'reasoning', 'evidence'],
  properties: {
    refuted: { type: 'boolean' }, reasoning: { type: 'string' },
    evidence: { type: 'string', description: 'file:line the verdict is grounded in; empty only when refuted=false' },
  },
}
const REVISION = {
  type: 'object', required: ['plan', 'gate'],
  properties: {
    plan: { type: 'string', description: 'the revised master plan markdown, resolution table included' },
    gate: {
      type: 'object', required: ['fixed', 'refuted', 'escalated'],
      properties: { fixed: { type: 'integer' }, refuted: { type: 'integer' }, escalated: { type: 'integer' } },
    },
  },
}

let currentPhase = 'Research'
try {

const authority = (args.domainAuthority ?? []).length
  ? `\n## Domain authority (treat schema/field/type facts as authoritative)\n${args.domainAuthority.map(a => `### ${a.skill}\n${a.output}`).join('\n\n')}`
  : ''

// ---- Research: structural search, expert selection, reality-check spike ----
phase('Research')
const scout = await agent(`You are scouting a codebase before a robust-development pipeline plans a feature. Do three things, then return the structured result.

## Feature
${args.feature}
${authority}

## 1. Structural search (Step 2)
Search the codebase (Read/Grep/Glob) for the essential structural knowledge the feature touches. Identify 3–5 anchor files an expert should start from — each with a one-phrase reason. Summarize what the feature touches in ≤10 bullet-equivalents.

## 2. Expert selection (Step 3 input)
Choose which domain experts to dispatch, driven by what the search surfaced. Cap at 5. Ask three questions:
- Architectural shape? Cross-cutting (touches many layers) → architecture mandatory; localized → optional.
- Primary risk axis? UI responsiveness / large data → performance. Auth / data exposure / external input → security. Persistence / migration → data-state. Visual or interaction-heavy → ui-ux.
- Validation surface? Behavior-changing → testing is worthwhile; pure refactor → skip testing.
Merge near-duplicates (>50% overlap → one combined expert). If the feature text names specific domains, honor exactly that list. A single-expert dispatch is occasionally right. Return the chosen domains.

## 3. Reality-check spike (Step 2.5)
Identify the single riskiest assumption — the claim that, if false, invalidates the whole design — and run a ≤30-line read to confirm or refute it. Return verdict=confirmed (assumption holds, pipeline proceeds), verdict=refuted (assumption is false — the pipeline will HALT and ask the user to re-scope), or verdict=none (the feature has no risky assumption: pure refactor, well-trodden CRUD). Ground confirmed/refuted in file:line evidence.

Read-only. Do not write files. Do not propose a plan.`,
  { schema: SCOUT, label: 'scout', phase: 'Research' })

if (!scout) return { error: 'scout returned no result — fall back to the sequential skill path' }
if (scout.spike.verdict === 'refuted') {
  return { spikeRefuted: true, assumption: scout.spike.assumption, spikeEvidence: scout.spike.evidence }
}

const anchorBlock = scout.anchors.map(a => `- \`${a.path}\` — ${a.why}`).join('\n')

if (budget.total && budget.remaining() < EXPERT_BUDGET_FLOOR) return { error: 'budget too low for expert dispatch', phase: currentPhase }

// ---- Experts: one forge-expert per chosen domain (barrier — the plan needs all reports) ----
currentPhase = 'Experts'
phase('Experts')
const reports = (await parallel(scout.domains.map(d => () =>
  agent(`## Domain
${d}

## Feature
${args.feature}

## Anchor files
${anchorBlock}

## Structural context
${scout.structural_summary}
${args.domainAuthority?.length ? `\n## Domain authority\n${args.domainAuthority.map(a => a.output).join('\n\n')}` : ''}`,
    { agentType: 'forge-expert', label: `expert:${d}`, phase: 'Experts', schema: EXPERT_REPORT })
))).filter(Boolean)

if (!reports.length) return { error: 'no expert returned a report — fall back to the sequential skill path' }

// ---- Plan: synthesize reports into a master plan ----
currentPhase = 'Plan'
phase('Plan')
const planResult = await agent(`Synthesize these expert reports into a single master implementation plan.

## Feature requirements (verbatim)
${args.feature}

## Expert reports
${JSON.stringify(reports, null, 2)}
${authority}`,
  { agentType: 'forge-plan-synthesizer', label: 'synthesize', phase: 'Plan', schema: PLAN })

if (!planResult) return { error: 'synthesizer returned no plan — fall back to the sequential skill path' }

// ---- Critique: single adversarial-critic pass over the whole plan ----
currentPhase = 'Critique'
phase('Critique')
const critique = await agent(`## Master plan to critique
${planResult.plan}

## Original feature requirements
${args.feature}

## Expert reports the plan was synthesized from
${JSON.stringify(reports, null, 2)}`,
  { agentType: 'adversarial-critic', label: 'critic', phase: 'Critique', schema: CRITIQUE })

if (!critique) return { error: 'critic returned no report — fall back to the sequential skill path' }

// ---- Verify: deep only — two refuters per Blocking finding ----
let blocking = critique.blocking ?? []
let panelRan = false
if (args.deep && blocking.length) {
  if (budget.total && budget.remaining() < VERIFY_BUDGET_FLOOR) {
    log('Budget low — skipping the refuter panel; the reviser will verify all Blocking findings directly')
  } else {
    currentPhase = 'Verify'
    phase('Verify')
    const refutePrompt = (b, lens) => `You are auditing ONE Blocking finding from a plan critique. REFUTE it if you can — read the cited code yourself and check the finding's "Reality" claim against the actual files. Set refuted=false ONLY when the code genuinely supports the finding.

Lens: ${lens}.

## Finding ${b.id} — ${b.summary}
Where: ${b.where}
Claim (what the plan says): ${b.claim}
Reality (what the critic says the code shows): ${b.reality}
Suggested fix: ${b.suggested_fix}

Ground your verdict in file:line evidence you read THIS session — never in what the finding text sounds like.`
    blocking = await parallel(blocking.map(b => () =>
      parallel([
        () => agent(refutePrompt(b, 'identifier accuracy — do the named files, lines, symbols, and signatures actually exist as the finding claims'),
          { label: `refute:${b.id}:identifiers`, phase: 'Verify', schema: VERDICT }),
        () => agent(refutePrompt(b, 'consequence severity — would implementing the plan as written actually fail the way the finding claims'),
          { label: `refute:${b.id}:consequence`, phase: 'Verify', schema: VERDICT }),
      ]).then(vs => {
        const votes = vs.filter(Boolean)
        return { ...b, refuter_votes: votes, panel_refuted: votes.length === 2 && votes.every(v => v.refuted) }
      })
    ))
    panelRan = true
  }
}

// ---- Revise: verify each finding, fold the verified ones into the plan ----
currentPhase = 'Revise'
phase('Revise')
const revision = await agent(`Verify each critic finding against the code, then fold the verified ones into the plan.

## Current master plan
${planResult.plan}

## Critique
${JSON.stringify({ ...critique, blocking }, null, 2)}

${args.deep && panelRan ? 'Refuter-panel verdicts are attached per Blocking finding (panel_refuted + refuter_votes). Verify panel-refuted findings FIRST; the panel prioritizes, it does not overrule.' : ''}`,
  { agentType: 'forge-plan-reviser', label: 'revise', phase: 'Revise', schema: REVISION })

if (!revision) return { error: 'reviser returned no plan — fall back to the sequential skill path' }

return {
  spikeRefuted: false,
  plan: revision.plan,
  gate: {
    domains: planResult.gate.domains,
    conflicts: planResult.gate.conflicts,
    blocking_fixed: revision.gate.fixed,
    refuted: revision.gate.refuted,
    escalated: revision.gate.escalated,
  },
}

} catch (e) {
  return { error: 'workflow error during ' + currentPhase + ': ' + (e && e.message || e), phase: currentPhase }
}
