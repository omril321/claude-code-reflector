# Claude Code Reflector

Automatically analyzes your Claude Code sessions to find gaps in your setup — missing CLAUDE.md rules, skills that should have been used but weren't, and skills that need updating.

You interact with Claude Code every day, giving corrections and preferences along the way. Most of these fade into session history. Reflector surfaces the ones that should become permanent configuration.

## How It Works

Reflector uses a two-tier analysis pipeline:

1. **Tier 1 (Haiku)** — Fast, cheap sweep across sessions. Reads truncated conversations and flags candidate findings. High recall — catches more than needed, including some noise.

2. **Tier 2 (Sonnet)** — Deep verification. Takes each candidate finding and re-reads the full, untruncated session. Confirms or rejects each finding with reasoning and evidence quotes from the conversation.

The result: only verified, actionable findings reach you.

## What It Finds

| Finding Type | What It Means | Example |
|---|---|---|
| **missing-rule** | You gave an instruction that should be a permanent CLAUDE.md rule | "Always use yarn, not npm" |
| **skill-unused** | A skill was relevant but never invoked, and its triggering description doesn't cover the scenario | Documentation-updater skill not triggered for "verify docs against code" |
| **skill-correction** | A skill was used but you had to correct its behavior | Slidev skill produced wrong image layout proportions |

## Quick Start

### Prerequisites

- Node.js 20+
- GCP credentials with Vertex AI access:
  ```bash
  gcloud auth application-default login
  ```
- Environment variables:
  ```bash
  export CLOUD_ML_REGION=your-region          # e.g., europe-west1
  export ANTHROPIC_VERTEX_PROJECT_ID=your-project-id
  ```

### Install & Build

```bash
yarn install
yarn build
```

### Run

```bash
# Full pipeline: scan → verify → report (one command)
yarn pipeline -- --limit 30
```

## Commands

```bash
# Full pipeline (recommended)
yarn pipeline                          # Scan → verify → report in one command
yarn pipeline -- --limit 50            # Process up to 50 sessions
yarn pipeline -- --all --limit 50      # Re-process from scratch
yarn pipeline -- --concurrency 3       # Limit parallel API calls (default: 5)

# Individual steps (if you need more control)
yarn scan                         # Tier 1 only (incremental)
yarn scan -- --limit 20           # Tier 1 with limit
yarn scan -- --concurrency 3      # Control parallelism
yarn scan -- --all                # Re-process everything
yarn scan -- --session <id>       # Process a single session
yarn scan:dry-run                 # List matching sessions without API calls
yarn verify                       # Tier 2 only (verifies latest scan)
yarn verify -- --model sonnet     # Verify with specific model
yarn verify -- --dry-run          # Show what would be verified

# Reports
yarn report                       # View latest Tier 1 report
yarn report -- --verified         # View verified report
yarn report -- --json             # Raw JSON output

# Maintenance
yarn reset                        # Clear processing state
yarn build                        # Compile TypeScript
```

## Typical Workflow

```bash
# 1. Run the full pipeline
yarn pipeline -- --limit 50

# 2. Act on verified findings:
#    - missing-rule → add the rule to your CLAUDE.md
#    - skill-unused → update the skill's triggering description
#    - skill-correction → update the skill's behavior

# 3. Next time, run picks up where you left off
yarn pipeline -- --limit 50
```

## Architecture

```
src/
├── index.ts                  # CLI entry (commander)
├── scanner/
│   ├── index-reader.ts       # Discover sessions from ~/.claude/projects/
│   ├── session-parser.ts     # Stream JSONL → conversation text
│   └── skill-catalog.ts      # Load skills + CLAUDE.md
├── analyzer/
│   ├── anthropic-client.ts   # Vertex AI SDK wrapper (model config, retry, pricing)
│   ├── tier1.ts              # Haiku broad analysis
│   ├── tier2.ts              # Sonnet deep verification
│   ├── prompts.ts            # Tier 1 prompt templates
│   └── tier2-prompts.ts      # Tier 2 prompt templates
├── state/
│   └── manager.ts            # Incremental processing state
├── reporter/
│   └── index.ts              # Report generation + console output
└── types/
    ├── findings.ts           # Finding types (Tier1Flag, Tier2Verdict, reports)
    ├── session.ts            # Session types
    └── state.ts              # State types
```

## Cost

Approximate costs per run (Vertex AI pricing):

| Step | Model | Cost per session | Notes |
|---|---|---|---|
| Tier 1 scan | Haiku | ~$0.05 | Truncated context, fast |
| Tier 2 verify | Sonnet | ~$0.04 | Full context, only flagged sessions |

A typical run of 50 sessions with 5 findings costs roughly **$2.50 scan + $0.20 verify = $2.70 total**.

## How Sessions Are Processed

1. Reads `~/.claude/projects/*/sessions-index.json` to discover sessions
2. Filters by message count (min 4), excludes sidechains and configured paths
3. Parses JSONL files into conversation text, tracking which skills were invoked
4. Sends each session to Haiku with the current CLAUDE.md rules and full skill catalog as context
5. Saves state after each session (crash-safe atomic writes)
6. Verification reads the full untruncated session and confirms/rejects each finding
