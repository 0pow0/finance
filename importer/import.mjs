// Daily bank import, run by GitHub Actions in the private data repo.
//
// Fetches recent Chase/Amex transactions from SimpleFIN Bridge and saves them to inbox/ encrypted
// with the household's import PUBLIC key (config/import-public-key.json, written by the app).
// This job can encrypt but never decrypt; the phones decrypt and merge them on their next sync.
//
// Secrets: SIMPLEFIN_SETUP_TOKEN (one-time setup token from SimpleFIN Bridge).
// The setup token is exchanged for an access URL once; the access URL is stored encrypted in
// config/simplefin-access.enc.json, keyed by the setup-token secret.
//
// Never prints tokens, URLs, or transaction details: only counts.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptWithSecret, encryptWithSecret, sealImport } from './ecies.mjs';

const DATA = process.env.DATA_DIR || '.';
const PUBLIC_KEY = join(DATA, 'config/import-public-key.json');
const ACCESS = join(DATA, 'config/simplefin-access.enc.json');
const LOOKBACK_DAYS = Math.min(45, Math.max(1, Number(process.env.LOOKBACK_DAYS) || 10));
const FIRST_RUN_DAYS = Number(process.env.FIRST_RUN_DAYS || 30);
const ALLOW_HTTP = process.env.ALLOW_INSECURE_HTTP === '1'; // tests only

function stop(message, code = 1) {
  console.log(message);
  process.exit(code);
}

function checkUrl(u) {
  const url = new URL(u);
  if (url.protocol !== 'https:' && !(ALLOW_HTTP && url.protocol === 'http:')) throw new Error('SimpleFIN URL must use https');
  return url;
}

async function claim(setupToken) {
  let claimUrl;
  try {
    claimUrl = checkUrl(Buffer.from(setupToken, 'base64').toString('utf8').trim());
  } catch {
    stop('SIMPLEFIN_SETUP_TOKEN does not look like a SimpleFIN setup token. Copy it again from SimpleFIN Bridge.');
  }
  const res = await fetch(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } });
  if (res.status === 403) {
    stop('This SimpleFIN setup token was already used or has expired. Create a new one in SimpleFIN Bridge, update the SIMPLEFIN_SETUP_TOKEN secret, and run again.');
  }
  if (!res.ok) stop(`SimpleFIN setup failed (HTTP ${res.status}).`);
  const accessUrl = (await res.text()).trim();
  checkUrl(accessUrl);
  return accessUrl;
}

async function accessUrl(setupToken) {
  if (existsSync(ACCESS)) {
    try {
      return { url: await decryptWithSecret(setupToken, await readFile(ACCESS, 'utf8')), firstRun: false };
    } catch {
      console.log('Stored SimpleFIN access could not be unlocked with the current secret; treating the secret as a new setup token.');
    }
  }
  const url = await claim(setupToken);
  await mkdir(join(DATA, 'config'), { recursive: true });
  await writeFile(ACCESS, (await encryptWithSecret(setupToken, url)) + '\n');
  console.log('Connected to SimpleFIN.');
  return { url, firstRun: true };
}

async function fetchAccounts(access, days) {
  const url = checkUrl(access);
  const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
  const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
  const start = Math.floor(Date.now() / 1000) - days * 86400;
  const res = await fetch(`${base}/accounts?start-date=${start}`, { headers: { Authorization: `Basic ${auth}` } });
  if (res.status === 402) stop('SimpleFIN Bridge says payment is required. Check your SimpleFIN subscription.');
  if (res.status === 403) {
    stop('SimpleFIN access was revoked. Create a new setup token in SimpleFIN Bridge, update the SIMPLEFIN_SETUP_TOKEN secret, and delete config/simplefin-access.enc.json.');
  }
  if (!res.ok) stop(`SimpleFIN request failed (HTTP ${res.status}).`);
  return res.json();
}

async function main() {
  const setupToken = (process.env.SIMPLEFIN_SETUP_TOKEN || '').trim();
  if (!setupToken) stop('Add the SIMPLEFIN_SETUP_TOKEN secret to this repo (Settings → Secrets and variables → Actions).');
  if (!existsSync(PUBLIC_KEY)) {
    stop('No import key yet. Open the app and connect sync (Settings → Sync) so it can publish its key, then run again.', 0);
  }
  const { kid, publicJwk } = JSON.parse(await readFile(PUBLIC_KEY, 'utf8'));

  const { url, firstRun } = await accessUrl(setupToken);
  const data = await fetchAccounts(url, firstRun ? FIRST_RUN_DAYS : LOOKBACK_DAYS);

  const messages = [...(data.errors ?? []), ...(data.errlist ?? []).map((e) => e.msg ?? String(e))];
  for (const m of messages) console.log(`SimpleFIN notice: ${m}`);

  const accounts = [];
  const transactions = [];
  for (const a of data.accounts ?? []) {
    accounts.push({ id: String(a.id), name: String(a.name ?? ''), org: String(a.org?.name ?? a.org?.domain ?? ''), currency: String(a.currency ?? 'USD') });
    for (const t of a.transactions ?? []) {
      if (t.pending) continue;
      transactions.push({
        id: String(t.id),
        account: String(a.id),
        posted: Number(t.posted),
        transactedAt: t.transacted_at ? Number(t.transacted_at) : null,
        amount: String(t.amount),
        description: String(t.description ?? ''),
        payee: t.payee ? String(t.payee) : undefined,
      });
    }
  }
  console.log(`Fetched ${transactions.length} posted transactions from ${accounts.length} accounts.`);
  if (!transactions.length) return;

  const fetchedAt = new Date().toISOString();
  const sealed = await sealImport(publicJwk, kid, { v: 1, fetchedAt, accounts, transactions });
  await mkdir(join(DATA, 'inbox'), { recursive: true });
  const name = `${fetchedAt.replace(/[:.]/g, '-')}.json`;
  await writeFile(join(DATA, 'inbox', name), JSON.stringify(sealed) + '\n');
  console.log(`Saved encrypted import inbox/${name}. Phones will pick it up on their next sync.`);
}

main().catch((e) => stop(`Import failed: ${e?.message ?? e}`));
