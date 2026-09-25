<!-- collet:begin — this block is written by the collet plugin; edit inside the markers, not around them -->
## How work happens here

`.collet/` holds this project's harness. The open task, the files it may touch and the command that
ends it are printed by `node .collet/task.mjs status`, and a new session is told them before it
reads anything.{{ASK_FIRST}}

1. **Change only the files the open task lists.** If the stated task needs another one, widen the
   list first — {{WIDEN}} If the file goes beyond what the person asked for, ask them first; with
   nobody to ask, leave it and name it in your summary. Working around the list is not a widen.
2. **Finished means the accept command exited zero.** {{CLOSE}} Run it as you go, not only at the
   end. A task that was not closed did not finish, whatever the summary says. When a missing input
   or a broken environment means the accept command cannot pass as the task stands, the work ends
   as a blocker named in the summary and the task stays open.
3. **Facts come from this repository.** Quote the file a fact came from. If the repository does not
   answer a question, say so rather than choosing a plausible default and stating it as fact.
4. **Deliver what the task asks for, in full, and nothing beside it.** What it names is yours to do
   properly; what it does not name is off limits, and anything odd you notice gets reported in your
   summary instead of fixed.
5. **Say what you did not check.** The closing answer is a claim, not a formality.

`node .collet/checks/run.mjs` runs this repository's own checks, and needs nothing but node.
<!-- collet:end -->
