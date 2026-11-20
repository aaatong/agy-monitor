---
name: agy-monitor
description: >-
  Open the AGY Monitor sidebar panel to inspect current Antigravity session
  context window usage, aggregated main and subagent token consumption, and
  prompt cache hit rate. Use when the user asks to open AGY Monitor, check
  token usage or context window pressure, or monitor prompt cache efficiency.
---

# AGY Monitor

AGY Monitor provides a live auxiliary sidebar panel backed by the `agy-monitor`
plugin's `monitor-ui` sidecar.

## Opening the Monitor Panel

Surface a single clickable pill link in chat to open or toggle the sidebar
panel:

```markdown
[AGY Monitor](sidecar://agy-monitor/monitor-ui/)
```

## Notes

- Emit the pill link only when the `agy-monitor` plugin is enabled and running.
- Emit at most one pill link per reply; clicking the pill toggles the sidebar
  panel in the auxiliary pane.
- Session metadata is refreshed automatically by the `agy-monitor-tracker`
  lifecycle hooks (`SessionStart`, `PreInvocation`, `PostInvocation`, `Stop`).
