# Writing for people

## Contents

- [When it applies](#when-it-applies)
- [Before writing](#before-writing)
- [Pick the page type](#pick-the-page-type)
- [Task page shape](#task-page-shape)
- [Steps](#steps)
- [Language](#language)
- [Tone](#tone)
- [Structure and accessibility in Markdown](#structure-and-accessibility-in-markdown)
- [Numbers are review flags, not rules](#numbers-are-review-flags-not-rules)
- [Wording flags](#wording-flags)
- [Before and after](#before-and-after)
- [Review checklist](#review-checklist)
- [Report](#report)

A page for people succeeds when a representative reader can **find** the answer, **understand** the choices and consequences, and **complete the task correctly, or reach a safe route to help**, and when it describes the product as it is now. Short text, a good readability score or a friendly tone do not prove any of that. Every rule below serves those four outcomes.

## When it applies

Apply it on your own initiative, before writing, whenever the file you are about to write or substantially rewrite is Markdown and its intended reader is a person who will use what it describes.

| Applies | Does not apply |
|---|---|
| help-center articles, user guides, getting-started pages, how-to guides, FAQs, troubleshooting | private working material: `.private/`, `docs/tasks/`, `docs/decisions/`, `docs/knowledge/private/`, `docs/apis/private/` |
| public docs under `docs/`, such as `docs/knowledge/` or `docs/apis/` | research notes, experiment logs, drafts only you will read |
| CHANGELOG, CONTRIBUTING, release notes, migration guides, in-app help text kept in `.md` | agent-facing files: `CLAUDE.md`, `AGENTS.md`, `SKILL.md`, prompts, memory files |
| README prose, with [the README reference](readme.md) deciding the page's structure | a one-line fix to an existing page, such as a typo or a broken link |

When the reader is unclear, look at where the file lives and who links to it. Public destination plus a human reader means it applies. If it is still unclear, apply it: the rules cost little on a page that turns out to be internal.

Judging the interface itself, such as what a screen, flow or in-product message should show, needs a usability review; this reference covers only the page that describes it.

## Before writing

Settle six facts, from the request, the code and the existing docs. Label any you had to assume.

1. **Reader.** Who arrives here, with what prior knowledge. Assume less vocabulary and less process knowledge than the team has: about a quarter of adults in OECD countries score at the two lowest literacy levels. Low literacy is not low intelligence; keep adult content and a respectful voice. Take task names and terms from what readers actually write, such as issue titles, support questions or search terms, when the repository has them.
2. **Task.** The one thing the reader is trying to do or know. One dominant job per page.
3. **Entry point.** Readers arrive from search, a link or the product, rarely from the top of a sequence. The page must say what it is for and whom it applies to without its parent page.
4. **Product truth.** The exact UI labels, commands, limits and behaviour, checked against the source code, the running product or existing docs. Never invent a label, a limit or a message. Mark what you could not verify.
5. **Language and locale.** The document's language, register and market. In Spanish, pick *tú* or *usted* deliberately and keep it; do not carry English sentence patterns over.
6. **House style.** If the project has a style guide, glossary, term list or voice notes, follow them over this reference's defaults and name any conflict in your report.

## Pick the page type

Keep the types apart; a page that mixes them serves none well. They can be linked to each other freely.

| Type | Reader's need | Shape |
|---|---|---|
| Tutorial or getting started | learn by doing a first real task | a meaningful result early, checkpoints, what to do when a step fails |
| How-to guide | get one known task done | the task page below |
| Reference | look up an exact fact | consistent structure, tables for scannable facts, no narrative |
| Explanation | understand why or how something works | prose, the mental model, links out to the tasks |
| Troubleshooting or FAQ | fix a specific symptom | the symptom as the heading, then cause and fix in steps |

## Task page shape

**Title → outcome and scope → prerequisites → steps → success check → recovery or next step.**

Scale it to the task. A two-step answer does not get six headings; fold the parts into sentences.

- **Title.** The task in the reader's words: "Change your delivery address", not "Address management".
- **Opening.** One or two sentences: what this does and who it applies to. Do not restate the title.
- **Prerequisites.** Only what can block success or change the decision: access, permissions, cost, materials, versions. Put them before the first action they affect.
- **Consequences.** Irreversible actions, data loss, charges and privacy effects go before the step that commits to them, in plain words: "Deleting the album also deletes every photo in it. You cannot undo this."
- **Steps.** Follow [Steps](#steps).
- **Success check.** What the reader sees when it worked: "**Up to date** appears under **Sync**."
- **Recovery.** The likely failures, next to the step where they happen: "If the email does not arrive, ...". End with a route to human help when one exists.

Context earns its place when it changes the reader's next decision or prevents a predictable mistake. Deeper background goes in a linked explanation page. Never hide a prerequisite, a consequence or a recovery path in a collapsed section or another page to make a page look shorter.

## Steps

- Number sequential steps. Use bullets only for unordered items.
- One meaningful action per step. "Enter your email address, then select **Continue**" is one unit; a step that crosses screens or asks a new decision is two.
- Pattern: **condition → action → result**. "If you have more than one account, select the account to change." The condition comes first so nobody acts on a step that does not apply to them.
- Start actions with the imperative verb. Bold the exact UI label as it appears, localized. Include the final **Save**, **Apply** or **Confirm**.
- Name controls, not positions or colours: "Select **Save**", not "the green button on the right". Prefer "select" over "click" when touch and pointer both apply; use "tap" only for touch-only actions.
- Write navigation as words, "Open **Settings**, then **Security**", and use `>` breadcrumbs only as a supplement.
- Mark optional steps as optional. Give one good route, not every equivalent one.
- There is no maximum number of steps. Split a long procedure at meaningful phases ("Before you start", "Verify your identity", "Confirm the change") instead of cramming actions into fewer steps.

## Language

- Prefer the familiar word when it keeps the meaning. "Use", not "utilize"; "change", not "perform a modification".
- Explain a necessary technical term where the reader first needs it, by its practical effect: "**Export** saves a copy of your information in a file." Then use exactly that term every time, including headings and code comments. Never alternate synonyms for one concept. A glossary may supplement, never replace, the in-place explanation.
- Keep the real UI label even when it is a poor word; explain it rather than renaming it.
- One idea per sentence, with a clear actor and verb. Keep the "if", "because" and "until" that connect ideas; shortening that deletes a relationship makes reading harder.
- Second person for the reader's actions, and the imperative for steps: "Run the migration", not "the migration should then be run". "We" only when the organization acts or owns a failure: "We'll send a code."
- Active voice by default; passive is fine when the state matters more than the actor: "Your changes are saved."
- State the action, not its absence, where that is enough; keep explicit prohibitions that matter: "Do not close the app during the update." No double negatives.
- Precise modality: "must" for a requirement, "can" for an option, "might" for a possibility. Avoid a bare "should" or "may".
- Spell out abbreviations at first use, unless it is the project's own name. Write "for example" and "that is", not "e.g." and "i.e.".
- Literal language only: no idioms, metaphors, wordplay or cultural references. It helps non-native readers, readers using a translation tool, and translation alike.
- Replace unclear "it", "this" and "that" with the noun when two things could be meant.

[The wording flags](#wording-flags) list every pattern to flag, and [Before and after](#before-and-after) shows rewrites that fix them.

## Tone

Calm, direct, respectful. Warmth is a quiet choice of words, not jokes, exclamation marks or emoji; evidence that friendliness improves task success is weak, while clarity reliably helps.

- Delete effort-minimizers and assumptions: "simply", "just", "easy", "obviously", "of course", "it only takes a moment". Describe what happens instead.
- No humour around errors, payments, security, privacy or lost data.
- Error and problem text: what happened, then what the reader can do. Apologize once, only when the service caused a real inconvenience. Never blame the reader.
- No ableist or stigmatizing metaphors: "crazy", "lame", "sanity check", "blind to", "dummy". Use "unexpected", "weak", "validation check", "overlook", "placeholder".

## Structure and accessibility in Markdown

- One `#` H1, then headings in order without skipped levels. Headings describe their topic in the reader's words and still make sense in a table of contents.
- Put the meaningful words first in headings, paragraphs and list items.
- At most three sentences per paragraph. A paragraph longer than four lines on a narrow screen is a list not yet written.
- Link text says where it goes: "[Reset your password](https://example.com/reset)", never "click here", "here", "learn more", "read more" or the URL itself. Write `[API reference](https://example.com/retry)`, not `[example.com/retry](https://example.com/retry)`.
- Images get alt text that carries their information: `![Request flow: client to API to queue to worker](docs/architecture.png)`, not `![diagram](docs/architecture.png)`. Never put an instruction, command, error or setting only inside an image, and never put paragraphs of text inside a screenshot.
- Use a screenshot only when the reader must recognise a place, icon or state that words describe poorly. Crop it but keep a landmark, place it next to its step, and use the localized interface.
- Video supplements text for motion or timing; it never replaces the text route. Captions and a text equivalent are required.
- Never convey meaning by colour, shape or position alone. A status shown by an emoji, icon or colour also carries a word ("Supported", "No"), because screen readers and plain-text views lose the glyph's meaning.
- Keep the critical path readable on a narrow phone screen: no wide tables or long code lines in the steps, and one idea per paragraph. Prefer lists and subsections to wide tables of prose. Reference tables may be wide.
- Mark text in another language when the renderer supports it.

## Numbers are review flags, not rules

The evidence does not support these as limits, so never distort a page to satisfy them.

| Flag | What to do when it trips |
|---|---|
| A sentence over about 25 words | check it for stacked conditions or several actions; keep it if it is one clear relationship |
| English prose above roughly U.S. grade 6 to 8 | find the cause: syntax, vocabulary, or a necessary term. Change only the first two |
| Many steps | split at phases; never merge actions to cut the count |
| Readability formulas in general | English formulas say nothing about Spanish text, and no score proves comprehension |

"Seven steps maximum", "users don't read", "design for the F-pattern", "never use passive voice" and "always shorter" are folklore.

## Wording flags

Flags, not a banned list. A word can be right as an exact UI label, in another sense, or when it states a measured fact ("easy" in a usability comparison). Never erase a necessary legal, safety, financial or technical distinction to satisfy this table.

| Pattern | Why it hurts | Instead |
|---|---|---|
| "simply", "just", "easy", "easily", "quick" as reassurance | adds nothing and makes difficulty feel like the reader's fault | state the action: "Open **Settings**." |
| "obviously", "of course", "as you know", "clearly" | assumes the knowledge the page exists to give | state the fact |
| "powerful", "blazing", "awesome" | praise the reader cannot check | state what it does, or a measured fact |
| "it should be noted that", "we will now" | filler before the point | state the point |
| idioms: "a piece of cake", "under the hood", "out of the box" | figurative, cultural, hard to translate | say the literal meaning |
| slang, emoji, exclamation marks, "Oops!" | noise when the reader needs a diagnosis | state what happened and the next action |
| unexplained jargon: "authenticate", "cache", "sync", "provision" | recognising a word is not knowing what it does | explain by effect: "Sync keeps your files up to date on every device signed in to your account." |
| unexplained acronyms | extra decoding | spell out at first use, or avoid |
| "e.g.", "i.e.", "etc." | misread or hides what else counts | "for example", "that is", or list the categories |
| inflated verbs: "utilize", "perform a modification", "make a selection" | verbal machinery | "use", "change", "select" |
| vague verbs: "manage", "configure", "handle", "process" | hide the actual operation | "Change your email address", "Choose who can see the album" |
| noun stacks: "account access permission configuration" | the reader must rebuild the relationships | "Change who can access your account" |
| ambiguous "it", "this", "that" | the instruction attaches to the wrong object | repeat the noun |
| "click the green button on the right", "see below" | depends on colour, position and layout | "Select **Save**", "under **Privacy**" |
| "click here", "learn more", "read more", "read this" | meaningless out of context | "Learn how to recover your account" |
| double negatives, nested exceptions | hard to parse | state the permitted condition; keep real prohibitions |
| bare "should", "may" | blurs requirement, option and probability | "must", "can", "might", plus the condition |
| "soon", "in a moment" | promises without a signal | "Wait until **Upload complete** appears." |
| "we" when the reader acts: "Now we go to Settings" | blurs who acts | "Open **Settings**." |
| "please" on every step | ceremony without content | reserve it for real requests |
| "You entered an invalid password" | centres blame, not recovery | "That password doesn't match this account. Try again or reset your password." |
| "crazy", "lame", "sanity check", "blind to", "dummy" | stigmatizing | "unexpected", "weak", "validation check", "overlook", "placeholder" |
| "he or she", "(s)he", "he" for an unknown person | excludes readers and reads clunky | "they", or address the reader as "you" |
| "suffers from", "confined to a wheelchair", "normal users" | assigns value to a trait | "has", "uses a wheelchair", "most users" |
| "X is for designers and photographers" | tells other readers the product is not for them | describe what it helps anyone do |
| synonym variety for one concept | readers assume two words mean two things | one term, every time |

## Before and after

Illustrative rewrites, not tested ones. Labels and behaviour are hypothetical.

### Account task

**Before:** To facilitate account access restoration, simply navigate to the authentication interface and initiate the credential recovery process using the email identifier associated with your account.

**After:**

> ## Reset your password
>
> You need access to the email address connected to your account.
>
> 1. On the sign-in screen, select **Forgot password?**
> 2. Enter your email address, then select **Send reset link**.
> 3. Open the email and select **Reset password**.
> 4. Enter a new password, then select **Save password**.

Concrete actions replace abstractions, and the blocking prerequisite comes first.

### Irreversible action

**Before:** Simply remove the album from the options menu. Note that associated content may also be affected.

**After:**

> ## Delete an album and its photos
>
> **Deleting an album permanently deletes every photo in it. You cannot undo this.** Save any photos you want to keep first.
>
> 1. Open the album.
> 2. Select **More options**, then **Delete album**.
> 3. Select **Delete permanently**.
>
> **Album deleted** appears when the album and its photos are gone.

The consequence precedes the commitment, and the page ends with a success signal.

### Technical term

**Before:** Synchronization facilitates cross-device data consistency. Ensure that synchronization is enabled to avoid discrepancies.

**After:**

> ## What does "sync" mean?
>
> Sync keeps your files up to date on every device signed in to the same account.
>
> After you change a file, connect the device to the internet and select **Sync now**. When **Up to date** appears, the change is on your other devices.

### Error and recovery

**Before:** Oops! Your upload failed. Please ensure compliance with our file-size requirements and try again!

**After:**

> **This photo is too large to upload.** Choose a photo of 10 MB or less, then select **Try again**.

The limit must match the real product.

**Before:** If you don't see an email, which can occur for a variety of reasons including network delay, filtering rules, spam detection or other technical issues, you should first verify the address you provided and then consult your spam folder before contacting us.

**After:**

> **If the email does not arrive:**
>
> 1. Check that the email address on the screen is correct.
> 2. Check your spam or junk folder.
> 3. Wait a few minutes, then select **Send again**.
>
> Still no email? [Contact support about a verification email](https://example.com/support).

### Spanish (Latin America)

**Before:** A fin de efectuar la modificación del identificador de correo electrónico asociado a su usuario, deberá acceder al apartado de parametrización correspondiente y proceder con la actualización pertinente.

**After:**

> ## Cambia tu correo electrónico
>
> Necesitas acceso al nuevo correo para confirmar el cambio.
>
> 1. Abre **Configuración**.
> 2. Selecciona **Cuenta** y después **Correo electrónico**.
> 3. Escribe el nuevo correo y selecciona **Guardar**.
> 4. Abre el mensaje que enviamos al nuevo correo y selecciona **Confirmar correo**.

*Tú* is a deliberate house choice here, not a claim that it beats *usted* in every market. Match the localized interface labels exactly.

## Review checklist

Answer each item **Yes**, **No** or **N/A**. Fix every No, or say in the report why it stays. On a review, or when told to change no file, list each No with its fix instead and leave the page as it is. The list catches defects; it is not a score and does not prove the page works for readers.

### Purpose and truth

- [ ] The title names the reader's task or question in words they would use or search for.
- [ ] The page has one dominant job; background and reference do not crowd the task path.
- [ ] The opening says what the page does and whom it applies to, without restating the title.
- [ ] UI labels, commands, limits, messages and behaviour match the current product, or are marked unverified.
- [ ] Blocking prerequisites appear before the first action they affect.
- [ ] Irreversible effects, costs, data loss and privacy effects appear before the step that commits to them.

### Find and understand

- [ ] Headings describe their topic, are in order, and make sense read alone.
- [ ] The first words of headings, paragraphs and list items carry the meaning.
- [ ] Each paragraph has one job.
- [ ] Familiar words are used where they keep the meaning.
- [ ] Each necessary technical term is explained where first needed and then used consistently, with no synonym swapping.
- [ ] Abbreviations are spelled out at first use; no "e.g." or "i.e.".

### Act and recover

- [ ] Sequential steps are numbered, one meaningful action per step.
- [ ] Conditions come before the actions they govern; results come after.
- [ ] Each step names the exact control in bold, including the final Save, Apply or Confirm.
- [ ] The procedure has the steps the task needs; nothing was merged or cut to hit a number.
- [ ] The reader can recognise success.
- [ ] Likely failures have a recovery path next to the step where they happen, and a route to human help exists when needed.

### Access and mobile

- [ ] Link text states the destination or purpose.
- [ ] Images have alt text that carries their information; no instruction lives only in an image or video.
- [ ] No instruction depends on colour, shape or position alone ("the button on the right").
- [ ] The critical path stays readable on a narrow screen: no wide tables or long lines in the steps.
- [ ] Video, if any, has captions and a text route.

### Language and tone

- [ ] No "simply", "just", "easy", "obviously", idioms, slang or ableist metaphors.
- [ ] No gendered pronouns for unknown people and no value-laden terms for people.
- [ ] No double negatives or nested exceptions; modality is precise (must, can, might).
- [ ] Tone is calm and respectful; errors say what happened and what to do, without jokes or blame.
- [ ] Long sentences and readability scores were used as prompts to inspect, not as pass/fail gates.
- [ ] For a non-English page, register (for example *tú* or *usted*), regional terms, formats and localized UI labels are deliberate and consistent.

### Ownership and testing

- [ ] The report states that the page has not been tested with real readers, unless it has.
- [ ] High-risk content (payment, security, account loss, deletion) comes with a recommendation to test it with representative non-experts.
- [ ] It is clear what product change should trigger an update of this page.

## Report

Run [the review checklist](#review-checklist) on the page and fix every "No"; on a review, list each "No" with its fix and change no file. Then state in your report:

- the reader and task you wrote for, and any assumption about them;
- the UI labels, limits or behaviour you could not verify against the product;
- that the page has **not** been tested with real readers, and, for high-risk content such as payments, security, account loss or deletion, recommend a task test with representative non-experts: give them a realistic goal without the article title, watch whether they find the page, follow it and recognise success, and ask them to explain the key consequence in their own words and what they expect to happen after the last step.

Do not claim a page is clear, accessible or effective because it passes the checklist. The checklist catches defects; only readers show success.
