# audit-findings

Structured audit findings from quality-gate and architect agents

**Module:** `agent-response`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | yes | Agent name that produced the findings (e.g. forge-quality-gate, forge-architect) |
| `findings` | array | yes | Array of finding objects: [{task?: string, file?: string, severity: "critical"\|"high"\|"medium"\|"low"\|"info", title: string, description: string, recommendation: string, category?: string}] |
| `summary` | object | yes | Summary counts: {total: number, by_severity: {critical?: number, high?: number, medium?: number, low?: number, info?: number}} |
