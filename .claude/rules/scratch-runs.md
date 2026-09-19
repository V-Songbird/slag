# Benchmarks and headless runs live in the scratchpad

Anything disposable — benchmark arms, throwaway fixtures, headless `claude -p`
probe workspaces, scratch git repos — is created under this session's scratchpad:

```
X:/tmp/claude/<project-slug>/<session-id>/scratchpad/
```

The path is in the system prompt at session start; use it verbatim, never
`/tmp`, never `os.tmpdir()`, and never a directory inside this repository.

- One subdirectory per run or per arm, named for what it is (`variants/vctl`,
  `p3-probe`), so a run's inputs, transcripts and results stay together.
- Nothing is copied back into the repo except the prose or number a doc cites.
  Raw records, transcripts and run logs stay in the scratchpad and are never
  committed.
- A headless run isolates itself: `--setting-sources project` and
  `--strict-mcp-config`, so this machine's user-scope plugins cannot leak into
  an arm and void the control.
