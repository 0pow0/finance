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
    expect(cleanPayee('TST* BLUE BOTTLE COFFEE 00123 OAKLAND CA')).toBe('Blue Bottle Coffee');
    expect(cleanPayee('SQ *JOES PIZZA')).toBe('Joes Pizza');
    expect(cleanPayee("TRADER JOE'S #552")).toBe("Trader Joe's");
    expect(cleanPayee('Netflix.com')).toBe('Netflix.com');
    expect(cleanPayee('NETFLIX.COM')).toBe('Netflix.com');
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
    expect(byPayee["Trader Joe's"].postings).toEqual([
      { account: 'Expenses:Food:Groceries', amount: 8423 },
      { account: 'Liabilities:CreditCard:Chase', amount: -8423 },
    ]);
    expect(byPayee["Trader Joe's"]).toMatchObject({ flag: '!', source: 'simplefin', date: '2026-10-06' });
    expect(byPayee['Shell Oil'].postings[0].account).toBe('Expenses:Transport:Gas');
    expect(byPayee['Target Refund'].postings[0]).toEqual({ account: 'Expenses:Shopping:General', amount: -1999 });
    expect(byPayee['Card payment'].postings).toEqual([
      { account: 'Assets:Bank:Checking', amount: -50000 },
      { account: 'Liabilities:CreditCard:Chase', amount: 50000 },
    ]);

    // Same file again: nothing new.
    expect(applyImport(ledger, p).added).toBe(0);
    // Deleted imports don't come back.
    const shell = byPayee['Shell Oil'];
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
    expect(ledger.accounts.some((a) => a.name === 'Liabilities:CreditCard:Venture-X' && a.label === 'Venture X')).toBe(true);
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
