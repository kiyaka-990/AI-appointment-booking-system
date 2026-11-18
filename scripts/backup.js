/**
 * Consistent SQLite backup using VACUUM INTO (safe while the server is running).
 *
 *   npm run backup                 -> data/backups/booking-YYYYMMDD-HHMMSS.db
 *   BACKUP_DIR=D:\backups npm run backup
 *   BACKUP_KEEP=30 npm run backup  -> keep the newest 30 files (default 14)
 *
 * Restore: stop the server, replace the live database with a backup file,
 * start the server. WAL files are not needed for a VACUUM INTO snapshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { databasePath, openDatabase } from '../src/lib/db.js';

const keep = Math.max(1, Number(process.env.BACKUP_KEEP || 14));
const source = databasePath();
const dir = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(source), 'backups'));

if (!fs.existsSync(source)) {
  console.error(`[backup] no database at ${source}`);
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const target = path.join(dir, `${path.basename(source, '.db')}-${stamp}.db`);

try {
  const db = openDatabase(source);
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} catch (error) {
  console.error(`[backup] failed: ${error.message}`);
  process.exit(1);
}

const size = fs.statSync(target).size;
if (!size) {
  console.error('[backup] the snapshot is empty, keeping the previous files');
  process.exit(1);
}

const snapshots = fs
  .readdirSync(dir)
  .filter((file) => file.startsWith(path.basename(source, '.db')) && file.endsWith('.db'))
  .map((file) => ({ file, at: fs.statSync(path.join(dir, file)).mtimeMs }))
  .sort((a, b) => b.at - a.at);

for (const old of snapshots.slice(keep)) {
  fs.rmSync(path.join(dir, old.file), { force: true });
}

console.log(`[backup] wrote ${target} (${(size / 1024).toFixed(0)} KB), keeping ${Math.min(keep, snapshots.length)} snapshots`);
process.exit(0);
