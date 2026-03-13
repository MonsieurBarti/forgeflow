# Audit Findings Schema

All audit agents (security, code review, performance) MUST output JSON conforming to this schema.

## Output Rules

1. Output raw JSON only — no markdown fences, no commentary, no extra text
2. The JSON object must be the only content written to stdout
3. If no findings are detected, output the schema with an empty findings array

## Schema

```json
{
  "agent": "<agent-name>",
  "findings": [
    {
      "severity": "critical | high | medium | low | info",
      "category": "<string — agent-specific category>",
      "file": "<relative file path>",
      "line": <line number | null>,
      "title": "<short summary, under 80 chars>",
      "description": "<detailed explanation of the issue>",
      "remediation": "<suggested fix or action>"
    }
  ],
  "summary": {
    "total": <number of findings>,
    "by_severity": {
      "critical": <count>,
      "high": <count>,
      "medium": <count>,
      "low": <count>,
      "info": <count>
    }
  }
}
```

## Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | yes | Agent identifier: `security-auditor`, `code-reviewer`, `performance-auditor` |
| `findings` | array | yes | List of finding objects (empty array if none) |
| `findings[].severity` | enum | yes | One of: `critical`, `high`, `medium`, `low`, `info` |
| `findings[].category` | string | yes | Agent-specific category (see below) |
| `findings[].file` | string | yes | Relative path from repo root |
| `findings[].line` | number\|null | yes | Line number where issue occurs, or null if file-level |
| `findings[].title` | string | yes | Short summary, under 80 characters |
| `findings[].description` | string | yes | Detailed explanation of the issue |
| `findings[].remediation` | string | yes | Suggested fix or action to resolve |
| `summary` | object | yes | Aggregate counts |
| `summary.total` | number | yes | Total number of findings |
| `summary.by_severity` | object | yes | Count per severity level (all 5 keys required, use 0) |

## Categories by Agent

### Security Auditor (`security-auditor`)
- `leaked-secret` — API keys, tokens, passwords in source
- `sql-injection` — Unsanitized SQL query construction
- `xss` — Cross-site scripting vulnerabilities
- `command-injection` — Unsanitized shell command construction
- `path-traversal` — Directory traversal vulnerabilities
- `insecure-deserialization` — Unsafe deserialization of user input
- `broken-auth` — Authentication/authorization flaws
- `sensitive-data-exposure` — Unencrypted sensitive data
- `dependency-vulnerability` — Known CVEs in dependencies
- `misconfiguration` — Security misconfigurations

### Code Reviewer (`code-reviewer`)
- `naming-convention` — Inconsistent or unclear naming
- `complexity` — Excessive cyclomatic complexity
- `duplication` — Duplicated code blocks
- `convention-violation` — Violates project CLAUDE.md conventions
- `architecture-mismatch` — Deviates from stated architecture
- `error-handling` — Missing or improper error handling
- `type-safety` — Type-related issues
- `dead-code` — Unreachable or unused code

### Performance Auditor (`performance-auditor`)
- `n-plus-one` — N+1 query patterns (ORM calls in loops)
- `unnecessary-rerender` — Missing memo/useMemo/useCallback
- `expensive-loop` — O(n^2) patterns, repeated allocations
- `missing-index` — Database queries on unindexed columns
- `large-bundle` — Unnecessarily large imports or bundles
- `memory-leak` — Potential memory leak patterns
- `blocking-operation` — Synchronous blocking in async context

## Example Output

```json
{
  "agent": "security-auditor",
  "findings": [
    {
      "severity": "critical",
      "category": "leaked-secret",
      "file": "src/config/database.ts",
      "line": 12,
      "title": "Hardcoded database password in source",
      "description": "Database connection string contains a plaintext password. This credential will be exposed in version control and build artifacts.",
      "remediation": "Move the password to an environment variable (e.g., DATABASE_PASSWORD) and reference it via process.env."
    },
    {
      "severity": "medium",
      "category": "sql-injection",
      "file": "src/api/users.ts",
      "line": 45,
      "title": "String interpolation in SQL query",
      "description": "User-provided 'name' parameter is interpolated directly into a SQL query string without parameterization.",
      "remediation": "Use parameterized queries: db.query('SELECT * FROM users WHERE name = $1', [name])"
    }
  ],
  "summary": {
    "total": 2,
    "by_severity": {
      "critical": 1,
      "high": 0,
      "medium": 1,
      "low": 0,
      "info": 0
    }
  }
}
```
