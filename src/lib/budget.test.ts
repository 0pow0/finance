import { describe, expect, it } from 'vitest';
import { budgetReport, categorySpending, spendingByPerson } from './budget';
import {
  SHARED, addAccount, newLedger, renamePerson, setBudget, setPeople, simpleTxn, updateAccount, upsertTransaction, type Ledger,
} from './ledger';

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


describe('per-person spending', () => {
  it('splits spending by card owner', () => {
    let l = setPeople(newLedger('2026-10-01'), ['Rui', 'Ziqi']);
    l = addAccount(l, 'Liabilities:CreditCard:Joint', 'Joint card', '2026-10-01');
    l = updateAccount(l, 'Liabilities:CreditCard:Chase', { owner: 'Rui' });
    l = updateAccount(l, 'Liabilities:CreditCard:Amex', { owner: 'Ziqi' });
    l = updateAccount(l, 'Liabilities:CreditCard:Joint', { owner: SHARED });
    const buy = (card: string, cat: string, c: number) =>
      (l = upsertTransaction(l, simpleTxn({ date: '2026-10-05', payee: 'x', amount: c, card, category: cat })));
    buy('Liabilities:CreditCard:Chase', GROC, 5000);
    buy('Liabilities:CreditCard:Chase', DINE, 2000);
    buy('Liabilities:CreditCard:Amex', GROC, 3000);
    buy('Liabilities:CreditCard:Amex', GROC, -1000); // refund
    buy('Liabilities:CreditCard:Joint', 'Expenses:Travel', 9000);

    const by = spendingByPerson(l, '2026-10');
    expect(Object.fromEntries(by)).toEqual({ Rui: 7000, Ziqi: 2000, Shared: 9000 });
    expect(categorySpending(l, '2026-10', 'Ziqi')).toEqual([{ account: GROC, spent: 2000 }]);
    expect(categorySpending(l, '2026-10').map((x) => x.account)).toEqual(['Expenses:Travel', GROC, DINE]);

    const renamed = renamePerson(l, 'Ziqi', 'Ziqi W');
    expect(renamed.people).toEqual(['Rui', 'Ziqi W']);
    expect(spendingByPerson(renamed, '2026-10').get('Ziqi W')).toBe(2000);
  });
});
