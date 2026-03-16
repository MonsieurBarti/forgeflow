# plan-audit

Plan-time audit response from architect or quality-gate agents

**Module:** `agent-response`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | yes | Agent name that produced the audit |
| `findings` | array | yes | Array of finding objects: [{task: string, severity: "critical"\|"high"\|"medium"\|"low"\|"info", title: string, description: string, recommendation: string}] |
| `summary` | string | yes | Human-readable summary of the audit results |
