import { describe, expect, it } from 'vitest';
import { applyImport, cleanPayee, guessCategory, removeUnreviewedImports, type ImportPayload } from './importer';
import { deleteTransaction, newLedger, simpleTxn, upsertTransaction } from './ledger';

const unix = (d: string) => Date.parse(`${d}T18:00:00Z`) / 1000;

function payload(txns: ImportPayload['transactions'], accounts?: ImportPayload['accounts']): ImportPayload {
  return {
    v: 1,
    fetchedAt: '2026-10-08T11:00:00Z',
    accounts: accounts ?? [
      { id: 'ACT-chase', name: 'CHASE SAPPHIRE (1234)', org: 'Chase Bank', currency: 'USD' },
      { id: 'ACT-amex', name: 'Gold Card', org: 'American Express', currency: 'USD' },
    ],
    transactions: txns,
  };
}

describe('cleanPayee', () => {
  it('tidies common card descriptions', () => {
    const cases: Array<[string, string]> = [
      ['TST* BLUE BOTTLE COFFEE 00123 OAKLAND CA', 'Blue Bottle Coffee'],
      ['SQ *JOES PIZZA', 'Joes Pizza'],
      ["TRADER JOE'S #552", 'Trader Joe’s'],
      ['TRADER JOE S #552 OAKLAND CA', 'Trader Joe’s'],
      ['NETFLIX.COM', 'Netflix'],
      ['CVS/PHARMACY #09812', 'CVS'],
      ['AMC THEATRES 2201', 'AMC Theatres'],
      ['PG&E WEB ONLINE', 'PG&E'],
      ['UBER   *TRIP HELP.UBER.COM', 'Uber'],
      ['AMAZON MKTPL*2K4L19', 'Amazon'],
      ['COSTCO WHSE #0482', 'Costco'],
      ['DOORDASH*THAI BASIL KITCHEN', 'DoorDash'],
      ['SQ *SIGHTGLASS COFFEE ROASTERS SAN FRANCISCO CA', 'Sightglass Coffee Roasters'],
      ['THE CHEESECAKE FACTORY 0123', 'The Cheesecake Factory'],
      ['IN-N-OUT BURGER 123', 'In-N-Out Burger'],
      ['Blue Bottle Coffee', 'Blue Bottle Coffee'],
    ];
    for (const [raw, want] of cases) expect([raw, cleanPayee(raw)]).toEqual([raw, want]);
  });
});

