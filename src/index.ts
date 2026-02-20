#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readAllSessionEntries } from './scanner/index-reader.js';
import { parseSession } from './scanner/session-parser.js';
import { loadContext } from './scanner/skill-catalog.js';
import { analyzeTier1 } from './analyzer/tier1.js';
import { loadState, saveState, isSessionProcessed, markSessionProcessed } from './state/manager.js';
import { writeReport, printSummary, printLatestReport } from './reporter/index.js';
import { DEFAULT_STATE } from './types/state.js';
import type { Tier1Result } from './types/findings.js';
import { promises as fs } from 'fs';
import { join } from 'path';

const DEFAULT_EXCLUDES = ['/Users/omrila/private/claude-code-reflector'];
const DEFAULT_MIN_MESSAGES = 4;

const PROJECT_DIR = join(import.meta.dirname, '..');
const STATE_FILE = join(PROJECT_DIR, 'state.json');

const program = new Command();

program
  .name('reflector')
  .description('Analyze Claude Code sessions to surface missing rules and skill gaps')
  .version('0.1.0');

program
  .command('scan')
  .description('Scan and analyze Claude Code sessions')
  .option('--all', 'Ignore state, process all sessions')
  .option('--dry-run', 'List sessions without calling AI')
  .option('--exclude <paths...>', 'Project paths to exclude', DEFAULT_EXCLUDES)
  .option('--min-messages <n>', 'Minimum message count', String(DEFAULT_MIN_MESSAGES))
  .option('--session <id>', 'Process a single session by ID')
  .option('--limit <n>', 'Maximum sessions to process')
  .action(async (opts) => {
    const minMessages = parseInt(opts.minMessages, 10);
    const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;

    const spinner = ora('Scanning sessions...').start();

    const entries = await readAllSessionEntries({
      excludedPaths: opts.exclude,
      minMessages,
      sessionId: opts.session,
    });

    spinner.succeed(`Found ${entries.length} sessions matching filters`);

    if (entries.length === 0) {
      console.log(chalk.yellow('No sessions to process.'));
      return;
    }

    // Load state for incremental processing
    const state = opts.all ? { ...DEFAULT_STATE, processedSessions: {} } : await loadState();

    // Filter out already-processed sessions
    let toProcess = entries.filter(
      e => !isSessionProcessed(state, e.sessionId, e.modified),
    );

    if (toProcess.length === 0) {
      console.log(chalk.green('All matching sessions already processed. Use --all to re-process.'));
      return;
    }

    if (limit) {
      toProcess = toProcess.slice(0, limit);
    }

    console.log(`Processing ${chalk.cyan(toProcess.length)} session(s)...`);

    if (opts.dryRun) {
      console.log();
      for (const entry of toProcess) {
        console.log(`  ${chalk.dim(entry.sessionId.slice(0, 8))} ${entry.summary || entry.firstPrompt.slice(0, 60)}`);
        console.log(`    ${chalk.dim(`${entry.messageCount} messages | ${entry.projectPath} | ${entry.modified}`)}`);
      }
      console.log();
      console.log(chalk.dim(`(dry run - no API calls made)`));
      return;
    }

    // Load context for analysis
    const context = await loadContext();
    const results: Tier1Result[] = [];

    for (let i = 0; i < toProcess.length; i++) {
      const entry = toProcess[i];
      const label = `[${i + 1}/${toProcess.length}] ${entry.summary || entry.sessionId.slice(0, 8)}`;
      const sessionSpinner = ora(label).start();

      try {
        const session = await parseSession(entry);

        if (!session.conversationText.trim()) {
          sessionSpinner.warn(`${label} - empty conversation, skipping`);
          continue;
        }

        const result = await analyzeTier1(session, context);
        results.push(result);

        // Save state after each session (crash-safe)
        markSessionProcessed(state, entry.sessionId, entry.modified, result.flags.length);
        await saveState(state);

        if (result.flags.length > 0) {
          sessionSpinner.succeed(`${label} - ${chalk.yellow(`${result.flags.length} finding(s)`)}`);
        } else {
          sessionSpinner.succeed(`${label} - ${chalk.green('clean')}`);
        }
      } catch (err) {
        sessionSpinner.fail(`${label} - ${chalk.red((err as Error).message)}`);
      }
    }

    // Write report
    if (results.length > 0) {
      const reportPath = await writeReport(results);
      console.log(chalk.dim(`Report saved to: ${reportPath}`));
      printSummary(results);
    } else {
      console.log(chalk.yellow('No sessions were analyzed.'));
    }
  });

program
  .command('report')
  .description('View the latest report')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await printLatestReport(opts.json);
  });

program
  .command('reset')
  .description('Clear processing state')
  .action(async () => {
    try {
      await fs.unlink(STATE_FILE);
      console.log(chalk.green('State cleared.'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log(chalk.dim('No state file found.'));
      } else {
        throw err;
      }
    }
  });

program.parse();
