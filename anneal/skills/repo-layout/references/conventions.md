# Target conventions

Each rule removes steps an agent repeats every session: searches, file reads and command runs. Apply a rule only where the project's own rules and its framework allow it.

## Orientation

- **A short map file at the root.** `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, whichever the host reads, loads into every session: what the project is, the commands, where things live, known pitfalls. Keep it under 200 lines and link to longer docs instead of copying them. Its sections follow one fixed sequence, in [map-file.md](map-file.md). A project that serves more than one host writes the content once and points the other names at it.
- **A declared toolchain version.** `.nvmrc` or `.node-version`, `.python-version`, `rust-toolchain.toml`, `global.json`, `.ruby-version`, `.java-version`. Without one, the agent has to find and verify a version before it can run anything.
- **One check command.** Types, lint and tests behind one entry, runnable for a single file and quiet when it passes. Every line of passing output lands in the agent's context and tells it nothing.
- **A template for the environment.** `.env.example` with the variable names and empty values. The names live in the file the agent must never read, so without a template the only way to learn one is to run the project and read the crash.

## Finding code

- **Group by feature or domain, not by file type.** Search finds what you already know to look for; a feature folder also shows the related files you didn't know existed.
- **A shallow tree.** Each folder on the way down is a listing, and every path repeats in every search result. Framework routing earns its depth; `src/lib/modules/core/services/internal/` does not.
- **Tests beside the code they test.** `cart.test.ts` next to `cart.ts` turns "does this have tests?" into something the agent already saw, instead of a second tree to walk.
- **Unique, full-word names.** Name a file after its main export and keep names unique across the repository. `helpers`, `utils`, `common` and a dozen `index` files make every search ambiguous. A search for `Total` finds `calculateOrderTotal` but not `calcTot`.
- **Build output and dependencies ignored by git.** Text search skips ignored files; everything else shows up in results that have to be read past.

## Understanding code

- **Explicit connections.** Direct imports, calls and parameters let a search answer "what uses this?". Names assembled at runtime, string lookups, home-made reflection and hidden global state don't. Widely used framework conventions are fine.
- **Types or signatures that describe inputs and outputs**, so a function can often be used without reading its body.
- **Named exports (JavaScript and TypeScript).** A default export can be imported under another name, so a search for the original name misses those uses.
- **Few re-export files.** Each one adds a hop between an import and the definition.
- **Comments that say why.** An agent can't ask the author about a decision, and the code already says what it does.

## Never change for these rules

- Names and locations a framework requires: entry points, routing folders, `__init__.py`, `mod.rs`, `page.tsx`.
- Public package entry points and paths that other projects import.
- What a test checks. Never skip, delete or weaken a test to finish a step.
