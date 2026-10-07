import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module shared with the daily import job
import { sealImport } from '../../importer/ecies.mjs';
import { generateImportKey, openImport } from './ecies';
import { simpleTxn, upsertTransaction, deleteTransaction, type Ledger } from './ledger';
import { INBOX_DIR, LEDGER_PATH, PUBLIC_KEY_PATH, syncLedger } from './sync';
import { FakeRepo } from './testing';
import { createVault, eraseVault, restoreVault, type Session } from './vault';

const CARD = 'Liabilities:CreditCard:Chase';

function deps(repo: FakeRepo, s: Session, device: string) {
  return { client: repo, seal: (l: Ledger) => s.sealForSync(l), open: (t: string) => s.openFromSync(t), device };
}

describe('ecies', () => {
  it('the import job and the app agree', async () => {
    const key = await generateImportKey();
    const sealed = await sealImport(key.publicJwk, key.kid, { hello: 'bank' });
    expect(JSON.stringify(sealed)).not.toContain('bank');
    expect(await openImport(sealed, [key])).toEqual({ hello: 'bank' });
    const other = await generateImportKey();
    await expect(openImport(sealed, [{ ...other, kid: key.kid }])).rejects.toThrow();
  });
});

describe('sync', () => {
  beforeEach(() => eraseVault());

  async function twoPhones() {
    const { session: a, recoveryKey } = await createVault('phone a passphrase');
    const backup = await a.exportBackup();
    await eraseVault();
    const b = await restoreVault(recoveryKey, 'phone b passphrase', backup);
    return { a, b };
  }

  it('two phones converge, deletions propagate, and nothing readable is stored', async () => {
    const repo = new FakeRepo();
    const { a, b } = await twoPhones();
    let la = upsertTransaction(a.ledger, simpleTxn({ date: '2026-10-08', payee: 'Costco', amount: 100, card: CARD, category: 'Expenses:Food:Groceries' }));
    let lb = upsertTransaction(b.ledger, simpleTxn({ date: '2026-10-08', payee: 'Shell', amount: 200, card: CARD, category: 'Expenses:Transport:Gas' }));

    la = (await syncLedger(la, deps(repo, a, 'A'))).ledger;
    lb = (await syncLedger(lb, deps(repo, b, 'B'))).ledger;
    la = (await syncLedger(la, deps(repo, a, 'A'))).ledger;
    expect(la.transactions.map((t) => t.payee).sort()).toEqual(['Costco', 'Shell']);
    expect(lb.transactions.map((t) => t.payee).sort()).toEqual(['Costco', 'Shell']);

    for (const [, f] of repo.files) expect(f.text).not.toMatch(/Costco|Shell/);
    expect(JSON.parse(repo.files.get(PUBLIC_KEY_PATH)!.text).kid).toBe(la.importKeys![0].kid);

    lb = deleteTransaction(lb, lb.transactions.find((t) => t.payee === 'Costco')!.id);
    lb = (await syncLedger(lb, deps(repo, b, 'B'))).ledger;
    la = (await syncLedger(la, deps(repo, a, 'A'))).ledger;
    expect(la.transactions.map((t) => t.payee)).toEqual(['Shell']);

    // Nothing changed: no new write.
    const sha = repo.files.get(LEDGER_PATH)!.sha;
    expect((await syncLedger(la, deps(repo, a, 'A'))).pushed).toBe(false);
    expect(repo.files.get(LEDGER_PATH)!.sha).toBe(sha);
  });

  it('retries when the other phone saves at the same moment', async () => {
    const repo = new FakeRepo();
    const { a, b } = await twoPhones();
    const lb = upsertTransaction(b.ledger, simpleTxn({ date: '2026-10-08', payee: 'From B', amount: 1, card: CARD, category: 'Expenses:Misc' }));
    await syncLedger(lb, deps(repo, b, 'B'));
    let raced = false;
    const bSnapshot = repo.files.get(LEDGER_PATH)!.text;
    const lb2 = upsertTransaction(lb, simpleTxn({ date: '2026-10-08', payee: 'Also from B', amount: 1, card: CARD, category: 'Expenses:Misc' }));
    const bSealed = await b.sealForSync(lb2);
    repo.beforePut = (path) => {
      if (path === LEDGER_PATH && !raced) { raced = true; repo.set(LEDGER_PATH, bSealed); }
    };
    const la = upsertTransaction(a.ledger, simpleTxn({ date: '2026-10-08', payee: 'From A', amount: 1, card: CARD, category: 'Expenses:Misc' }));
    const res = await syncLedger(la, deps(repo, a, 'A'));
    expect(raced).toBe(true);
    expect(bSnapshot).not.toBe(bSealed);
    expect(res.ledger.transactions.map((t) => t.payee).sort()).toEqual(['Also from B', 'From A', 'From B']);
  });

  it('imports bank transactions from the inbox once, then clears it', async () => {
    const repo = new FakeRepo();
    const { a } = await twoPhones();
    let la = (await syncLedger(a.ledger, deps(repo, a, 'A'))).ledger;
    const pub = JSON.parse(repo.files.get(PUBLIC_KEY_PATH)!.text);
    const payload = {
      v: 1, fetchedAt: '2026-10-08T11:00:00Z',
      accounts: [{ id: 'ACT1', name: 'Sapphire', org: 'Chase', currency: 'USD' }],
      transactions: [{ id: 'T1', account: 'ACT1', posted: 1791460800, amount: '-12.50', description: 'STARBUCKS STORE 123' }],
    };
    repo.set(`${INBOX_DIR}/2026-10-08.json`, JSON.stringify(await sealImport(pub.publicJwk, pub.kid, payload)));
    const res = await syncLedger(la, deps(repo, a, 'A'));
    expect(res.imported).toBe(1);
    la = res.ledger;
    expect(la.transactions[0]).toMatchObject({ payee: 'Starbucks Store', flag: '!' });
    expect(la.transactions[0].postings[0]).toEqual({ account: 'Expenses:Food:Coffee', amount: 1250 });
    expect(await repo.listDir(INBOX_DIR)).toHaveLength(0);
  });

  it('refuses data from a different household key', async () => {
    const repo = new FakeRepo();
    const one = await createVault('household one pass');
    await syncLedger(one.session.ledger, deps(repo, one.session, 'one'));
    const two = await createVault('household two pass');
    await expect(syncLedger(two.session.ledger, deps(repo, two.session, 'two'))).rejects.toThrow(/different household key/);
  });
});
