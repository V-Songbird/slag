# README review

## Contents

- [Rubric](#rubric)
- [Report format](#report-format)
- [Anti-patterns](#anti-patterns)
- [Final checklist](#final-checklist)
- [Measuring and automating](#measuring-and-automating)

This rubric makes "it seems clear" reviewable. It is a working heuristic, not an external standard. Judge whether a real reader need is met, not whether a template was filled. A section the project does not need is correctly absent, and adding a useless section never raises a score.

## Rubric

Score each criterion from 0 to 4. Use 1 and 3 between the written anchors.

| Criterion | 0 | 2 | 4 |
|---|---|---|---|
| Orientation | unclear what it is | partial description | what it is, for which use case, and the problem it removes |
| Fit | nothing helps the reader rule it in or out | requirements stated, limits missing | requirements, scope, maturity and when not to use it |
| First success | no way to run it | install and run exist, first example only proves it loads | one recommended install, then one example that finishes a real task |
| Proof it worked | nothing shows success | some steps show output, the first one does not | every important step shows what the reader should see |
| Usage clarity | unclear what to invoke | one example, no way to adapt it | the reader can state what to call, with what, and what comes back |
| Instructions | steps assume unstated setup | happy path works for an already-equipped reader | every requirement precedes its command, steps run as printed |
| Configuration | settings implied, never explained | listed, but defaults, requiredness or location missing | name, requiredness, default, meaning and location; secrets as placeholders |
| Reading ease | dense paragraphs, long sentences | mixed, parts need a second pass | short sentences, small paragraphs, skimmable throughout |
| Comprehension | undefined jargon, shifting terms | main ideas come through with effort | one term per concept, acronyms defined, no ambiguous sentence |
| Coverage | central capabilities absent | main user path only | every audience the project has finds its path |
| Navigation | one monolithic block | irregular headings | headings name reader tasks, links name destinations |
| Onward routes | no route of any kind | needs collapsed into one channel | one distinct destination per need |
| Trust | contradicts the repository | facts match, marketing weakens it | every claim checkable, nothing invented, nothing unfinished |
| Scope | near-empty, or everything inlined | one oversized section | every section earns its place, depth is linked |

| Total | Assessment |
|---:|---|
| 50 to 56 | Excellent: ready to serve as the main entry point |
| 41 to 49 | Good: localized improvements |
| 29 to 40 | Needs significant revision |
| 0 to 28 | High risk of onboarding frustration |

## Report format

1. A table of criterion, score and one line of evidence, such as a quote or a heading.
2. The total and its band.
3. Findings ranked by impact on the reader. Each gives the location, the problem it causes, and the concrete fix.
4. What you verified, such as commands run and links checked, and what you did not.

## Anti-patterns

| Anti-pattern | Problem for the reader | Fix |
|---|---|---|
| Badge wall or large logo before the description | identity buried, orientation delayed | description first, and keep only decisive badges |
| Marketing claims ("awesome framework for X") | nothing verifiable | say what it does and how it differs |
| Hidden prerequisites | the first command fails | list requirements before the command |
| Many installation methods before the quick start | decision overload | recommended method first, alternatives linked |
| Example that only imports the package | proves no value | finish an observable task |
| No expected output anywhere | the reader cannot tell success from failure | show real output, or name the observable effect |
| Invented output | the reader trusts a number that was never produced | capture it, or describe the effect in prose |
| Full API reference in the README | heavy navigation, duplication | main entry points plus a link to the reference |
| Configuration table with no defaults or location | the reader cannot apply it | name, requiredness, default, meaning, and where the value goes |
| No Configuration section, no statement that there is none | the reader keeps looking | one sentence saying the project has no settings |
| Structure that mirrors the code tree | reflects implementation, not tasks | order by the reader's questions |
| Usage mixed with development setup | `npm install` means two different things | separate Installation from Development |
| Support that sends bugs, questions and vulnerabilities to one place | the wrong channel gets the report | one distinct destination per need |
| Screenshots as instructions | inaccessible and hard to maintain | copyable text, with the screenshot as a complement |
| "Click here" links | unclear destination, poor accessibility | descriptive link text |
| Absolute URLs to files in the same repository | fragile across clones and branches | relative links |
| Secrets in examples | normalizes unsafe practice | `<TOKEN>`, `<PASSWORD>`, `.env.example` |
| Versions copied in several places | documentation drift | a single source, or automation |
| Manual table of contents without need | duplicate maintenance | rely on the generated outline |
| Changelog inside the README | historical noise | `CHANGELOG.md` or the releases page |
| "TODO: document configuration" | documents incompleteness | document before publishing, or link an issue |
| Wide tables of prose | unreadable on narrow screens | lists or subsections |
| FAQ before the quick start | exceptions before the normal case | normal path first |
| README as the entire documentation | poor search and upkeep | turn it into an index to the documentation |

## Final checklist

Mark an item not applicable when the project lacks what it checks. When an item depends on a fact nobody confirmed, such as a support channel, list it as open in the report instead of inventing content to pass it.

**Orientation**

- [ ] The title identifies the project unambiguously, and shows both names when the package and the command differ.
- [ ] The first screen says what it is, who it is for, and which problem it removes.
- [ ] A limitation, a boundary or a "not for this" is stated when the facts supply one.

**First success**

- [ ] Every requirement that can block the first attempt appears before the commands.
- [ ] One short, recommended installation path exists, with alternatives after it or linked.
- [ ] The quick start can be copied and run from a clean environment, in the printed order.
- [ ] The first example finishes real work, not an import or a version check.
- [ ] The reader can tell whether it worked, from shown output or a named observable effect.
- [ ] No output block contains numbers that were never produced.

**Content**

- [ ] Settings carry name, requiredness, default and meaning, and the reader knows where values go.
- [ ] Secrets appear only as placeholders, and the real ones are said to live outside the repository.
- [ ] A project with no configuration says so in one sentence.
- [ ] The full API reference is linked, not duplicated.
- [ ] Usage and contributor setup are separate, and a test command exists when contributions are accepted.
- [ ] Questions, bugs and vulnerabilities each have their own destination, or the README says which channel is the only one.
- [ ] `CONTRIBUTING.md` and `SECURITY.md` are linked when they exist.
- [ ] The license is named and linked, or the README says the project is not distributed.
- [ ] The change history lives outside the README.
- [ ] The README links deep documentation instead of becoming it.
- [ ] For a plugin or an agent skill: supported hosts, how each installs it, and how it is invoked.

**Format and language**

- [ ] Links to repository files are relative; external links pass a link checker or are reported as unchecked.
- [ ] Every code fence declares a language, and copyable blocks carry no `$` prompt.
- [ ] Commands that differ by operating system show each version.
- [ ] Informative images have meaningful alt text, and no screenshot is the only source of an essential instruction.
- [ ] Headings let a reader scan without reading linearly, with no unneeded manual table of contents.
- [ ] Badges carry information, not decoration.
- [ ] Sentences are short, terms are consistent, and no acronym, idiom or jargon term is left unexplained.
- [ ] No `{{` placeholders and no `TODO` sections remain.

**Maintenance**

- [ ] The README is reviewed whenever installation, CLI, configuration or API change.
- [ ] Someone who did not write it has tried to follow it. When that cannot happen yet, recommend it.

## Measuring and automating

- **Time to first success.** The time from opening the README to a result that proves the project works. Five minutes in a prepared environment is a reasonable house rule for a simple tool, not a research finding. A kernel, a mobile app or a distributed system needs its own target.
- **Onboarding success rate.** Readers who finish the quick start without help, divided by readers who try. A trial with five newcomers reveals more than a readability score.
- **Readability formulas** are at most an alarm, never a target. They ignore the reader's knowledge and the reader's task.
- **Checks worth recommending in CI.** A Markdown linter for structure, a prose linter for the project's terminology rules, a link checker for broken links, a smoke test that runs the quick start from a clean environment, and human review of meaning. The smoke test matters most, because a linter cannot show that the install commands still work.
