// Runs the real daily-import script against a fake SimpleFIN server.
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateImportKey, openImport } from './ecies';

const run = promisify(execFile);
let server: Server;
let port = 0;
let claims = 0;
let lastAuth = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/claim/abc') {
      claims++;
      res.end(claims === 1 ? `http://user1:secret%2Bpw@127.0.0.1:${port}/simplefin` : '');
      if (claims > 1) res.statusCode = 403;
      return;
    }
    if (req.url?.startsWith('/simplefin/accounts')) {
      lastAuth = req.headers.authorization ?? '';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        errors: ['Chase: please reauthenticate soon'],
        accounts: [{
          id: 'ACT-1', name: 'Sapphire', currency: 'USD', org: { name: 'Chase', domain: 'chase.com' },
          transactions: [
            { id: 'T1', posted: 1791460800, amount: '-12.50', description: 'STARBUCKS' },
            { id: 'T2', posted: 0, amount: '-3.00', description: 'PENDING', pending: true },
          ],
        }],
      }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

describe('daily import job', () => {
  it('claims once, fetches, and writes an import only the phones can open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'data-'));
    mkdirSync(join(dir, 'config'));
    const key = await generateImportKey();
    writeFileSync(join(dir, 'config/import-public-key.json'), JSON.stringify({ kid: key.kid, publicJwk: key.publicJwk }));
    const env = {
      ...process.env, DATA_DIR: dir, ALLOW_INSECURE_HTTP: '1',
      SIMPLEFIN_SETUP_TOKEN: Buffer.from(`http://127.0.0.1:${port}/claim/abc`).toString('base64'),
    };

    const first = await run('node', ['importer/import.mjs'], { env });
    expect(first.stdout).toContain('Connected to SimpleFIN');
    expect(first.stdout).toContain('Fetched 1 posted and 1 pending transactions from 1 accounts');
    expect(first.stdout).toContain('SimpleFIN notice: Chase: please reauthenticate soon');
    expect(first.stdout).not.toMatch(/secret|user1|STARBUCKS|127\.0\.0\.1/);
    expect(lastAuth).toBe(`Basic ${Buffer.from('user1:secret+pw').toString('base64')}`);

    const access = readFileSync(join(dir, 'config/simplefin-access.enc.json'), 'utf8');
    expect(access).not.toContain('secret');

    const files = readdirSync(join(dir, 'inbox'));
    expect(files).toHaveLength(1);
    const sealed = JSON.parse(readFileSync(join(dir, 'inbox', files[0]), 'utf8'));
    const payload = await openImport(sealed, [key]) as { transactions: Array<{ id: string }> };
    expect(payload.transactions.map((t) => t.id)).toEqual(['T1', 'T2']);

    // Second run reuses the stored access (the setup token is single-use).
    const second = await run('node', ['importer/import.mjs'], { env });
    expect(second.stdout).not.toContain('Connected to SimpleFIN');
    expect(claims).toBe(1);
  });

  it('waits politely until the app has published its key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'data-'));
    const out = await run('node', ['importer/import.mjs'], { env: { ...process.env, DATA_DIR: dir, SIMPLEFIN_SETUP_TOKEN: 'x' } });
    expect(out.stdout).toContain('Open the app and connect sync');
  });
});