describe('applyImport', () => {
  it('maps Chase/Amex accounts, categorizes, flags for review, and skips duplicates', () => {
    const l0 = newLedger('2026-10-01');
    const p = payload([
      { id: 't1', account: 'ACT-chase', posted: unix('2026-10-06'), amount: '-84.23', description: "TRADER JOE'S #552" },
      { id: 't2', account: 'ACT-amex', posted: unix('2026-10-07'), amount: '-45.10', description: 'SHELL OIL 5744' },
      { id: 't3', account: 'ACT-amex', posted: unix('2026-10-07'), amount: '19.99', description: 'TARGET REFUND' },
      { id: 't4', account: 'ACT-chase', posted: unix('2026-10-07'), amount: '500.00', description: 'Payment Thank You - Web' },
      { id: 't5', account: 'ACT-chase', posted: unix('2026-10-07'), amount: '-5.00', description: 'PENDING THING', pending: true },
    ]);
    const { ledger, added } = applyImport(l0, p);
    expect(added).toBe(4);
    expect(ledger.importAccounts!['ACT-chase'].account).toBe('Liabilities:CreditCard:Chase');
    expect(ledger.importAccounts!['ACT-amex'].account).toBe('Liabilities:CreditCard:Amex');
    const byPayee = Object.fromEntries(ledger.transactions.map((t) => [t.payee, t]));
    expect(byPayee["Trader Joe’s"].postings).toEqual([
      { account: 'Expenses:Food:Groceries', amount: 8423 },
      { account: 'Liabilities:CreditCard:Chase', amount: -8423 },
    ]);
    expect(byPayee["Trader Joe’s"]).toMatchObject({ flag: '!', source: 'simplefin', date: '2026-10-06' });
    expect(byPayee['Shell'].postings[0].account).toBe('Expenses:Transport:Gas');
    expect(byPayee['Target'].postings[0]).toEqual({ account: 'Expenses:Shopping:General', amount: -1999 });
    expect(byPayee['Card payment'].postings).toEqual([
      { account: 'Assets:Bank:Checking', amount: -50000 },
      { account: 'Liabilities:CreditCard:Chase', amount: 50000 },
    ]);

    // Same file again: nothing new.
    expect(applyImport(ledger, p).added).toBe(0);
    // Deleted imports don't come back.
    const shell = byPayee['Shell'];
    expect(applyImport(deleteTransaction(ledger, shell.id), p).added).toBe(0);
  });

  it('learns categories from confirmed history', () => {
    let l = newLedger('2026-10-01');
    l = upsertTransaction(l, simpleTxn({ date: '2026-10-01', payee: 'Costco Wholesale', amount: 100, card: 'Liabilities:CreditCard:Chase', category: 'Expenses:Home:Supplies' }));
    expect(guessCategory(l, 'Costco Wholesale', 'COSTCO WHOLESALE #123')).toBe('Expenses:Home:Supplies');
    expect(guessCategory(l, 'Mystery Shop', 'MYSTERY SHOP')).toBe('Expenses:Misc');
  });

  it('creates a card for an unrecognized bank account', () => {
    const { ledger } = applyImport(newLedger('2026-10-01'), payload(
      [{ id: 'x', account: 'ACT-c1', posted: unix('2026-10-02'), amount: '-10', description: 'UBER TRIP' }],
      [{ id: 'ACT-c1', name: 'Venture X', org: 'Capital One', currency: 'USD' }],
    ));
    expect(ledger.importAccounts!['ACT-c1'].account).toBe('Liabilities:CreditCard:Venture-X');
    expect(ledger.accounts.some((a) => a.name === 'Liabilities:CreditCard:Venture-X' && a.label === 'Capital One Venture X')).toBe(true);
    expect(ledger.transactions[0].postings[0].account).toBe('Expenses:Transport:Rideshare');
  });
});

describe('non-card accounts', () => {
  it('skips checking/savings by default and can remove unreviewed imports', () => {
    const accounts = [
      { id: 'card', name: 'Freedom Unlimited', org: 'Chase', currency: 'USD' },
      { id: 'chk', name: 'TOTAL CHECKING (5678)', org: 'Chase', currency: 'USD' },
      { id: 'sav', name: 'Chase Savings', org: 'Chase', currency: 'USD' },
    ];
    const txns = [
      { id: '1', account: 'card', posted: unix('2026-10-02'), amount: '-20.00', description: 'CHIPOTLE 123' },
      { id: '2', account: 'chk', posted: unix('2026-10-02'), amount: '2500.00', description: 'PAYROLL' },
      { id: '3', account: 'sav', posted: unix('2026-10-02'), amount: '1.02', description: 'INTEREST' },
    ];
    const { ledger, added } = applyImport(newLedger('2026-10-01'), payload(txns, accounts));
    expect(added).toBe(1);
    expect(ledger.importAccounts!.chk.account).toBeNull();
    expect(ledger.importAccounts!.sav.account).toBeNull();
    expect(ledger.importAccounts!.card.account).toBe('Liabilities:CreditCard:Chase');

    const res = removeUnreviewedImports(ledger, 'card');
    expect(res.removed).toBe(1);
    expect(res.ledger.transactions).toHaveLength(0);
    // Removed imports don't come back on the next import.
    expect(applyImport(res.ledger, payload(txns, accounts)).added).toBe(0);
  });
});

