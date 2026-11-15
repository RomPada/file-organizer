import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  ensureDirectory, formatError, isWithin, listFiles, STREAM_THRESHOLD
} from './utils.js';

export const CATEGORIES = {
  Documents: ['.pdf', '.docx', '.doc', '.txt', '.md', '.xlsx', '.pptx'],
  Images: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'],
  Archives: ['.zip', '.rar', '.tar', '.gz', '.7z'],
  Code: ['.js', '.py', '.java', '.cpp', '.html', '.css', '.json'],
  Videos: ['.mp4', '.avi', '.mkv', '.mov', '.webm'],
  Other: []
};

export function categoryFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  for (const [category, extensions] of Object.entries(CATEGORIES)) {
    if (extensions.includes(extension)) return category;
  }
  return 'Other';
}

function numberedName(fileName, index) {
  if (index === 0) return fileName;
  const parsed = path.parse(fileName);
  return `${parsed.name}(${index})${parsed.ext}`;
}

async function copyWithoutOverwrite(source, target, useStream) {
  if (!useStream) {
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    return;
  }
  // Exclusive opening prevents races and guarantees the destination is not overwritten.
  const handle = await fsp.open(target, 'wx');
  try {
    await pipeline(
      fs.createReadStream(source),
      handle.createWriteStream({ autoClose: true })
    );
  } catch (error) {
    try { await handle.close(); } catch { /* pipeline may already close it */ }
    try { await fsp.unlink(target); } catch { /* preserve original exception */ }
    throw error;
  }
}

export class Organizer extends EventEmitter {
  async organize(sourceDirectory, outputDirectory) {
    const source = await ensureDirectory(sourceDirectory);
    const output = path.resolve(outputDirectory);
    if (isWithin(source, output)) {
      throw new Error('Output directory must be outside the source directory to avoid recursive copying.');
    }
    // Also check physical paths when the destination already exists (symlink safety).
    try {
      const realSource = await fsp.realpath(source);
      const realOutput = await fsp.realpath(output);
      if (isWithin(realSource, realOutput)) {
        throw new Error('Output directory resolves inside the source directory.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const files = await listFiles(source);
    try {
      for (const category of Object.keys(CATEGORIES)) {
        await fsp.mkdir(path.join(output, category), { recursive: true });
      }
    } catch (error) {
      throw new Error(`Unable to create category directories: ${formatError(error, output)}`, { cause: error });
    }
    const countByCategory = Object.fromEntries(Object.keys(CATEGORIES).map(category => [category, 0]));
    const errors = [];
    const result = { source, output, countByCategory, copiedFiles: 0, copiedBytes: 0, failedFiles: 0, errors };
    this.emit('organize-start', { source, output, total: files.length });

    for (let index = 0; index < files.length; index++) {
      const sourcePath = files[index];
      const category = categoryFor(sourcePath);
      this.emit('copy-start', { source: sourcePath, category, current: index + 1, total: files.length });
      try {
        const stat = await fsp.stat(sourcePath);
        if (!stat.isFile()) throw new Error('Source is no longer a regular file');
        let destination;
        // Retry on EEXIST: handles both existing files and simultaneous processes.
        for (let suffix = 0; ; suffix++) {
          destination = path.join(output, category, numberedName(path.basename(sourcePath), suffix));
          try {
            await copyWithoutOverwrite(sourcePath, destination, stat.size >= STREAM_THRESHOLD);
            break;
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
        result.copiedFiles++;
        result.copiedBytes += stat.size;
        countByCategory[category]++;
        this.emit('copy-complete', {
          source: sourcePath, destination, category, size: stat.size,
          current: index + 1, total: files.length
        });
      } catch (error) {
        result.failedFiles++;
        const failure = { source: sourcePath, message: formatError(error, sourcePath) };
        errors.push(failure);
        this.emit('copy-error', { ...failure, current: index + 1, total: files.length });
      }
    }
    this.emit('organize-complete', result);
    return result;
  }
}
