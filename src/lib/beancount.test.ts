import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromBeancount, toBeancount } from './beancount';
import { newLedger, setBudget, simpleTxn, upsertTransaction, type Ledger } from './ledger';

function sample(): Ledger {
  let l = newLedger('2026-10-01');
  l = setBudget(l, { account: 'Expenses:Food:Groceries', from: '2026-10', amount: 60000, mode: 'rollover' });
  l = setBudget(l, { account: 'Expenses:Food:Dining', from: '2026-10', amount: 25050, mode: 'fixed' });
  l = upsertTransaction(l, simpleTxn({
    date: '2026-10-03', payee: 'Trader Joe\'s', narration: 'weekly "big" shop \\ snacks',
    amount: 8423, card: 'Liabilities:CreditCard:Chase', category: 'Expenses:Food:Groceries',
  }));
  l = upsertTransaction(l, simpleTxn({
    date: '2026-09-28', payee: 'Shell', amount: 4510, card: 'Liabilities:CreditCard:Amex',
    category: 'Expenses:Transport:Gas', source: 'simplefin', flag: '!', externalId: 'TRN-123',
  }));
  l = upsertTransaction(l, { ...simpleTxn({
    date: '2026-10-05', payee: 'Target', amount: -1999, card: 'Liabilities:CreditCard:Amex',
    category: 'Expenses:Shopping:General', source: 'applepay',
  }), tags: ['refund'] });
  return l;
}

/** Path to the real Beancount checker, if installed (set BEAN_CHECK or have it on PATH). */
function beanCheck(): string | null {
  const candidates = [process.env.BEAN_CHECK, 'bean-check'].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--help'], { stdio: 'ignore' });
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

describe('beancount', () => {
  it('round-trips the ledger', () => {
    const l = sample();
    const back = fromBeancount(toBeancount(l));
    const strip = <T extends { updatedAt?: string }>(x: T) => ({ ...x, updatedAt: undefined });
    const byId = (x: Ledger) => [...x.transactions].sort((a, b) => a.id.localeCompare(b.id)).map(strip);
    expect(byId(back)).toEqual(byId(l));
    expect(back.budgets.map(strip)).toEqual(l.budgets.map(strip));
    expect(back.title).toBe(l.title);
    const gas = back.accounts.find((a) => a.name === 'Expenses:Transport:Gas')!;
    expect(gas.label).toBe('Gas');
    // Opened on first use, which is earlier than the ledger's creation date.
    expect(toBeancount(l)).toContain('2026-09-28 open Expenses:Transport:Gas USD');
  });

  it('reads hand-written Beancount with elided amounts and comments', () => {
    const text = `
; my ledger
option "operating_currency" "USD"
2026-01-01 open Liabilities:CreditCard:Chase USD
2026-01-01 open Expenses:Food:Dining

2026-01-02 * "Cafe" "lunch" #work ; comment
  Expenses:Food:Dining   12.50 USD
  Liabilities:CreditCard:Chase

2026-01-03 txn "just a narration"
  Expenses:Food:Dining   1 USD
  Liabilities:CreditCard:Chase  -1 USD
2026-01-31 balance Liabilities:CreditCard:Chase  -13.50 USD
`;
    const l = fromBeancount(text);
    expect(l.transactions).toHaveLength(2);
    expect(l.transactions[0]).toMatchObject({ payee: 'Cafe', narration: 'lunch', tags: ['work'] });
    expect(l.transactions[0].postings[1]).toEqual({ account: 'Liabilities:CreditCard:Chase', amount: -1250 });
    expect(l.transactions[1]).toMatchObject({ payee: '', narration: 'just a narration' });
  });

  it('rejects non-USD and unbalanced transactions', () => {
    expect(() => fromBeancount('2026-01-01 * "x"\n  Expenses:A  1 EUR\n  Assets:B  -1 EUR\n')).toThrow(/USD/);
    expect(() => fromBeancount('2026-01-01 * "x"\n  Expenses:A  1 USD\n  Assets:B  -2 USD\n')).toThrow(/balance/);
  });

  const checker = beanCheck();
  it.skipIf(!checker)('output passes the real bean-check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const file = join(dir, 'test.beancount');
    writeFileSync(file, toBeancount(sample()));
    // Throws (failing the test) if bean-check reports any error.
    execFileSync(checker!, [file], { stdio: 'pipe' });
  });
});
