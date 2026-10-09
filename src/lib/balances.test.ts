import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adjustToBank, cardBalances } from './balances';
import { fromBeancount, toBeancount } from './beancount';
import { applyImport, type ImportPayload } from './importer';
import { deleteTransaction, newLedger } from './ledger';

const unix = (d: string) => Date.parse(`${d}T18:00:00Z`) / 1000;
const CHASE = 'Liabilities:CreditCard:Chase';

function payload(fetchedAt: string, balance: string, txns: ImportPayload['transactions'], pending = '0.00'): ImportPayload {
  return {
    v: 1, fetchedAt,
    accounts: [{ id: 'c1', name: 'Sapphire', org: 'Chase', currency: 'USD', balance, balanceDate: unix(fetchedAt.slice(0, 10)), pending }],
    transactions: txns,
  };
}
const t1 = { id: 'a', account: 'c1', posted: unix('2026-10-02'), amount: '-40.00', description: 'SHELL' };
const t2 = { id: 'b', account: 'c1', posted: unix('2026-10-05'), amount: '-60.00', description: 'COSTCO' };
const t3 = { id: 'c', account: 'c1', posted: unix('2026-10-08'), amount: '-25.00', description: 'TARGET' };

function chase(l: Parameters<typeof cardBalances>[0]) {
  return cardBalances(l).find((c) => c.account.name === CHASE)!;
}

describe('card balances', () => {
  it('adds a starting balance so the first check matches, then catches a missing transaction', () => {
    // Bank says you owe 1,100.00; the 30-day history only explains 100.00 of it.
    let { ledger } = applyImport(newLedger('2026-10-01'), payload('2026-10-06T11:00:00Z', '-1100.00', [t1, t2]));
    const opening = ledger.transactions.find((t) => t.payee === 'Starting balance')!;
    expect(opening.date).toBe('2026-10-01');
    expect(opening.postings).toEqual([
      { account: CHASE, amount: -100000 },
      { account: 'Equity:Opening-Balances', amount: 100000 },
    ]);
    expect(chase(ledger)).toMatchObject({ owed: 110000, bank: { owed: 110000, status: 'match', difference: 0 } });

    // Next day: new purchase arrives, bank agrees.
    ledger = applyImport(ledger, payload('2026-10-09T11:00:00Z', '-1125.00', [t1, t2, t3])).ledger;
    expect(chase(ledger).bank!.status).toBe('match');
    expect(ledger.transactions.filter((t) => t.payee === 'Starting balance')).toHaveLength(1);

    // Someone deletes a real purchase by mistake: the check flags it.
    const costco = ledger.transactions.find((t) => t.payee === 'Costco')!;
    const broken = deleteTransaction(ledger, costco.id);
    expect(chase(broken).bank).toMatchObject({ status: 'mismatch', difference: 6000 });

    // Adjusting books the difference and the check passes again.
    const fixed = adjustToBank(broken, chase(broken));
    expect(chase(fixed).bank!.status).toBe('match');
    expect(fixed.transactions.some((t) => t.payee === 'Balance adjustment')).toBe(true);
  });

  it('explains a difference that equals pending charges', () => {
    let { ledger } = applyImport(newLedger('2026-10-01'), payload('2026-10-06T11:00:00Z', '-100.00', [t1, t2]));
    ledger = applyImport(ledger, payload('2026-10-07T11:00:00Z', '-112.00', [t1, t2], '-12.00')).ledger;
    expect(chase(ledger).bank).toMatchObject({ status: 'pending', difference: 1200 });
  });

  it('exports balance checks that bean-check accepts, and reads them back', () => {
    const { ledger } = applyImport(newLedger('2026-10-01'), payload('2026-10-06T11:00:00Z', '-1100.00', [t1, t2]));
    const text = toBeancount(ledger);
    expect(text).toContain('2026-10-07 balance Liabilities:CreditCard:Chase  -1100.00 USD');
    expect(fromBeancount(text).bankBalances![CHASE]).toMatchObject({ amount: -110000, asOf: '2026-10-06' });
    const checker = process.env.BEAN_CHECK;
    if (checker) {
      const file = join(mkdtempSync(join(tmpdir(), 'bal-')), 'b.beancount');
      writeFileSync(file, text);
      execFileSync(checker, [file], { stdio: 'pipe' });
    }
  });
});

describe('start over and balances', () => {
  it('clears balances on both phones so a new starting balance is set', async () => {
    const { startOver } = await import('./ledger');
    const { mergeLedgers } = await import('./merge');
    const { ledger: before } = applyImport(newLedger('2026-10-01'), payload('2026-10-06T11:00:00Z', '-1100.00', [t1, t2]));
    await new Promise((r) => setTimeout(r, 5));
    const fresh = startOver(before);
    const merged = mergeLedgers(before, fresh); // the other phone still has the old balances
    expect(merged.bankBalances ?? {}).toEqual({});
    const again = applyImport(merged, payload('2026-10-09T11:00:00Z', '-1125.00', [t1, t2, t3])).ledger;
    expect(again.transactions.filter((t) => t.payee === 'Starting balance')).toHaveLength(1);
    expect(chase(again).bank!.status).toBe('match');
  });
});
