# Replay Policy Matrix

Authoritative source: `validateReplayAction()` and `REPLAY_SAFE_TOOLS` in `apps/api/src/runtime/canonicalSemantics.ts`.

| Replay State | Step | Tool Class | Runtime Decision |
| --- | --- | --- | --- |
| Equivalent prefix | Any pure/model/memory step | n/a | Reuse persisted event output when inputs match |
| Equivalent prefix | `TOOL_CALL` | Any original persisted call | Re-emit persisted tool result; do not call live tool |
| Diverged | Pure/model/memory step | n/a | Execute live and mark replay safety as diverged |
| Diverged | `TOOL_CALL` | Replay-safe tool | Execute live |
| Diverged | `TOOL_CALL` | Unsafe or mutating tool | Throw `InvariantViolation` for `RP1`; block execution |

## Replay-Safe Tools

`web.search`, `file.read`, `code.execute`, `memory.summarize`, `runtime.inspect`.

All other tools are unsafe by default during diverged replay. Adding a replay-safe tool requires updating `REPLAY_SAFE_TOOLS` and adding a semantic verification test.
