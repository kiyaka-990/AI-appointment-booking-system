import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { closeDatabase, databasePath, openDatabase } from '../src/lib/db.js';

/**
 * Drop every record and rebuild the schema. Used by `npm run reset` and by the
 * seed/demo scripts so a demo always starts from a known state.
 */
export function resetDatabase() {
  closeDatabase();
  const file = databasePath();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
  openDatabase(file);
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = resetDatabase();
  console.log(`Database reset: ${file}`);
  closeDatabase();
}
