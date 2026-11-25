---
name: next
description: Pick up and complete the next OneApp development task from the OneApp MCP queue. Use when the user invokes /next or asks to implement a not-started OneApp task.
---

# Complete one OneApp task

Work directly in the existing OneApp checkout on `main`. Keep all work in that checkout and preserve unrelated changes.

1. Call OneApp MCP `list_tasks` with `status: "not-started"`. If there are no matching tasks, report that and stop.
2. Pick one task and call `get_task` for its full description and current revision. If the requirements or expected behavior are unclear, stop and ask for clarification before claiming it.
3. Claim the task with `update_task`, passing its current revision and setting `status: "in-progress"`. If the update conflicts, reread the task and claim it only if it is still `not-started`.
4. Implement the task and follow the applicable `AGENTS.md` instructions. Run `bun check` and `bun run test`, and run `bun run build` when relevant. Verify the affected workflow through the running dev server. Fix failures within scope and rerun the affected checks.
5. Stage only the changes for this task and commit them to `main` with a descriptive message.
6. After committing, automatically push `main` with `git push origin main`.
   If the push is rejected because `origin/main` advanced, run `git pull --rebase origin main`.
   Resolve any conflicts, preserve the upstream and task changes, and continue the rebase.
   Rerun the checks relevant to the changes brought in by the rebase or made during conflict resolution, then retry the push. Use a normal push on each attempt.
7. After the push succeeds, call `get_task` for the latest revision. If the task is still `in-progress`, use `update_task` with that revision to set `status: "completed"`.

If you get blocked or need clarification after claiming the task, leave it in progress and explain what you need. In your final reply, include the task link, the pushed commit hash, and what you verified.
