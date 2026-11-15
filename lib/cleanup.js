import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ageDays, formatError, listFiles } from './utils.js';

export class Cleanup extends EventEmitter {
  async cleanup(directory, olderThanDays, confirm = false) {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      throw new Error('--older-than must be a non-negative number of days.');
    }
    const files = await listFiles(directory);
    const now = Date.now();
    const matches = [];
    this.emit('cleanup-start', { directory: path.resolve(directory), olderThanDays, total: files.length, confirm });
    for (let index = 0; index < files.length; index++) {
      const filePath = files[index];
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        throw new Error(`Unable to inspect file: ${formatError(error, filePath)}`, { cause: error });
      }
      if (!stat.isFile()) continue;
      const days = ageDays(stat.mtime, now);
      if (days > olderThanDays) {
        const candidate = { path: filePath, size: stat.size, mtime: stat.mtime, daysOld: days };
        matches.push(candidate);
        this.emit('file-found', candidate);
      }
    }
    const result = {
      directory: path.resolve(directory), olderThanDays, dryRun: !confirm,
      matches, candidateBytes: matches.reduce((sum, item) => sum + item.size, 0),
      deletedFiles: 0, deletedBytes: 0, failedFiles: 0, errors: []
    };
    this.emit('candidates-ready', result);
    if (confirm) {
      for (let i = 0; i < matches.length; i++) {
        const candidate = matches[i];
        try {
          // Guard against deleting a file that was modified/replaced while scanning.
          const current = await fs.lstat(candidate.path);
          if (!current.isFile() || current.size !== candidate.size || current.mtime.getTime() !== candidate.mtime.getTime()) {
            throw new Error('File changed since the scan; skipped for safety');
          }
          await fs.unlink(candidate.path);
          result.deletedFiles++;
          result.deletedBytes += candidate.size;
          this.emit('file-deleted', { ...candidate, current: i + 1, total: matches.length });
        } catch (error) {
          result.failedFiles++;
          const failure = { path: candidate.path, message: formatError(error, candidate.path) };
          result.errors.push(failure);
          this.emit('delete-error', { ...failure, current: i + 1, total: matches.length });
        }
      }
    }
    this.emit('cleanup-complete', result);
    return result;
  }
}
