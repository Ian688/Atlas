# Atlas development

Start with README.md, docs/ARCHITECTURE.md and docs/HANDOFF.md. This is an independent Rust application. Modus is one future adapter, not a runtime dependency.

The imported six specifications in docs/specs are the full product requirements snapshot. This foundation slice does not claim full AL/ET/GE or mature-product acceptance. The user's latest decision permits a new independent implementation; old instructions requiring preservation of the old implementation do not constrain this repository.

Implement real vertical slices. Local parsing must not invoke user code or models. Snapshot/source identities, immutable publication, explicit unknowns and coverage, bounded queries, owner-bound commands and real verification must survive architecture changes. Do not use mock animations as execution evidence. Preserve other developers' changes and record final command exit codes.
