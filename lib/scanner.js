import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ageDays, formatError, listFiles } from './utils.js';

export class Scanner extends EventEmitter {
  async scan(directory) {
    const files = await listFiles(directory);
    const now = Date.now();
    const statistics = {
      directory: path.resolve(directory),
      totalFiles: 0,
      totalSize: 0,
      byType: new Map(),
      age: { last7Days: 0, last30Days: 0, olderThan90Days: 0 },
      largestFiles: [],
      oldestFile: null
    };

    this.emit('scan-start', { directory: statistics.directory, total: files.length });
    for (let index = 0; index < files.length; index++) {
      const filePath = files[index];
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        throw new Error(`Unable to inspect file: ${formatError(error, filePath)}`, { cause: error });
      }
      if (!stat.isFile()) continue;
      const extension = path.extname(filePath).toLowerCase() || '(other)';
      const fileData = { path: filePath, size: stat.size, mtime: stat.mtime, extension };
      statistics.totalFiles++;
      statistics.totalSize += stat.size;
      const group = statistics.byType.get(extension) ?? { count: 0, totalSize: 0 };
      group.count++;
      group.totalSize += stat.size;
      statistics.byType.set(extension, group);

      const days = ageDays(stat.mtime, now);
      if (days >= 0 && days <= 7) statistics.age.last7Days++;
      if (days >= 0 && days <= 30) statistics.age.last30Days++;
      if (days > 90) statistics.age.olderThan90Days++;
      statistics.largestFiles.push(fileData);
      statistics.largestFiles.sort((a, b) => b.size - a.size);
      if (statistics.largestFiles.length > 3) statistics.largestFiles.pop();
      if (!statistics.oldestFile || stat.mtime < statistics.oldestFile.mtime) {
        statistics.oldestFile = fileData;
      }
      this.emit('file-found', { ...fileData, current: index + 1, total: files.length });
    }
    this.emit('scan-complete', statistics);
    return statistics;
  }
}
