## Features

- `scan` — recursive analysis: file count, total size, file types, age (based on `mtime`), the three largest files, and the oldest file.
- `duplicates` — SHA-256 hashing using `createReadStream()`, grouping files with identical content, and calculating the space occupied by redundant copies.
- `organize` — **copying, not moving** files into the `Documents`, `Images`, `Archives`, `Code`, `Videos`, and `Other` categories; overwrite protection (`report(1).pdf`, `report(2).pdf`).
- `cleanup` — finding files by their last modification date; a safe **dry-run** mode by default, with actual deletion **only when `--confirm` is provided**.

The application uses only built-in Node.js modules, with no third-party packages: `fs`, `fs/promises`, `path`, `crypto`, `events`, and `stream/promises`. Each command has its own class that extends `EventEmitter`. It includes `try...catch` error handling, progress reporting, and clear error messages (`ENOENT`, `EACCES`, `EPERM`, `ENOSPC`, etc.).

## Requirements and Installation

**Node.js 18+** is required (LTS recommended). npm is included with Node.js.

```bash
git clone
cd file-organizer
npm install
```

To display help:

```bash
node file-organizer.js --help
```

Enclose paths containing spaces in quotation marks, for example, `"C:\\Users\\User\\My Downloads"`. The CLI works on Windows, macOS, and Linux.

## 1. Scanning: `scan`

```bash
node file-organizer.js scan ./my-files
# or
npm run scan -- ./my-files
```

The application traverses all nested subdirectories and displays the total number of files, their combined size, a breakdown by file extension, the number of files modified within the last **7** and **30** days, the number of files older than **90** days, the three largest files, and the oldest file. The 7-day and 30-day periods **overlap**: a file modified yesterday is counted in both metrics.

## 2. Duplicates: `duplicates`

```bash
node file-organizer.js duplicates ./my-files
# or
npm run duplicates -- ./my-files
```

An SHA-256 hash is calculated for each file using a stream (`createReadStream`). Files with matching hashes are placed in the same group regardless of their names. The report displays full file paths, SHA-256 hashes, and wasted disk space calculated as `file size × (number of copies − 1)`. This command **does not delete anything**.

## 3. Organizing: `organize`

```bash
node file-organizer.js organize ./my-files --output ./organized
# or
npm run organize -- ./my-files --output ./organized
```

All six category directories are created. Example:

```text
organized/
├── Documents/
├── Images/
├── Archives/
├── Code/
├── Videos/
└── Other/
```

Unknown extensions are placed in `Other`, and extensions are matched case-insensitively. Files **smaller than 10 MiB** are copied using `fs.copyFile()` with `COPYFILE_EXCL`; files **10 MiB or larger** are copied using `createReadStream()` / `createWriteStream()` and `pipeline()`, with exclusive file creation. Existing files are never overwritten; suffixes `(1)`, `(2)`, etc. are added instead. The output directory cannot be located inside the input directory, preventing recursive copying. Original files remain unchanged.

## 4. Cleanup: `cleanup`

**Preview (recommended first step):**

```bash
node file-organizer.js cleanup ./my-files --older-than 90
# or
npm run cleanup -- ./my-files --older-than 90
```

Displays full file paths, sizes, ages, and total size **without deleting anything**.

**Actual deletion (irreversible):**

```bash
node file-organizer.js cleanup ./my-files --older-than 90 --confirm
# or
npm run cleanup -- ./my-files --older-than 90 --confirm
```

The `--older-than` option accepts a non-negative number of days. File age is determined by the **last modification time (`mtime`)**, not the creation time. Before deletion, the application checks whether a file has changed since scanning. Files are deleted using `fs.unlink()` and are not moved to the Recycle Bin or Trash. **Back up important files** and always review the dry-run results first.

## Architecture

```text
file-organizer/
├── package.json
├── .gitignore
├── README.md
├── file-organizer.js       # CLI, process.argv, reports, and progress
├── lib/
│   ├── scanner.js          # Scanner extends EventEmitter
│   ├── duplicates.js       # DuplicateFinder extends EventEmitter
│   ├── organizer.js        # Organizer extends EventEmitter
│   ├── cleanup.js          # Cleanup extends EventEmitter
│   └── utils.js            # Traversal, formatting, and error handling
└── test/
    └── file-organizer.test.js
```

**Events:**

| Command | Main events |
|---|---|
| `scan` | `scan-start`, `file-found`, `scan-complete` |
| `duplicates` | `search-start`, `file-processed`, `duplicates-found` |
| `organize` | `organize-start`, `copy-start`, `copy-complete`, `copy-error`, `organize-complete` |
| `cleanup` | `cleanup-start`, `file-found`, `candidates-ready`, `file-deleted`, `delete-error`, `cleanup-complete` |

The main CLI subscribes to these events and displays progress (`█░`) and results. Scanning is recursive; symbolic links and special files are skipped to prevent loops. If copying or deleting an individual file fails, the error is displayed and processing continues with the remaining files. If any errors occur, the application sets the exit code to `1`.

## Tests

```bash
npm test
```

Automated tests using Node.js's built-in `node:test` module cover `scan` statistics, duplicate detection, grouping, organization, filename collisions, copying a file larger than 10 MiB, preservation of originals, dry runs, actual cleanup, events, and CLI exit codes. No external testing libraries are required.
