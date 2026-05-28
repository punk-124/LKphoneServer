import { spawnSync } from 'node:child_process';

const bucketName = process.env.LKPHONE_BACKUP_BUCKET || 'lkphone-backups';
const wranglerBin = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';

const result = spawnSync(wranglerBin, ['r2', 'bucket', 'create', bucketName], {
  cwd: process.cwd(),
  encoding: 'utf8',
  shell: true,
});

const output = `${result.stdout || ''}\n${result.stderr || ''}`;
const alreadyExists = /already exists|bucket.*exists|10014|name is not available/i.test(output);

if (result.status === 0) {
  console.log(`R2 bucket ready: ${bucketName}`);
  process.exit(0);
}

if (alreadyExists) {
  console.log(`R2 bucket already exists: ${bucketName}`);
  process.exit(0);
}

console.error(output.trim() || `Failed to create R2 bucket: ${bucketName}`);
process.exit(result.status || 1);
