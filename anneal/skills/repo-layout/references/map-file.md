# The map file skeleton

One fixed sequence of sections, so an agent that has read one map file knows where to look in the next. The whole file loads into every session and is paid for every time, together with any file it imports as `@path`, so a section earns its place or is left out. Keep it under 200 lines; the audit flags more as `map-file-long`.

Length is not what makes a map useful. A map routes: it names the paths, documents and commands that take a task to its contract and to the check that proves the change. The audit's `map-routes` observation counts what a map and its imports name, and reports a map that names nothing, however short.

## The sequence

```markdown
# <Project name>

<Two to four lines: what the project is, the runtime and the file that pins its version,
the module system, whether anything has to be installed or built first.>

## Start here
## Rules that outrank everything
## Commands
## Where things live
## Conventions
## Pitfalls
```

In a map anneal writes, spell the headings this way and keep this order. Leave out a section with nothing true to say; never fill one. Nothing else is added at H2: what a project needs beyond the sequence goes in an H3 under the section it is closest to.

## What each section carries

- **The opening lines.** What the project is, plus what an agent needs before it can run anything. No history and no pitch.
- **Start here.** At most five pointers, each with its trigger: "before touching `core/`, read X". A conditional pointer costs only the task that needs it; an unconditional reading list costs every session. It comes second because a pointer is useless once the agent has gone looking on its own. Point at the one document that holds the current contract, and at its section when the document is long; the check that proves the change sits in `Commands`. Each trigger names only what its destination holds, checked against that destination's imports, exports or headings; a trigger that claims more sends unrelated tasks there. A pointer never names a decoy or a folder to avoid. Leave it out when the project has no documents to point at.
- **Rules that outrank everything.** Optional. At most three invariants, each a sentence a test or a reviewer could check. Past three, none of them outranks anything.
- **Commands.** A table of the command, what it does, and what it costs in time or money. The single check command comes first, then how to run it for one file. A command that takes minutes, spends money or reaches outside the repository says so in the cost column, because that is the row the agent reads when it picks the command. One-time setup after a clone goes here too.
- **Where things live.** A table or a tree, one line per path, top level first; a map that already says it in prose keeps its prose. Say which paths are generated or ignored by git, and where tests sit. It is a route, not an inventory: name the top level and the packages a task could miss, not every folder. The audit's `package-routes` observation lists the packages the map already names, which need nothing more.
- **Conventions.** Only what constrains a change anywhere in the repository. A rule that matters for one kind of file lives in the document for that file and leaves one line here: the trigger and the link.
- **Pitfalls.** What went wrong, or will, that the code does not say. Each item opens with a bold sentence stating the fact, then gives the reason. Runtime-name spots from plan step 8 land here. Delete a pitfall once a check catches it.

## What stays out

- **Machine facts.** One developer's shell, paths or version manager belong in that developer's global instruction file, not in a file every clone loads.
- **A rule something else already enforces.** A linter, a hook, a check or the host's global instructions. Two sources for one rule drift, and the copy is the one that goes stale.
- **The content of a contract or a reference.** Point at the document, or its section, that holds it. A summary in the map is a second source.
- **History.** What the project used to do is in git.
- **What the README says for a person.** Link it.
- **General competence.** "Write tests" and "be careful" tell the agent nothing about this repository.

## Reshaping a map file that already exists

A map that already routes works in whatever form it has: prose, a table, a tree, links or an `@path` import. Offer a reshape as an option the owner can decline, never as a defect to fix.

Move sentences; don't rewrite them. Before editing, show the owner which old heading lands in which section, and list separately anything that would leave the file, with the document it would move to. Nothing leaves without that approval. The project's own rules about its map file win over this skeleton.
