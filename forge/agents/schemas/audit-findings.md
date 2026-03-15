# Audit Findings Schema

Canonical JSON schema for audit agent output. All three audit agents (security-auditor,
code-reviewer, performance-auditor) MUST produce output conforming to this schema.
The quality-gate workflow and quality-gate-report command consume this format.

## Schema

```json
{
  "agent": "<string: agent name, e.g. 'security-auditor'>",
  "findings": [
    {
      "severity": "<'critical' | 'high' | 'medium' | 'low' | 'info'>",
      "category": "<string: finding category, e.g. 'command-injection', 'n-plus-one'>",
      "file": "<string: relative file path, e.g. 'src/api/auth.ts'>",
      "line": "<number | null: line number where the issue occurs>",
      "title": "<string: one-line summary of the finding>",
      "description": "<string: detailed explanation of the issue>",
      "remediation": "<string: specific fix or action to resolve the issue>"
    }
  ],
  "summary": {
    "total": "<number: total findings count>",
    "by_severity": {
      "critical": "<number>",
      "high": "<number>",
      "medium": "<number>",
      "low": "<number>",
      "info": "<number>"
    }
  }
}
```

## Field Details

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | yes | Name of the audit agent that produced these findings |
| `findings` | array | yes | List of individual findings (may be empty) |
| `findings[].severity` | enum | yes | One of: `critical`, `high`, `medium`, `low`, `info` |
| `findings[].category` | string | yes | Classification of the finding type |
| `findings[].file` | string | yes | Relative path to the affected file |
| `findings[].line` | number/null | no | Line number (null if not applicable) |
| `findings[].title` | string | yes | One-line summary |
| `findings[].description` | string | yes | Full explanation |
| `findings[].remediation` | string | yes | How to fix it |
| `summary` | object | yes | Aggregate counts |
| `summary.total` | number | yes | Total number of findings |
| `summary.by_severity` | object | yes | Breakdown by severity level |

## Example

```json
{
  "agent": "security-auditor",
  "findings": [
    {
      "severity": "critical",
      "category": "sensitive-data-exposure",
      "file": "src/config/database.ts",
      "line": 12,
      "title": "Hardcoded database password in source",
      "description": "The database connection string contains a plaintext password that will be committed to version control.",
      "remediation": "Move the password to an environment variable and reference it via process.env.DB_PASSWORD"
    },
    {
      "severity": "medium",
      "category": "misconfiguration",
      "file": "src/server.ts",
      "line": 45,
      "title": "CORS allows all origins in production",
      "description": "The CORS configuration uses origin: '*' which allows any domain to make requests.",
      "remediation": "Restrict CORS origin to specific allowed domains in production configuration"
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
