# Vendored: elkjs 0.12.0 (layout only)

This directory holds one third-party file, unmodified, and it exists for
exactly one job: **computing graph layout coordinates**. It contributes no code
semantics whatsoever — it never sees the analysis, only boxes and edges that
Atlas has already derived from the immutable facts.

| | |
|---|---|
| Package | `elkjs` |
| Version | **0.12.0** (pinned; not a range) |
| File | `lib/elk.bundled.js`, copied byte-for-byte |
| SHA-256 | `1222e44f953ce7746af23801e723708f8e6f436b8b377a6a5fc7552f34a307b3` |
| Size | 1,609,707 bytes |
| License | EPL-2.0 OR GPL-3.0-or-later — full text in `LICENSE.elk.md` |
| Source | `npm pack elkjs@0.12.0` from the public npm registry |
| Runtime deps | none (`dependencies: {}`) |

## Why a vendored dependency at all

The 2D relationship canvas used to place its blocks in a fixed three-column
grid. That is not a layout: a call graph drawn in load order has no layers, no
ports, and no relationship between geometry and structure, so the picture
cannot be read even when every number in it is correct.

The imported work order is explicit that this is not Atlas' differentiating
work and that it should not be re-invented by hand:

> 技术候选不是已安装清单：优先沿用 ELK / elkjs 的本地布局方向，评估 Cytoscape.js
> 或独立 TypeScript renderer 作为关系图组件
> — `docs/specs/code-atlas-dual-view-design-2026-09-08.md` §9

It also demands that the choice be **evaluated on a fixture before it is
fixed**, not assumed. That evaluation is recorded in
`evidence/development/2026-09-12-w09-layout/layout-evaluation.json`: measure
time, size, and whether the output is usable, then decide. What Atlas keeps for
itself is the part that is actually differentiating — which entities exist,
what is unknown, what a budget cut, and what identity a selection carries.

## What is *not* claimed

- **Not** a Web Worker. The work order asks for layout in a local layout
  worker with a deadline, cancellation and generation tracking. Layout here runs
  on the main thread over a bounded focus graph (tens of nodes, tens of
  milliseconds); `web/layout.js` records the node cap and the measured time, and
  the missing worker is listed as a gap rather than implied by the presence of
  this file.
- **Not** a fallback-free path. If `ELK` is missing or throws, `web/layout.js`
  falls back to a local layered ordering **and says so** in its result
  (`engine: 'fallback_local'`). A silent fallback would make a layout failure
  look like a layout.
- **Not** modified. If this file ever needs a change, the change belongs in
  Atlas' adapter, not here.
