#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scanner } from './lib/scanner.js';
import { DuplicateFinder } from './lib/duplicates.js';
import { Organizer, CATEGORIES } from './lib/organizer.js';
import { Cleanup } from './lib/cleanup.js';
import { ageDays, formatProgress, formatSize, progressReporter } from './lib/utils.js';

const HELP = `File Organizer CLI v1.0.0

Usage:
  node file-organizer.js scan <directory>
  node file-organizer.js duplicates <directory>
  node file-organizer.js organize <source> --output <target>
  node file-organizer.js cleanup <directory> --older-than <days> [--confirm]
  node file-organizer.js --help

Notes:
  - All commands scan subdirectories recursively (symlinks are skipped).
  - organize COPIES files; it never removes source files.
  - cleanup previews files by default; only --confirm actually deletes.
  - Large files (>= 10 MiB) are copied using streams.
`;

function optionsFor(args, optionsWithValues, booleanOptions = []) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (optionsWithValues.includes(token)) {
      if (options[token] !== undefined) throw new Error(`Repeated option: ${token}`);
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${token}`);
      options[token] = args[++i];
    } else if (booleanOptions.includes(token)) {
      if (options[token]) throw new Error(`Repeated option: ${token}`);
      options[token] = true;
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      positionals.push(token);
    }
  }
  return { options, positionals };
}

function needOneDirectory(positionals) {
  if (positionals.length !== 1) throw new Error('Exactly one directory path is required. See --help.');
  return positionals[0];
}

async function runScan(directory) {
  const scanner = new Scanner();
  const progress = progressReporter('Processing...');
  scanner.on('scan-start', ({ directory: dir, total }) => {
    console.log(`📂 Scanning: ${dir}`);
    progress.update(0, total);
  });
  scanner.on('file-found', ({ current, total }) => progress.update(current, total));
  scanner.on('scan-complete', () => progress.finish());
  const result = await scanner.scan(directory);
  console.log(`\n📊 Scan Results:\n${'━'.repeat(42)}`);
  console.log(`Total files: ${result.totalFiles}\nTotal size: ${formatSize(result.totalSize)}`);
  console.log('\nBy File Type:');
  for (const [ext, group] of [...result.byType].sort((a, b) => b[1].totalSize - a[1].totalSize)) {
    console.log(`  ${ext.padEnd(10)} ${String(group.count).padStart(5)} files   ${formatSize(group.totalSize)}`);
  }
  console.log(`\nFile Age:\n  Last 7 days: ${result.age.last7Days}\n  Last 30 days: ${result.age.last30Days}\n  Older than 90 days: ${result.age.olderThan90Days}`);
  console.log('\nLargest files:');
  if (!result.largestFiles.length) console.log('  (none)');
  result.largestFiles.forEach((f, i) => console.log(`  ${i + 1}. ${f.path} — ${formatSize(f.size)}`));
  console.log(result.oldestFile
    ? `\nOldest file: ${result.oldestFile.path} (modified ${Math.floor(ageDays(result.oldestFile.mtime))} days ago)`
    : '\nOldest file: (none)');
}

async function runDuplicates(directory) {
  const finder = new DuplicateFinder();
  const progress = progressReporter('Calculating hashes...');
  finder.on('search-start', ({ directory: dir, total }) => {
    console.log(`🔍 Searching for duplicates in: ${dir}`);
    progress.update(0, total);
  });
  finder.on('file-processed', ({ current, total }) => progress.update(current, total));
  finder.on('duplicates-found', () => progress.finish());
  const result = await finder.find(directory);
  console.log(`\nFound ${result.groups.length} duplicate group(s) (${formatSize(result.totalWastedBytes)} wasted):`);
  result.groups.forEach((group, index) => {
    console.log(`\n${'━'.repeat(42)}\nGroup ${index + 1} (${group.files.length} copies, ${formatSize(group.size)} each):`);
    console.log(`SHA-256: ${group.hash}`);
    group.files.forEach(file => console.log(`  📄 ${file.path}`));
    console.log(`Wasted space: ${formatSize(group.wastedBytes)}`);
  });
  console.log(`\n💾 Total wasted space: ${formatSize(result.totalWastedBytes)}`);
}

async function runOrganize(source, output) {
  const organizer = new Organizer();
  const progress = progressReporter('Copying files...');
  organizer.on('organize-start', ({ source: dir, output: out, total }) => {
    console.log(`📦 Organizing: ${dir}\nTarget: ${out}`);
    console.log('Created folders: ' + Object.keys(CATEGORIES).join(', '));
    progress.update(0, total);
  });
  organizer.on('copy-complete', ({ current, total }) => progress.update(current, total));
  organizer.on('copy-error', ({ current, total, message }) => {
    progress.update(current, total);
    console.error(`\nCopy failed: ${message}`);
  });
  organizer.on('organize-complete', () => progress.finish());
  const result = await organizer.organize(source, output);
  console.log(`\n${result.failedFiles ? '⚠️' : '✅'} Organization complete!\nSummary:`);
  for (const [category, count] of Object.entries(result.countByCategory)) {
    console.log(`  ${category}: ${count} file(s) → ${path.join(result.output, category)}`);
  }
  console.log(`Total copied: ${result.copiedFiles} files (${formatSize(result.copiedBytes)})`);
  if (result.failedFiles) {
    console.error(`Failed: ${result.failedFiles} file(s)`);
    process.exitCode = 1;
  }
}

async function runCleanup(directory, days, confirm) {
  const cleanup = new Cleanup();
  cleanup.on('cleanup-start', ({ directory: dir, olderThanDays }) => {
    console.log(`🧹 Cleanup: ${dir}\nLooking for files older than ${olderThanDays} days...`);
  });
  cleanup.on('file-found', file => console.log(`  ${file.path}\n    Size: ${formatSize(file.size)}  Modified: ${Math.floor(file.daysOld)} days ago (${file.mtime.toISOString().slice(0, 10)})`));
  const progress = progressReporter('Deleting...');
  cleanup.on('candidates-ready', result => {
    console.log(`\nFound ${result.matches.length} file(s), ${formatSize(result.candidateBytes)} total.`);
    if (confirm) {
      console.log('⚠️ DELETING: This action cannot be undone!');
      progress.update(0, result.matches.length);
    }
  });
  cleanup.on('file-deleted', ({ current, total }) => progress.update(current, total));
  cleanup.on('delete-error', ({ current, total, message }) => {
    progress.update(current, total);
    console.error(`\nDelete failed: ${message}`);
  });
  cleanup.on('cleanup-complete', () => progress.finish());
  const result = await cleanup.cleanup(directory, days, confirm);
  if (result.dryRun) {
    console.log('\n⚠️ DRY RUN MODE: No files were deleted. Add --confirm to delete them.');
  } else {
    console.log(`\n✅ Cleanup complete! Deleted ${result.deletedFiles} file(s) (${formatSize(result.deletedBytes)} freed).`);
    if (result.failedFiles) {
      console.error(`Failed: ${result.failedFiles} file(s)`);
      process.exitCode = 1;
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return;
  }
  switch (command) {
    case 'scan': {
      const { options, positionals } = optionsFor(rest, []);
      if (Object.keys(options).length) throw new Error('scan does not take options.');
      await runScan(needOneDirectory(positionals));
      break;
    }
    case 'duplicates': {
      const { positionals } = optionsFor(rest, []);
      await runDuplicates(needOneDirectory(positionals));
      break;
    }
    case 'organize': {
      const { options, positionals } = optionsFor(rest, ['--output']);
      const source = needOneDirectory(positionals);
      if (!options['--output']) throw new Error('organize requires --output <directory>.');
      await runOrganize(source, options['--output']);
      break;
    }
    case 'cleanup': {
      const { options, positionals } = optionsFor(rest, ['--older-than'], ['--confirm']);
      const directory = needOneDirectory(positionals);
      if (!options['--older-than']) throw new Error('cleanup requires --older-than <days>.');
      const days = Number(options['--older-than']);
      if (!Number.isFinite(days) || days < 0) throw new Error('--older-than must be a non-negative number.');
      await runCleanup(directory, days, Boolean(options['--confirm']));
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}. See --help.`);
  }
}

// Run only when executed as CLI, not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exitCode = 1;
  }
}
