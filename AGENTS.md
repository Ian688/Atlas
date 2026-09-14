# Atlas development

Atlas is an independent local code exploration, execution and change-review workbench. Rust owns the core; Modus and other agents are consumers through public interfaces.

Read README.md, docs/ARCHITECTURE.md and docs/HANDOFF.md, then execute docs/DAILY_DEVELOPMENT_WORK_ORDER.md. Read only the specification sections needed for the active task. docs/AGENT-BRIEF.md and docs/START_CODING_AGENT.md are shortcuts to the same order, not additional rulebooks.

## Execution

- Deliver a complete user task. Choose the shortest sound implementation, reuse working code and libraries, and fix the real path through UI/API/engine as needed. Routine refactoring, dependency changes and implementation choices do not need renewed permission.
- Current priority: the 2D function workbench, from finding a function through understanding it and running it. The work order defines acceptance and the next task. Large-repository qualification and Modus migration are deferred, not prerequisites or abandoned goals.
- Diagnose repeated failures with a minimal reproduction and a new discriminating observation; do not keep retrying the same approach. Record unrelated improvements and return to the active task.
- Run focused checks while editing, then applicable integration checks at delivery. Record final exit codes and actual browser interactions for UI work. Report unverified behavior honestly; independent review is separate from self-test.
- Preserve other developers' changes. Do not require a globally clean worktree or commit unrelated files. Update one concise report and the current progress pointer; do not rewrite historical evidence.

## Durable boundaries

Local parsing does not execute target code or call models. Keep source/version identity, immutable published results, explicit unknowns and coverage, bounded/cancellable work, ownership and authorized writes. Static analysis, observed execution and proposed intent remain distinguishable. Do not use animations or model guesses as execution evidence. Keep local source/data local unless disclosure is authorized.

## Document authority

Latest user decisions determine scope. docs/USE-CASES.md defines product outcomes; docs/DAILY_DEVELOPMENT_WORK_ORDER.md is the single current execution order. Architecture describes replaceable implementation choices; progress and handoff are leads to verify against code. The six imported specs are the full requirements reference, not a requirement to implement every subsystem before shipping a useful slice. Historical paths, priorities, tool limitations and numeric implementation defaults do not override the current order. Preserve the agreed 2D/3D product direction while improving its implementation.
