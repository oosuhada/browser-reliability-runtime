# ADR: Optional local LLM queue backpressure

## Status

Accepted.

## Context

The local LLM evaluation queue already uses file states (`pending`, `running`, `blocked`,
`completed`, `failed`) and atomic claim via rename. The v0.6 systems capstone made one missing
boundary obvious: an unbounded producer can turn a useful file queue into unbounded disk and heap
pressure.

## Decision

Add an optional `WORKFLOWLENS_LLM_QUEUE_MAX_PENDING` limit. When set to a positive integer,
`writeJob` rejects new pending jobs once the pending directory reaches that size. The default remains
unbounded to preserve existing workflows.

## Why this shape

- Rejection happens before the pending job is written.
- Existing blocked/running/completed transitions are unchanged.
- The setting is opt-in so benchmark and dataset scripts do not silently change behavior.
- The regression test verifies the rejection path.

## Trade-off

Counting pending files on each enqueue is simple and defensible, but not optimized for very large
directories. That is acceptable for this local tool. A later version could maintain a durable counter
or sharded queue directories if measurement shows this path is hot.
