// Generates a local owner credential file and deployable hashed secrets.
// Nothing generated here belongs in public/ or Git.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { generatePasswordHash } from '../src/admin.js';

const directory = path.resolve('output');
const credentialPath = path.join(directory, 'admin-credentials.txt');
const secretPath = path.join(directory, 'admin-secrets.json');
let exists = false;
try { await access(credentialPath); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (exists && !process.argv.includes('--rotate')) throw new Error('Credentials already exist. Use --rotate only when you intend to change the admin password.');

const password = randomBytes(24).toString('base64url');
const sessionSecret = randomBytes(48).toString('base64url');
const passwordHash = await generatePasswordHash(password);
await mkdir(directory, { recursive: true });
await writeFile(secretPath, JSON.stringify({ ADMIN_PASSWORD_HASH: passwordHash, ADMIN_SESSION_SECRET: sessionSecret }, null, 2) + '\n', { mode: 0o600 });
await writeFile(credentialPath, [
  'Keep Fix Cut private admin dashboard',
  'URL: https://keepfixcut.com/admin',
  `Password: ${password}`,
  '',
  'Keep this file private. Store the password in your password manager.',
  'Only the password hash and session-signing secret are deployed.',
  'To rotate: node scripts/create-admin.mjs --rotate',
  'Then: npx wrangler secret bulk output/admin-secrets.json',
  'Remove output/admin-secrets.json after a successful upload.',
  'Rotating the session secret signs out existing admin sessions.',
  '',
].join('\n'), { mode: 0o600 });
console.log('Admin credentials saved to output/admin-credentials.txt. The password is not printed.');
console.log('Deploy hashed secrets with: npx wrangler secret bulk output/admin-secrets.json');
console.log('Remove output/admin-secrets.json after a successful upload.');
