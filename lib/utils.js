import fs from 'node:fs/promises';
import path from 'node:path';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const STREAM_THRESHOLD = 10 * 1024 * 1024;

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatError(error, filePath = '') {
  const location = filePath || error.path || '';
  const suffix = location ? ` (${location})` : '';
  switch (error.code) {
    case 'ENOENT': return `Path not found${suffix}`;
    case 'EACCES':
    case 'EPERM': return `Permission denied${suffix}`;
    case 'ENOTDIR': return `Expected a directory${suffix}`;
    case 'EISDIR': return `Expected a file${suffix}`;
    case 'ENOSPC': return `Not enough disk space${suffix}`;
    case 'EROFS': return `Read-only filesystem${suffix}`;
    case 'EEXIST': return `File already exists${suffix}`;
    default: return `${error.message}${suffix}`;
  }
}

export async function ensureDirectory(directory) {
  const absolute = path.resolve(directory);
  try {
    const stats = await fs.stat(absolute);
    if (!stats.isDirectory()) {
      const error = new Error(`Not a directory: ${absolute}`);
      error.code = 'ENOTDIR';
      throw error;
    }
  } catch (error) {
    throw new Error(formatError(error, absolute), { cause: error });
  }
  return absolute;
}

// Do not traverse symbolic links: prevents loops and operating on unexpected targets.
export async function listFiles(directory) {
  const root = await ensureDirectory(directory);
  const results = [];

  async function visit(folder) {
    let entries;
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Cannot read directory: ${formatError(error, folder)}`, { cause: error });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) results.push(fullPath);
      // Ignore symlinks, FIFOs, sockets and other special filesystem entries.
    }
  }

  await visit(root);
  return results;
}

export function isWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function ageDays(mtime, now = Date.now()) {
  return (now - new Date(mtime).getTime()) / DAY_MS;
}

export function formatProgress(current, total, width = 20) {
  const ratio = total === 0 ? 1 : Math.max(0, Math.min(1, current / total));
  const filled = Math.round(width * ratio);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${current}/${total}`;
}

export function progressReporter(label) {
  let lastStep = -1;
  let wasTTY = false;
  return {
    update(current, total) {
      const step = total === 0 ? 10 : Math.floor((current / total) * 10);
      if (process.stdout.isTTY) {
        wasTTY = true;
        process.stdout.write(`\r${label} ${formatProgress(current, total)}`);
      } else if (step !== lastStep) {
        console.log(`${label} ${formatProgress(current, total)}`);
      }
      lastStep = step;
    },
    finish() {
      if (wasTTY) process.stdout.write('\n');
    }
  };
}
