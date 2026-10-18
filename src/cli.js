/**
 * optipack CLI.
 *
 *   optipack <inputPackDir> <outputPackDir> [options]
 *   optipack bench <inputPackDir> [options]
 *
 * Exit codes: 0 success Â· 1 usage/config error Â· 2 parse failure Â· 3 internal error
 */
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

import { loadConfigFile, mergeCliOverrides, LEVELS } from './config.js';
import { runPack, ParseFailureError, InternalError } from './pipeline.js';
import { PASS_IDS, PASS_CODES } from './passes/index.js';
import { unifiedDiff } from './diff.js';

function parseBoolOpt(v) {
  if (v === 'true' || v === '' || v === undefined) return true;
  if (v === 'false') return false;
  // Signal an invalid value; validated by the caller.
  return v;
}

function parseOptInt(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function runOptimize(inputDir, outputDir, opts) {
  try {
    const exit = await runOptimizeInner(inputDir, outputDir, opts);
    process.exitCode = exit;
    return exit;
  } catch (e) {
    process.exitCode = 3;
    console.error(`optipack: internal error â€” ${e && e.stack ? e.stack : String(e)}`);
    return 3;
  }
}

async function runOptimizeInner(inputDir, outputDir, opts) {
  if (!inputDir || !outputDir) {
    console.error('optipack: both <inputPackDir> and <outputPackDir> are required');
    return 1;
  }
  if (opts.level !== undefined && !LEVELS.includes(opts.level)) {
    console.error(`optipack: invalid --level "${opts.level}" (expected one of ${LEVELS.join(', ')})`);
    return 1;
  }
  if (opts.lint !== undefined && typeof opts.lint !== 'boolean') {
    console.error('optipack: --lint expects true or false');
    return 1;
  }

  // Resolve config file: explicit path, else ./optipack.config.json.
  let configPath = opts.config;
  if (configPath && !fs.existsSync(configPath)) {
    console.error(`optipack: config file not found: ${configPath}`);
    return 1;
  }
  let config;
  try {
    const loaded = loadConfigFile(configPath);
    config = loaded.config;
    configPath = loaded.path;
  } catch (e) {
    console.error(`optipack: ${e.message}`);
    return 1;
  }

  const cli = {
    level: opts.level,
    only: opts.only,
    except: opts.except,
    lint: opts.lint,
    config: configPath,
  };
  try {
    config = mergeCliOverrides(config, cli, PASS_IDS, PASS_CODES);
  } catch (e) {
    console.error(`optipack: ${e.message}`);
    return 1;
  }

  const dryRun = !!opts.dryRun;
  const reportPath = opts.report !== undefined
    ? opts.report
    : path.join(outputDir, 'optipack-report.json');

  // Capture original sources for --diff.
  const beforeSources = new Map();
  if (opts.diff) {
    const { walkPack } = await import('./pack-walker.js');
    if (fs.existsSync(inputDir)) {
      const { scripts } = walkPack(inputDir);
      for (const s of scripts) beforeSources.set(s.relPath, fs.readFileSync(s.abs, 'utf8'));
    }
  }

  try {
    const report = runPack(inputDir, outputDir, config, { dryRun });
    const json = report.serialize();

    if (dryRun) {
      if (opts.report !== undefined) {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, json);
        console.log(`optipack: dry run â€” wrote report to ${reportPath} (no pack files written)`);
      } else {
        console.log(json);
      }
    } else {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, json);
    }

    if (opts.diff) {
      const { walkPack } = await import('./pack-walker.js');
      const { scripts } = walkPack(inputDir);
      for (const s of scripts) {
        const outAbs = path.join(outputDir, s.relPath);
        if (!fs.existsSync(outAbs)) continue;
        const after = fs.readFileSync(outAbs, 'utf8');
        const before = beforeSources.get(s.relPath) ?? '';
        const d = unifiedDiff(s.relPath, s.relPath, before, after);
        if (d) process.stdout.write(d);
      }
    }

    if (!dryRun || opts.report !== undefined) {
      const t = report.totals;
      console.log(
        `optipack: ${report.files.length} script file(s), level ${report.level}, ` +
        `${t.transforms} transform(s) applied, ${t.bails} bail(s), ${t.warnings} warning(s)`
      );
      console.log(`optipack: report written to ${reportPath}${dryRun ? ' (dry run: no pack files written)' : ''}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof ParseFailureError) {
      console.error(`optipack: parse failure â€” ${e.message}`);
      return 2;
    }
    if (e instanceof InternalError) {
      console.error(`optipack: internal error â€” ${e.message}`);
      return 3;
    }
    if (e && e.code === 1) {
      console.error(`optipack: ${e.message}`);
      return 1;
    }
    console.error(`optipack: internal error â€” ${e && e.stack ? e.stack : String(e)}`);
    return 3;
  }
}

async function runBench(packDir, opts) {
  const run = async () => {
    const { benchPack } = await import('./bench.js');
    const result = await benchPack(packDir, {
      ticks: opts.ticks,
      entry: opts.entry,
      scenario: opts.scenario,
      config: opts.config && JSON.parse(fs.readFileSync(opts.config, 'utf8').replace(/^\uFEFF/, '')),
      level: opts.level,
    });
    if (opts.json) {
      fs.mkdirSync(path.dirname(opts.json), { recursive: true });
      fs.writeFileSync(opts.json, JSON.stringify(result, null, 2) + '\n');
      console.log(`optipack bench: JSON written to ${opts.json}`);
    }
    return result.effectsIdentical ? 0 : 1;
  };
  try {
    const code = await run();
    process.exitCode = code;
    return code;
  } catch (e) {
    const code = e instanceof ParseFailureError ? 2
      : e instanceof InternalError ? 3
        : 1;
    console.error(`optipack bench: ${e instanceof ParseFailureError || e instanceof InternalError ? e.message : (e && e.message ? e.message : String(e))}`);
    process.exitCode = code;
    return code;
  }
}

export async function main(argv) {
  const program = new Command();
  program
    .name('optipack')
    .description('QuickJS-targeted micro-optimizing pre-processor for Minecraft Bedrock behavior-pack scripts')
    .version('1.0.0')
    .exitOverride()
    .configureOutput({ writeErr: () => {} }); // actions print errors themselves

  program
    .command('bench')
    .description('A/B benchmark: original vs optimized scripts under the harness mock (boundary crossings + indicative wall time). See BENCHMARKING.md for the in-game workflow.')
    .argument('<inputPackDir>', 'behavior pack directory to benchmark')
    .option('--ticks <n>', 'simulated ticks to run (default 200)', parseOptInt)
    .option('--entry <path>', 'script entry to load (default: manifest script entry)')
    .option('--scenario <path>', 'scenario JSON (reads/state/steps) driving events between ticks')
    .option('--json <path>', 'also write the bench result as JSON to this path')
    .option('--level <level>', 'optimization level for the optimized build')
    .option('--config <path>', 'config file for the optimized build')
    .action(function (packDir, cmdOpts, command) {
      // --level is declared on both this subcommand and the default command;
      // Commander absorbs shadowed names into the parent scope, so merge.
      return runBench(packDir, command.optsWithGlobals());
    });

  program
    .argument('<inputPackDir>', 'behavior pack directory to read')
    .argument('<outputPackDir>', 'directory to write the optimized pack into')
    .option('--level <level>', 'optimization level: safe | balanced | risky')
    .option('--config <path>', 'config file (default: ./optipack.config.json when present)')
    .option('--only <ids>', 'comma-separated transform ids to run exclusively')
    .option('--except <ids>', 'comma-separated transform ids to skip')
    .option('--dry-run', 'analyze + report, write nothing (prints report to stdout unless --report is given)')
    .option('--diff', 'print unified diffs per changed file')
    .option('--report <path>', 'report file (default: <outputPackDir>/optipack-report.json)')
    .option('--lint <bool>', 'enable/disable the lint pass (true|false)', parseBoolOpt)
    .action((inputDir, outputDir) => runOptimize(inputDir, outputDir, program.opts()));

  try {
    await program.parseAsync(argv, { from: 'node' });
  } catch (e) {
    if (e && e.code === 'commander.version') {
      console.log(e.message);
      return 0;
    }
    if (e && (e.code === 'commander.help' || e.code === 'commander.helpDisplayed')) {
      return 0;
    }
    if (e && (e.code === 'commander.missingArgument' || e.code === 'commander.missingSubcommandArgument')) {
      console.error(`optipack: ${e.message}`);
      return 1;
    }
    console.error(`optipack: ${e && e.message ? e.message : String(e)}`);
    return 1;
  }
  return process.exitCode ?? 0;
}
