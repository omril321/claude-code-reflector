# Claude Code Reflector

Analyzes Claude Code sessions to detect missing CLAUDE.md rules, unused skills, and skill corrections. Uses a two-tier architecture: Haiku for broad candidate detection, Sonnet for deep verification with full conversation context.

Sibling project to `~/private/code-claude-auto-learn` (which captures what the user explicitly teaches). This project detects what's *missing or broken* that the user may not have noticed.

## Commands

| Command | Description |
|---------|-------------|
| `yarn pipeline` | Full pipeline: scan → verify → report |
| `yarn pipeline -- --limit 50` | Full pipeline on up to 50 sessions |
| `yarn pipeline -- --concurrency 3` | Control parallel API calls (default: 5) |
| `yarn scan` | Run Tier 1 analysis (incremental, skips processed sessions) |
| `yarn scan:dry-run` | List matching sessions without API calls |
| `yarn scan -- --limit 5` | Process at most 5 sessions |
| `yarn scan -- --session <id>` | Process a single session |
| `yarn scan -- --all` | Re-process everything, ignore state |
| `yarn verify` | Deep-verify latest Tier 1 findings with Sonnet |
| `yarn verify -- --model sonnet` | Verify with specific model |
| `yarn verify -- --dry-run` | Show what would be verified |
| `yarn report` | View latest Tier 1 report (human-readable) |
| `yarn report -- --verified` | View latest verified report |
| `yarn report -- --json` | View latest report as raw JSON |
| `yarn reset` | Clear processing state |
| `yarn build` | Compile TypeScript |

## Architecture

```
src/
├── index.ts                  # CLI entry (commander)
├── types/
│   ├── session.ts            # SessionIndexEntry, CondensedSession, RawJSONLEntry
│   ├── findings.ts           # Tier1Flag, Tier2Verdict, reports
│   └── state.ts              # ReflectorState, ProcessedSessionRecord
├── scanner/
│   ├── index-reader.ts       # Session discovery (index + JSONL fallback), filter entries
│   ├── session-parser.ts     # Stream JSONL → condensed conversation text
│   └── skill-catalog.ts      # Load SKILL.md frontmatter + CLAUDE.md content
├── analyzer/
│   ├── anthropic-client.ts   # Vertex/Bedrock SDK wrapper with retry + model config
│   ├── tier1.ts              # Tier 1 (Haiku) broad analysis
│   ├── tier2.ts              # Tier 2 (Sonnet) deep verification
│   ├── prompts.ts            # Tier 1 system/user prompt templates
│   └── tier2-prompts.ts      # Tier 2 verification prompt templates
├── state/
│   └── manager.ts            # Atomic JSON state persistence
└── reporter/
    └── index.ts              # JSON report output + console summary
```

## Two-Tier Analysis

**Tier 1 — Haiku (broad sweep):** Scans sessions with truncated conversations. High recall, moderate precision. Produces candidate findings. Cheap and fast.

**Tier 2 — Sonnet (deep verification):** Takes each Tier 1 finding and verifies it against the full, untruncated session. Confirms or rejects with reasoning and evidence quotes. Only processes sessions that Tier 1 flagged.

Typical usage: `yarn pipeline -- --limit 50` (runs scan → verify → verified report in one command)

## Key Patterns

- **Module system**: ESM (`"type": "module"`), all imports use `.js` extension
- **SDK**: `@anthropic-ai/vertex-sdk` and `@anthropic-ai/bedrock-sdk` — auto-detected at runtime (see Environment section)
- **Models**: Tier 1 defaults to Haiku, Tier 2 to Sonnet. Model aliases (`haiku`, `sonnet`) resolve to provider-specific IDs automatically. Configurable via `--model` flag on verify.
- **JSONL parsing**: `readline.createInterface` + `createReadStream`
- **Concurrency**: Sessions are processed in parallel (default 5, configurable via `--concurrency`). State saves are serialized via a promise queue to prevent corruption.
- **State persistence**: Atomic write (temp file + rename), saved after each session for crash safety
- **Truncation**: Tier 1 caps assistant messages at 2000 chars, sessions over 500K chars keep first/last 20 user messages. Tier 2 uses `{ full: true }` to skip truncation (falls back to first/last 50 at 800K chars).
- **Naming**: kebab-case files, PascalCase types, camelCase functions

## Environment

Provider is auto-detected: if `ANTHROPIC_VERTEX_PROJECT_ID` is set → Vertex AI, otherwise → AWS Bedrock. The chosen provider is printed at startup.

**Vertex AI** (via `gcloud auth application-default login`):
- `ANTHROPIC_VERTEX_PROJECT_ID` - GCP project ID (presence of this var selects Vertex)
- `CLOUD_ML_REGION` - GCP region for Vertex AI

**AWS Bedrock** (via standard AWS credential chain):
- `AWS_REGION` - AWS region (defaults to `us-east-1`)
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` - or use `~/.aws/credentials`

## Data Flow

1. **Scan** `~/.claude/projects/*/sessions-index.json` for session entries; fall back to scanning `*.jsonl` files directly when the index is missing
2. **Filter** by message count (min 4), sidechain status, excluded paths
3. **Parse** JSONL files into condensed conversation text with skill usage tracking
4. **Analyze** each session with Haiku (Tier 1) against current CLAUDE.md rules + full skill catalog
5. **Save state** after each session (incremental processing)
6. **Report** Tier 1 findings as JSON + console summary
7. **Verify** (optional) — Tier 2 reads full untruncated sessions and confirms/rejects each finding
8. **Verified report** — only confirmed findings with refined recommendations and evidence

## Session JSONL Schema

Key fields in `~/.claude/projects/*/*.jsonl` entries used by `index-reader.ts` and `session-parser.ts`:

| Field | Location | Description |
|-------|----------|-------------|
| `cwd` | Top-level | Project working directory (used as `projectPath`) |
| `sessionId` | Top-level | Session identifier (also derivable from filename) |
| `timestamp` | Top-level | ISO timestamp of the entry |
| `gitBranch` | Top-level | Git branch at time of session |
| `isSidechain` | Top-level | Whether this is a sidechain session |
| `type` | Top-level | Entry type: `"summary"`, `"progress"`, or omitted for messages |
| `message.role` | Nested | `"user"`, `"assistant"`, or `"system"` |
| `message.content` | Nested | String or array of content blocks (`{type: "text", text: "..."}`, `{type: "tool_use", ...}`, etc.) |

`sessions-index.json` may not exist in all project directories. The fallback in `index-reader.ts` reconstructs `SessionIndexEntry` from these JSONL fields directly.

## Finding Types

- `missing-rule` — user gave instructions that should be permanent CLAUDE.md rules
- `skill-unused` — a skill was relevant but never invoked, and its triggering description doesn't cover the scenario
- `skill-correction` — a skill was used but user had to correct its behavior

## Design Principles

- **Bad recommendations are worse than none** — the analyzer must have enough context to make informed recommendations. If it can't confidently suggest a specific action, it should not flag the finding.
- **Precision over recall in final output** — Tier 1 casts a wide net, Tier 2 filters aggressively. Only verified findings reach the user.
- **CLAUDE.md is a last resort** — prefer skill updates over new rules. Only flag genuinely non-obvious, user-specific preferences.