describe('re-linked bank accounts', () => {
  it('reuses the card and skips transactions already imported under the old id', () => {
    const before = [{ id: 'old-amex', name: 'Gold Card', org: 'American Express', currency: 'USD' }];
    const t1 = { posted: unix('2026-10-03'), amount: '-30.00', description: 'WHOLE FOODS #10' };
    let { ledger } = applyImport(newLedger('2026-10-01'), payload([{ id: 'a', account: 'old-amex', ...t1 }], before));
    expect(ledger.transactions).toHaveLength(1);

    // Reconnected in SimpleFIN: same card, new account id and new transaction ids.
    const after = [{ id: 'new-amex', name: 'Gold Card', org: 'American Express', currency: 'USD' }];
    const t2 = { posted: unix('2026-10-05'), amount: '-12.00', description: 'UBER TRIP' };
    const res = applyImport(ledger, payload([{ id: 'x', account: 'new-amex', ...t1 }, { id: 'y', account: 'new-amex', ...t2 }], after));
    ledger = res.ledger;
    expect(res.added).toBe(1);
    expect(ledger.importAccounts!['new-amex'].account).toBe('Liabilities:CreditCard:Amex');
    expect(ledger.accounts.filter((a) => a.name.startsWith('Liabilities:CreditCard:'))).toHaveLength(2); // Chase + Amex only
    expect(ledger.transactions.map((t) => t.payee).sort()).toEqual(['Uber', 'Whole Foods']);
  });

  it('two different people with same-named cards stay separate', () => {
    const accts = [
      { id: 'a1', name: 'Gold Card', org: 'American Express', currency: 'USD' },
      { id: 'a2', name: 'Gold Card', org: 'American Express', currency: 'USD' },
    ];
    const { ledger } = applyImport(newLedger('2026-10-01'), payload([], accts));
    expect(ledger.importAccounts!.a1.account).not.toBe(ledger.importAccounts!.a2.account);
  });
});

describe('pending charges', () => {
  it('shows pending as a snapshot, replaced once they post, never counted twice', async () => {
    const { allPending } = await import('./importer');
    const { budgetReport } = await import('./budget');
    const acct = [{ id: 'c1', name: 'Freedom', org: 'Chase', currency: 'USD' }];
    const pend = { id: 'p1', account: 'c1', posted: 0, transactedAt: unix('2026-10-08'), amount: '-18.75', description: 'SQ *BLUE BOTTLE', pending: true };
    let { ledger, added } = applyImport(newLedger('2026-10-01'), { ...payload([pend], acct), fetchedAt: '2026-10-08T12:00:00Z' });
    expect(added).toBe(0);
    expect(allPending(ledger)).toMatchObject([{ payee: 'Blue Bottle', amount: 1875, card: 'Liabilities:CreditCard:Chase', date: '2026-10-08' }]);
    expect(budgetReport(ledger, '2026-10').totalSpent).toBe(0); // not in the books

    // Next import: it posted (new id, as banks do). Pending list empties, one real transaction.
    const posted = { id: 't9', account: 'c1', posted: unix('2026-10-09'), amount: '-18.75', description: 'SQ *BLUE BOTTLE' };
    ({ ledger, added } = applyImport(ledger, { ...payload([posted], acct), fetchedAt: '2026-10-09T12:00:00Z' }));
    expect(added).toBe(1);
    expect(allPending(ledger)).toEqual([]);
    expect(budgetReport(ledger, '2026-10').totalSpent).toBe(1875);

    // An older import arriving late doesn't bring stale pending back.
    ({ ledger } = applyImport(ledger, { ...payload([pend], acct), fetchedAt: '2026-10-08T12:00:00Z' }));
    expect(allPending(ledger)).toEqual([]);
  });
});

describe('card names', () => {
  it('names cards after the bank account', async () => {
    const { cardLabel } = await import('./importer');
    expect(cardLabel({ name: 'Sapphire Preferred', org: 'Chase Bank' })).toBe('Chase Sapphire Preferred');
    expect(cardLabel({ name: 'Gold Card', org: 'American Express' })).toBe('Amex Gold Card');
    expect(cardLabel({ name: 'CHASE FREEDOM (...4321)', org: 'Chase' })).toBe('CHASE FREEDOM');
    const { ledger } = applyImport(newLedger('2026-10-01'), payload([], [
      { id: 'x', name: 'Sapphire Preferred', org: 'Chase Bank', currency: 'USD' },
      { id: 'y', name: 'Gold Card', org: 'American Express', currency: 'USD' },
    ]));
    const label = (n: string) => ledger.accounts.find((a) => a.name === n)!.label;
    expect(label('Liabilities:CreditCard:Chase')).toBe('Chase Sapphire Preferred');
    expect(label('Liabilities:CreditCard:Amex')).toBe('Amex Gold Card');
  });
});
