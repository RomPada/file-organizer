import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { formatError, listFiles } from './utils.js';

export async function calculateHash(filePath) {
  const hash = crypto.createHash('sha256');
  try {
    // Streaming works for small and large files with bounded memory usage.
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
  } catch (error) {
    throw new Error(`Unable to hash file: ${formatError(error, filePath)}`, { cause: error });
  }
}

export class DuplicateFinder extends EventEmitter {
  async find(directory) {
    const files = await listFiles(directory);
    const byHash = new Map();
    this.emit('search-start', { directory: path.resolve(directory), total: files.length });
    for (let index = 0; index < files.length; index++) {
      const filePath = files[index];
      let stat;
      try {
        stat = await fsPromises.stat(filePath);
      } catch (error) {
        throw new Error(`Unable to inspect file: ${formatError(error, filePath)}`, { cause: error });
      }
      if (!stat.isFile()) continue;
      const hash = await calculateHash(filePath);
      const group = byHash.get(hash) ?? [];
      group.push({ path: filePath, size: stat.size });
      byHash.set(hash, group);
      this.emit('file-processed', { path: filePath, current: index + 1, total: files.length });
    }
    const groups = [...byHash.entries()]
      .filter(([, items]) => items.length > 1)
      .map(([hash, items]) => ({
        hash,
        files: items,
        size: items[0].size,
        wastedBytes: items[0].size * (items.length - 1)
      }));
    const result = {
      directory: path.resolve(directory),
      totalFiles: files.length,
      groups,
      totalWastedBytes: groups.reduce((total, group) => total + group.wastedBytes, 0)
    };
    this.emit('duplicates-found', result);
    return result;
  }
}
