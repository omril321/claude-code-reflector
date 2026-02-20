# Claude Code Reflector

Analyzes Claude Code sessions to detect missing CLAUDE.md rules, unused skills, and skill corrections. Uses Haiku via Vertex AI to evaluate whether existing rules and skills are sufficient and correctly used.

Sibling project to `~/private/code-claude-auto-learn` (which captures what the user explicitly teaches). This project detects what's *missing or broken* that the user may not have noticed.

## Commands

| Command | Description |
|---------|-------------|
| `yarn scan` | Run analysis (incremental, skips processed sessions) |
| `yarn scan:dry-run` | List matching sessions without API calls |
| `yarn scan -- --limit 5` | Process at most 5 sessions |
| `yarn scan -- --session <id>` | Process a single session |
| `yarn scan -- --all` | Re-process everything, ignore state |
| `yarn report` | View latest report (human-readable) |
| `yarn report -- --json` | View latest report as raw JSON |
| `yarn reset` | Clear processing state |
| `yarn build` | Compile TypeScript |

## Architecture

```
src/
├── index.ts                  # CLI entry (commander)
├── types/
│   ├── session.ts            # SessionIndexEntry, CondensedSession, RawJSONLEntry
│   ├── findings.ts           # Tier1Flag, Tier1Result, ReflectorReport
│   └── state.ts              # ReflectorState, ProcessedSessionRecord
├── scanner/
│   ├── index-reader.ts       # Glob sessions-index.json, filter entries
│   ├── session-parser.ts     # Stream JSONL → condensed conversation text
│   └── skill-catalog.ts      # Load SKILL.md frontmatter + CLAUDE.md content
├── analyzer/
│   ├── anthropic-client.ts   # Vertex AI SDK wrapper with retry
│   ├── tier1.ts              # Haiku analysis orchestrator
│   └── prompts.ts            # System/user prompt templates
├── state/
│   └── manager.ts            # Atomic JSON state persistence
└── reporter/
    └── index.ts              # JSON report output + console summary
```

## Key Patterns

- **Module system**: ESM (`"type": "module"`), all imports use `.js` extension
- **SDK**: `@anthropic-ai/vertex-sdk` with `AnthropicVertex` client, model `claude-haiku-4-5@20251001`
- **JSONL parsing**: `readline.createInterface` + `createReadStream` (same pattern as code-claude-auto-learn)
- **State persistence**: Atomic write (temp file + rename), saved after each session for crash safety
- **Truncation**: Assistant messages capped at 2000 chars; sessions over 500K chars keep first 20 + last 20 user messages
- **Naming**: kebab-case files, PascalCase types, camelCase functions

## Environment

Requires (via `gcloud auth application-default login`):
- `CLOUD_ML_REGION` - GCP region for Vertex AI
- `ANTHROPIC_VERTEX_PROJECT_ID` - GCP project ID

## Data Flow

1. **Scan** `~/.claude/projects/*/sessions-index.json` for session entries
2. **Filter** by message count (min 4), sidechain status, excluded paths
3. **Parse** JSONL files into condensed conversation text with skill usage tracking
4. **Analyze** each session with Haiku (Tier 1) against current CLAUDE.md rules + skill catalog
5. **Save state** after each session (incremental processing)
6. **Report** findings as JSON + console summary

## Finding Types

- `missing-rule` — user gave instructions repeatedly that should be in CLAUDE.md
- `skill-unused` — a skill was clearly relevant but never invoked
- `skill-correction` — a skill was used but user had to correct its behavior

## Design Principles

- **Bad recommendations are worse than none** — the analyzer must have enough context to make informed recommendations. If it can't confidently suggest a specific action, it should not flag the finding.
