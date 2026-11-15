import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Scanner } from '../lib/scanner.js';
import { DuplicateFinder } from '../lib/duplicates.js';
import { Organizer } from '../lib/organizer.js';
import { Cleanup } from '../lib/cleanup.js';
import { DAY_MS, STREAM_THRESHOLD } from '../lib/utils.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-organizer-test-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const src = path.join(root, 'src');
  await fs.mkdir(path.join(src, 'nested'), { recursive: true });
  return { root, src };
}

async function fileHash(filePath) {
  const data = await fs.readFile(filePath); // test helper only; app never uses readFile for hashing.
  return crypto.createHash('sha256').update(data).digest('hex');
}

test('scan: recursive totals, extension groups, ages, largest files and oldest file', async t => {
  const { src } = await fixture(t);
  const old = path.join(src, 'old.txt');
  await fs.writeFile(old, '12345678');
  await fs.writeFile(path.join(src, 'nested', 'recent.JPG'), '123');
  await fs.writeFile(path.join(src, 'nested', 'no-extension'), '1');
  const oldDate = new Date(Date.now() - 120 * DAY_MS);
  await fs.utimes(old, oldDate, oldDate);
  const scanner = new Scanner();
  let seen = 0;
  let complete = false;
  scanner.on('file-found', () => seen++);
  scanner.on('scan-complete', () => { complete = true; });
  const result = await scanner.scan(src);
  assert.equal(result.totalFiles, 3);
  assert.equal(result.totalSize, 12);
  assert.equal(result.byType.get('.jpg').count, 1);
  assert.equal(result.byType.get('(other)').count, 1);
  assert.equal(result.age.last7Days, 2);
  assert.equal(result.age.last30Days, 2);
  assert.equal(result.age.olderThan90Days, 1);
  assert.equal(result.largestFiles[0].path, old);
  assert.equal(result.oldestFile.path, old);
  assert.equal(seen, 3);
  assert.equal(complete, true);
});

test('duplicates: SHA-256 streaming detects equal contents with different names', async t => {
  const { src } = await fixture(t);
  await fs.writeFile(path.join(src, 'one.txt'), 'exactly equal');
  await fs.writeFile(path.join(src, 'nested', 'two.pdf'), 'exactly equal');
  await fs.writeFile(path.join(src, 'three.txt'), 'distinct');
  const finder = new DuplicateFinder();
  let processed = 0;
  finder.on('file-processed', () => processed++);
  const result = await finder.find(src);
  assert.equal(processed, 3);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].files.length, 2);
  assert.equal(result.totalWastedBytes, Buffer.byteLength('exactly equal'));
  assert.equal(result.groups[0].hash.length, 64);
});

test('organize: categories, collisions, large streaming, original unchanged and EventEmitter', async t => {
  const { root, src } = await fixture(t);
  const output = path.join(root, 'out');
  const first = path.join(src, 'notes.txt');
  const second = path.join(src, 'nested', 'notes.txt');
  const big = path.join(src, 'nested', 'video.MP4');
  await fs.writeFile(first, 'one');
  await fs.writeFile(second, 'two');
  await fs.writeFile(path.join(src, 'unknown.xyz'), 'other');
  const handle = await fs.open(big, 'w');
  try { await handle.truncate(STREAM_THRESHOLD + 4); } finally { await handle.close(); }
  const organizer = new Organizer();
  let started = 0;
  let completed = 0;
  organizer.on('copy-start', () => started++);
  organizer.on('copy-complete', () => completed++);
  const result = await organizer.organize(src, output);
  assert.equal(result.failedFiles, 0);
  assert.equal(result.copiedFiles, 4);
  assert.equal(started, 4);
  assert.equal(completed, 4);
  assert.equal(result.countByCategory.Documents, 2);
  assert.equal(result.countByCategory.Videos, 1);
  assert.equal(result.countByCategory.Other, 1);
  const copies = [await fs.readFile(path.join(output, 'Documents', 'notes.txt'), 'utf8'),
    await fs.readFile(path.join(output, 'Documents', 'notes(1).txt'), 'utf8')];
  assert.deepEqual(copies.sort(), ['one', 'two']);
  assert.equal(await fileHash(big), await fileHash(path.join(output, 'Videos', 'video.MP4')));
  assert.equal((await fs.stat(big)).size, STREAM_THRESHOLD + 4);
  // A repeat cannot overwrite existing copies and gets a new numeric suffix.
  const result2 = await organizer.organize(src, output);
  assert.equal(result2.copiedFiles, 4);
  assert.equal((await fs.readdir(path.join(output, 'Documents'))).length, 4);
  await assert.rejects(organizer.organize(src, src), /outside the source/);
  await assert.rejects(organizer.organize(src, path.join(src, 'output')), /outside the source/);
});

test('cleanup: dry run preserves files; confirmed run deletes only old files', async t => {
  const { src } = await fixture(t);
  const old = path.join(src, 'nested', 'old.log');
  const recent = path.join(src, 'new.log');
  await fs.writeFile(old, 'old file');
  await fs.writeFile(recent, 'recent');
  const oldDate = new Date(Date.now() - 150 * DAY_MS);
  await fs.utimes(old, oldDate, oldDate);
  const cleaner = new Cleanup();
  let found = 0;
  let deleted = 0;
  cleaner.on('file-found', () => found++);
  cleaner.on('file-deleted', () => deleted++);
  const preview = await cleaner.cleanup(src, 90);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.matches.length, 1);
  assert.equal(preview.deletedFiles, 0);
  await fs.stat(old);
  const final = await cleaner.cleanup(src, 90, true);
  assert.equal(final.deletedFiles, 1);
  assert.equal(deleted, 1);
  assert.equal(found, 2);
  await assert.rejects(fs.stat(old), { code: 'ENOENT' });
  await fs.stat(recent);
});

test('CLI: help, invalid path, and missing arguments produce correct exit status', async t => {
  const { src } = await fixture(t);
  const cli = path.resolve('file-organizer.js');
  const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help, /cleanup/);
  const scanned = execFileSync(process.execPath, [cli, 'scan', src], { encoding: 'utf8' });
  assert.match(scanned, /Total files: 0/);
  assert.throws(() => execFileSync(process.execPath, [cli, 'scan', path.join(src, 'missing')], { stdio: 'pipe' }), e => e.status === 1);
  assert.throws(() => execFileSync(process.execPath, [cli, 'organize', src], { stdio: 'pipe' }), e => e.status === 1);
});
