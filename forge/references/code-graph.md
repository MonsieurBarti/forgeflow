# Code-Graph Integration

code-graph is a CLI tool for AST-aware code navigation. It understands symbol definitions,
references, dependencies, and impact analysis across the codebase. When available, it replaces
Grep/Glob for all structural code queries.

## Detection

Before using code-graph commands, check availability:

```bash
which code-graph
```

- **Found:** Use code-graph for all structural queries. This is MANDATORY.
- **Not found:** Fall back silently to Grep/Glob. Suggest running `code-graph init` to set it up.

Do not warn or error when code-graph is absent. Silently use Grep/Glob instead and move on.

## Command Reference

| Command | Purpose | Example |
|---------|---------|---------|
| `code-graph find <symbol>` | Locate where a symbol is defined | `code-graph find TaskRunner` |
| `code-graph refs <symbol>` | Find all usages/imports of a symbol | `code-graph refs parseConfig` |
| `code-graph context <symbol>` | Full context: definition, references, dependencies | `code-graph context BuildPipeline` |
| `code-graph impact <symbol>` | What breaks if this symbol changes | `code-graph impact validateInput` |
| `code-graph stats` | Project overview: file counts, language breakdown | `code-graph stats` |
| `code-graph circular` | Detect circular dependency chains | `code-graph circular` |
| `code-graph dead-code` | Find unused exports and unreachable code | `code-graph dead-code` |

## Output Formats

code-graph supports multiple output formats. Choose based on context:

| Format | Flag | When to use |
|--------|------|-------------|
| compact (default) | none | Interactive use, token-efficient agent work |
| json | `--format json` | Structured parsing, piping to jq, programmatic consumption |
| verbose | `--format verbose` | Debugging code-graph itself, full detail needed |

**Default to compact.** It minimizes token usage while preserving all essential information.
Use `--format json` only when you need to parse the output programmatically (e.g., filtering
results with jq or feeding into another tool).

## When code-graph Is NOT the Right Tool

Even when code-graph is installed, some tasks belong to Read/Grep/Glob:

- **Reading file contents** before editing -- use Read
- **Searching string literals** like error messages, log strings -- use Grep
- **Finding TODOs, FIXMEs, comments** -- use Grep
- **Non-structural text searches** (config values, magic strings, documentation) -- use Grep/Glob
- **Listing files by pattern** (e.g., all test files) -- use Glob

The rule: if the query is about **code structure** (definitions, references, dependencies,
impact), use code-graph. If the query is about **text content**, use Grep/Glob.

## Fallback Behavior

When code-graph is not installed, map structural queries to their best Grep/Glob equivalent:

| code-graph command | Grep/Glob fallback |
|--------------------|--------------------|
| `find <symbol>` | Grep for `class X`, `function X`, `def X`, `fn X`, `const X` |
| `refs <symbol>` | Grep for the symbol name across the codebase |
| `context <symbol>` | Combine `find` fallback + `refs` fallback + Read the defining file |
| `impact <symbol>` | Grep for the symbol, then Read each file to understand usage |
| `stats` | Glob to count files by extension |
| `circular` | No reliable fallback -- skip or note limitation |
| `dead-code` | No reliable fallback -- skip or note limitation |

These fallbacks are approximate. They lack AST awareness and may produce false positives.
When using fallbacks, suggest that the user run `code-graph init` for better results.

## Setup

To initialize code-graph in a project:

```bash
code-graph init
```

This indexes the codebase and creates the graph database. Re-run after major structural
changes or periodically to keep the index fresh.
