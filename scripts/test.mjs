// Windows: if the shell's cwd uses a lowercase drive ("d:\...") while Node resolves modules as "D:\...",
// vitest loads two copies of its runner and every suite fails with
// "Cannot read properties of undefined (reading 'config')". Re-launch vitest from a normalised cwd.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const cwd = process.cwd().replace(/^[a-z]:/, (d) => d.toUpperCase());
const bin = path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
const r = spawnSync(process.execPath, [bin, 'run', ...process.argv.slice(2)], { cwd, stdio: 'inherit' });
process.exit(r.status ?? 1);
