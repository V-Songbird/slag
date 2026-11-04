# README

## Contents

- [Choose the mode](#choose-the-mode)
- [Step 1: Collect facts](#step-1-collect-facts)
- [Step 2: Pick the tier](#step-2-pick-the-tier)
- [Step 3: Draft in reader order](#step-3-draft-in-reader-order)
- [Writing rules](#writing-rules)
- [Commands, code and results](#commands-code-and-results)
- [Step 4: Verify](#step-4-verify)
- [Step 5: Report](#step-5-report)
- [Translations](#translations)
- [Gotchas](#gotchas)

repo-docs reads this file for any request to write, review, score, shorten, repair or translate one README, including a request that never says README, such as "document this repo" or "add a quick start". The reconciliation's step 2 reads it once and applies its Review mode to every maintained README.

A README is the front door of a repository, not its documentation. A person who arrives with no context must be able to answer five questions from it alone:

1. What does it do?
2. Is it for me?
3. How do I run it?
4. How do I know it worked?
5. Where do I go next?

Every decision below serves one of those five. Two rules decide the rest:

- **Order content by the reader's questions, never by the code's structure.** The right content is what the audience needs to finish a task, minus what it already knows.
- **The README does not hold everything important. It makes everything important easy to find.** Reveal depth in layers: understand and try, then do real work, then configure and integrate, then the separate documents.

The project may be a library, a command-line tool, a service, a plugin or an agent skill. The five questions do not change; only the form of "how do I run it" changes.

Platform behaviours named here are GitHub's. On another host, check the equivalent before relying on one.

## Choose the mode

| Request | Mode | Do this |
|---|---|---|
| No README, or a new one is wanted | Write | Steps 1 to 5 |
| Review, audit or score a README | Review | Follow [the review rubric](readme-review.md); change no file unless asked |
| Improve, rewrite or shorten a README | Improve | Review first, then Steps 1 to 5 |
| One targeted change, such as a new flag | Edit | Change that part only, apply the writing rules to it, verify what you changed |

A README request on its own skips the reconciliation's inventory and the layout audit. When improving, keep what is already correct, and keep heading text that other pages link to, because renaming a heading changes its anchor. Move content into new files, such as a `docs/` folder, only with the user's approval.

## Step 1: Collect facts

State only what the repository or the user confirms. Never invent a package name, command, version, flag, output, URL, badge, support channel or license. Audience, tier and section order are your judgement; facts are not.

When you can read the repository, look for:

- manifests and runtime limits: `package.json` (`bin`, `engines`, `scripts`), `pyproject.toml`, `Cargo.toml`, `go.mod`, `.nvmrc`, `.python-version`, `Dockerfile`, `docker-compose.yml`
- entry points, and real command help from `--help`
- configuration: `.env.example`, config schemas, settings files, environment variables the code reads
- project files in the root, `.github/` or `docs/`: `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `GOVERNANCE.md`, `CITATION.cff`
- CI workflows for the real test and lint commands, and publishing config for the registry and package name
- the current README, the documentation site and `examples/`

When you cannot read the repository, work only from what the user provides, and ask for anything missing from the list below.

Before drafting, settle these five:

- **Audience.** Who arrives first, and what they already know. Name the concrete use case, not "anyone who needs X".
- **First success.** The one real task a newcomer should finish, and the observable result that proves it worked.
- **Contributions.** Whether the project accepts them. This decides the Development and Contributing sections.
- **Language.** The language of the existing documentation. With none, the language of the user's request.
- **Gaps.** Facts you could not confirm. Ask the user. When you cannot ask, leave them out and list them in the report. Never fill a gap with a guess.

## Step 2: Pick the tier

| Tier | Fits | Sections | Prose budget |
|---|---|---|---|
| Minimal | script, demo, small tool | 4 to 6 | 400 words |
| Standard | library, CLI, plugin, agent skill, open-source service | 8 to 12 | 900 words |
| Advanced | platform, SDK, production system with its own documentation site | 12 to 16, each short, most of them links | 1200 words |

The budget counts prose only; code blocks and tables are free. It is a ceiling, not a target. Going over means a section is carrying material that belongs behind a link, so cut or move rather than trim evenly. The bundled checker counts it for you with `--tier standard`; see Step 4.

Pick by what readers need, not by project type. When two tiers fit, take the smaller one. Include a section only when it makes a decision or a task easier, and drop what does not apply: a script needs no API section, a tool with no settings needs no Configuration section. Never ship an empty, ceremonial or `TODO` section. A large project with a mature documentation site can have a shorter README than a small one, working as a map that separates the path for *using* the project from the path for *developing* it.

Read [the README templates](readme-templates.md) before you draft. They hold the three tier templates, a filled example, the shape for a plugin or agent skill, and the shapes of the Configuration and Support sections.

## Step 3: Draft in reader order

The first screen carries the name, one sentence of value, the requirements that can block a first attempt, the recommended install, and the first runnable example with its result.

1. **Title.** The recognizable project name. When the package name and the command name differ, show both on the first screen.
2. **Description.** What it is, for which concrete use case, which problem it removes, plus the constraint or difference that matters. Two sentences at most, each under 25 words. Avoid circular wording ("Foo is the official Foo repository") and praise the reader cannot check ("awesome", "blazing fast", "powerful").
3. **Badges** (optional). Put them *after* the description, never above it. A reader who meets a row of images before a sentence still does not know what the project is. Keep only indicators that change a decision: build status, version, documentation, license. Each links to the data it summarizes, and they never get a section of their own.
4. **Requirements.** Only what can block the first attempt: minimum runtime version, operating system, an external service, an account, a permission.
5. **Installation.** Recommend the method with the fewest prerequisites, not the one closest to the source. When a package manager or a prebuilt binary exists, `cargo install` and `go install` are alternatives, not the recommendation. State any toolchain the recommended command needs on the line above that command, even when a Requirements list already mentions it. Other methods come after it, or behind a link.
6. **Quick start.** One copyable example that finishes a real task, never an import or a version check, followed by its result.
7. **Usage.** One to three representative tasks, each with a short reason to use it. Longer catalogues go to `examples/` or the documentation.
8. **Configuration.** See [Configuration](readme-templates.md#configuration) in the templates.
9. **API.** At most the three or four entry points that carry the tasks the README shows, then a link to the full reference. Listing every export, flag or endpoint turns the README into the reference and buries the path.
10. **Troubleshooting.** The failures a newcomer actually hits, each with the message they will see and the fix.
11. **Development and tests.** Separate from Installation, with setup, test and lint commands. Include it when the project accepts changes, or when its policy is unknown.
12. **Contributing and security.** One sentence each, linking `CONTRIBUTING.md` and `SECURITY.md`.
13. **Support.** See [Where to go next](readme-templates.md#where-to-go-next) in the templates. Every project gets this section.
14. **Changelog.** A link to `CHANGELOG.md` or the releases page, naming the versioning scheme when one applies. Never the history itself.
15. **License.** The name, and a relative link to `LICENSE`.

A small project can merge items 4 to 6 into one Quick start. Status, limitations, compatibility, screenshots, demo, benchmarks, architecture, FAQ, roadmap, governance, citation and acknowledgements are optional. Put one near the top only when it carries the value proposition, such as a benchmark with a method the reader can repeat. FAQ and edge cases come after the normal path.

**Say when not to use it.** When the facts name a limitation, a scale it does not reach, or a case another tool serves better, give it a line near the top. Readers decide faster when the boundary is stated than when they have to find it.

**For a plugin or an agent skill**, "how do I run it" has four parts, and all four belong on the first screen: how it is installed for each supported host, how it is invoked once installed, what it changes about the host's behaviour, and one example of the result a reader gets. Show the install command for the recommended host first, then the others. The first example is the outcome the reader wanted, not the plugin's internal machinery: show the request a person makes and what comes back, and keep any internal check after that.

## Writing rules

These are the rules that decide whether a reader understands the page on the first pass. Apply them to every line you write.

- One idea per sentence. Keep sentences under about 25 words, and split a sentence that stacks conditions or actions. Keep a longer one only when it states one clear relationship that splitting would break.
- At most three sentences per paragraph. A paragraph longer than four lines on a narrow screen is a list that has not been written yet.
- Active voice, second person, imperative for steps. "Run the migration", not "the migration should then be run".
- One term per concept, everywhere, including headings and code comments. Never introduce a synonym for variety.
- Expand an acronym the first time it appears, unless it is the project's own name.
- No idioms, no metaphors, no humour that needs a culture. Many readers use a translation tool.
- Cut filler: "it should be noted that", "we will now", "simply", "just", "obviously", "easy", "powerful". Write "use", not "utilize".
- Link text names its destination: "read the installation guide", never "click here", "here", "read more" or the URL itself. Write `[API reference](https://example.com/retry)`, not `[example.com/retry](https://example.com/retry)`.
- Link every destination whose address you have. When you do not have it, keep the sentence and name the destination anyway, then list the missing address in the report. Dropping the route is worse than an unlinked one.
- Use one H1 and a regular H2/H3 hierarchy, so every task can be found by its heading. GitHub builds an outline from headings, so add a manual table of contents only when the README is long, is read mostly outside GitHub, or needs visible in-page navigation.
- Give informative images alt text that carries their information: `![Request flow: client to API to queue to worker](docs/architecture.png)`, not `![diagram](docs/architecture.png)`. Never let a screenshot be the only place a command, error or setting appears.
- A status shown by an emoji, icon or colour also carries a word ("Supported", "No"), because screen readers and plain-text views lose the glyph's meaning.
- Keep diagrams to a handful of boxes. GitHub renders diagrams written as text in a code block, and that text is reviewed with the code. Link a full architecture document for the rest.
- Prefer lists and subsections to wide tables of prose, which break on narrow screens.
- Keep one source of truth for versions and other facts that change. Link it instead of copying it.

## Commands, code and results

Every snippet is minimal, runnable rather than disguised pseudo-code, safe to copy with no real secrets and no surprise destructive command, explicit about versions when syntax depends on them, and followed by its result.

**A snippet is self-contained.** Every name it uses is imported in the snippet, defined in the snippet, or a real value. A snippet that calls `queryDatabase`, `isTransient` or `logger` without defining them is pseudo-code wearing a language tag, and a reader who copies it gets an error instead of a result.

- Tag every fence with its language: `bash`, `powershell`, `python`, `text`, `env`, `yaml`. For a command that behaves the same in every shell, use `shell`.
- Leave the `$` prompt out of blocks meant for copying. To show a command together with its response, use a `text` block and put `$` before the command line only.
- Put every requirement a command needs before that command, not after it.
- Number the steps whenever they must run in a given order, and say which directory they run in when it matters.
- Never print a command the reader must edit before running without saying which part to replace.
- When a command differs by operating system or shell, show each version rather than one that fails elsewhere.
- Secrets appear only as placeholders such as `<TOKEN>` or `<PASSWORD>`, and point to `.env.example` when the project has one.

**Show the result of the first example, always.** A reader who cannot tell success from failure has not succeeded.

Prose is not a shown result. "It returns the parsed user" tells the reader nothing they can compare against. Copy one of these three shapes.

A command prints output, so put it in a `text` block under the words "Expected output:".

````markdown
```bash
csv-clean input.csv --output clean.csv
```

Expected output:

```text
Processed 2,431 rows
Wrote clean.csv
```
````

A library returns a value or throws, so put both in the snippet as comments.

````markdown
```typescript
const user = await retry(fetchUser, { attempts: 4, minDelay: 200 });
// user -> { id: 42, name: "Ada Lovelace" }
// after four failed attempts: throws RetryError, attempts === 4,
// cause === the last underlying error
```
````

A service or a plugin changes something observable, so show the request and the response, or name what the reader will see change.

Use output you actually captured, or output the facts supply. When you have neither, do not invent any, and do not skip the step either: describe the observable effect in one sentence, such as "the command writes `clean.csv` and prints how many rows it removed". Then name the most common failure and what it looks like, so a reader can tell a broken setup from a working one.

## Step 4: Verify

Most of what separates a good README from a working one survives a careful first draft and dies in this pass.

**Run the bundled checker first when you can run commands.** It needs only Node 22 or later, reads one file, and writes nothing:

```text
node "<plugin root>/scripts/readme-check.js" [--tier minimal|standard|advanced] README.md
```

Resolve `<plugin root>` as the skill's SKILL.md says. With `--tier` it also checks the prose budget. It prints `line:rule  message` for each finding, then the count. It exits 1 while any finding remains, 0 at `0 findings`, and 2 for bad arguments or a file it cannot read. Fix what it names, run it again, and only move on at `0 findings`, with two exceptions: `long-sentence` hits you keep because the sentence states one clear relationship, and `no-shown-result` when no output was captured and the prose states the observable effect instead. List each kept finding in the report. It checks sentence length, missing fence languages, a `$` prompt inside a copyable block, badges placed above the description, link text that names no destination or repeats its URL, filler words, leftover placeholders and whether anything at all shows the reader a result. It cannot judge meaning, so the pass below still applies.

When you cannot run commands, or Node is unavailable, do the same checks by hand and say the checker did not run; never claim it ran. Either way, walk the draft once **per check**, not once for all of them.

1. **Every code fence.** Does it declare a language? Is every name inside it imported or defined inside it? Is there a real secret in it? Does a copyable block still carry a `$` prompt?
2. **Every command.** Name the one thing that command needs most: a runtime, a minimum version, a tool, an account, a permission, a working directory. Now find that thing in the text *above* the command. When it is not there, move it there. An install command counts: `cargo install`, `go install` and `npx` each need a toolchain the reader may not have.
3. **The first example.** Is its result shown, as output, as comments in the snippet, or as a named observable effect? When it is not, add it before going on.
4. **Every reader need.** Walk the list: learn more, report a bug, ask a question, report a vulnerability, see what changed, change the project, terms of use. For each need this project actually has, does the README answer it exactly once, with a named destination? A destination with no URL still counts; a missing destination does not.
5. **Every sentence longer than about 25 words.** Split it, unless it states one clear relationship that splitting would break.
6. **Every concept named two different ways.** Pick one name and use it everywhere.
7. **Search for `{{`.** No template placeholder may survive.
8. Check that every relative link and image path points to a file that exists.
9. If you can run commands, run the install and the quick start where it is safe: a temporary directory, a virtual environment or a container. Ask first before installing outside an isolated environment, deploying, publishing, spending money or changing an external system. When isolation forces a different command, such as pointing a global install at a temporary prefix, run that equivalent and report the difference. Take output blocks from real runs. You may cut them to the lines that show success and remove machine-specific paths or timings, but never add a line. When a command was not run, replace its output block with the observable effect in prose, or use output the user supplied.
10. Run the Markdown, prose and link checkers the project already configures, such as a Markdown linter, a prose linter or a link checker. Recommend the missing ones; do not install them.
11. Pass [the final checklist](readme-review.md#final-checklist).

## Step 5: Report

Say which sections the README has, and why any expected section is absent. Say which commands and links you actually checked, and which you did not. List the facts the user still has to supply. Flag a missing `LICENSE`, `CONTRIBUTING.md` or `SECURITY.md` when the audience needs one. Create those files, or choose a license, only when asked.

## Translations

Follow [Translations](readme-templates.md#translations) in the templates.

## Gotchas

- A README that scores well against a template can still fail a reader. Judge whether a real need is met; adding a section never fixes an unanswered question.
- A code block with an undefined helper in it is the most common way a good README stops being runnable. Read each snippet as if you had just pasted it into an empty file.
- A named channel without a link still costs the reader a search, so link it whenever you have the address. Keep the named channel when you do not; a route with no link beats no route at all.
- A requirement listed as optional stops being optional the moment the recommended command needs it. "Rust 1.78 or later, only if you build from source" is wrong above `cargo install`, because that command builds from source.
- "Install" and "Development setup" are different tasks, even when both start with `npm install`. Keep them in separate sections.
- Writing "requires Node" is not a requirement. "Requires Node 18 or later" is.
- In a monorepo, the root README routes to each package; it does not document them.
- When the project is a plugin or an agent skill, the reader's machine is not where it runs. Say which hosts it supports and how each one loads it.
