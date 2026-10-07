import { describe, expect, it } from 'vitest';
import { budgetReport } from './budget';
import { newLedger, setBudget, simpleTxn, upsertTransaction, type Ledger } from './ledger';

const CARD = 'Liabilities:CreditCard:Chase';
const GROC = 'Expenses:Food:Groceries';
const DINE = 'Expenses:Food:Dining';

function spend(l: Ledger, date: string, category: string, cents: number): Ledger {
  return upsertTransaction(l, simpleTxn({ date, payee: 'x', amount: cents, card: CARD, category }));
}

describe('budgets', () => {
  it('rolls leftover and overspending into the next month', () => {
    let l = newLedger('2026-01-01');
    l = setBudget(l, { account: GROC, from: '2026-01', amount: 50000, mode: 'rollover' });
    l = spend(l, '2026-01-10', GROC, 40000); // $100 left
    l = spend(l, '2026-02-10', GROC, 70000); // 500 + 100 - 700 = -100
    const jan = budgetReport(l, '2026-01').rows[0];
    expect(jan).toMatchObject({ assigned: 50000, carried: 0, spent: 40000, remaining: 10000 });
    const feb = budgetReport(l, '2026-02').rows[0];
    expect(feb).toMatchObject({ carried: 10000, available: 60000, spent: 70000, remaining: -10000 });
    const mar = budgetReport(l, '2026-03').rows[0];
    expect(mar).toMatchObject({ carried: -10000, available: 40000, spent: 0 });
  });

  it('fixed mode does not carry over, and switching modes takes effect from that month', () => {
    let l = newLedger('2026-01-01');
    l = setBudget(l, { account: GROC, from: '2026-01', amount: 50000, mode: 'fixed' });
    l = spend(l, '2026-01-10', GROC, 10000);
    expect(budgetReport(l, '2026-02').rows[0]).toMatchObject({ carried: 0, available: 50000 });

    l = setBudget(l, { account: GROC, from: '2026-02', amount: 60000, mode: 'rollover' });
    // Jan was fixed, so nothing carries into Feb even though Feb is rollover.
    expect(budgetReport(l, '2026-02').rows[0]).toMatchObject({ carried: 0, assigned: 60000 });
    expect(budgetReport(l, '2026-03').rows[0]).toMatchObject({ carried: 60000, available: 120000 });
  });

  it('counts refunds and reports unbudgeted spending without double counting', () => {
    let l = newLedger('2026-01-01');
    l = setBudget(l, { account: 'Expenses:Food', from: '2026-01', amount: 80000, mode: 'fixed' });
    l = setBudget(l, { account: GROC, from: '2026-01', amount: 50000, mode: 'fixed' });
    l = spend(l, '2026-01-02', GROC, 20000);
    l = spend(l, '2026-01-03', GROC, -5000); // refund
    l = spend(l, '2026-01-04', DINE, 3000);
    l = spend(l, '2026-01-05', 'Expenses:Travel', 9000);
    const r = budgetReport(l, '2026-01');
    expect(r.rows.find((x) => x.account === GROC)!.spent).toBe(15000);
    expect(r.rows.find((x) => x.account === 'Expenses:Food')!.spent).toBe(18000);
    expect(r.unbudgeted).toEqual([{ account: 'Expenses:Travel', spent: 9000 }]);
    expect(r.totalSpent).toBe(27000);
    expect(r.totalAvailable).toBe(80000); // parent only, children are inside it
  });

  it('hides months before a budget starts', () => {
    let l = newLedger('2026-01-01');
    l = setBudget(l, { account: GROC, from: '2026-03', amount: 100, mode: 'fixed' });
    expect(budgetReport(l, '2026-02').rows).toHaveLength(0);
  });
});
