# context-write-envelope

Structured context envelope written by agents to phase beads

**Module:** `agent-response`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | yes | Agent name that wrote the context |
| `task` | string | no | Task bead ID if context is task-scoped |
| `status` | string | yes | Completion status (e.g. completed, failed, blocked) |
| `findings` | array | no | Array of finding objects |
| `decisions` | array | no | Array of decision objects |
| `blockers` | array | no | Array of blocker objects |
| `artifacts` | array | no | Array of artifact objects |
| `next_steps` | array | no | Array of next-step strings or objects |
| `timestamp` | string | yes | ISO 8601 timestamp of when context was written |
