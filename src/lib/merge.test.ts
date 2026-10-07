import { describe, expect, it, vi } from 'vitest';
import { deleteTransaction, markReplaced, newLedger, setBudget, simpleTxn, updateAccount, upsertTransaction, type Ledger } from './ledger';
import { canonical, mergeLedgers } from './merge';

const CARD = 'Liabilities:CreditCard:Chase';
const GROC = 'Expenses:Food:Groceries';
let clock = Date.parse('2026-10-08T10:00:00Z');
const tick = () => vi.setSystemTime((clock += 1000));

function add(l: Ledger, payee: string, cents = 1000) {
  tick();
  const t = simpleTxn({ date: '2026-10-08', payee, amount: cents, card: CARD, category: GROC });
  return { ledger: upsertTransaction(l, t), id: t.id };
}

describe('merge', () => {
  vi.useFakeTimers();

  it('unions edits from both phones and is order-independent', () => {
    const base = newLedger('2026-10-01');
    const a = add(base, 'Costco').ledger;
    const b = add(base, 'Shell').ledger;
    const ab = mergeLedgers(a, b), ba = mergeLedgers(b, a);
    expect(ab.transactions.map((t) => t.payee).sort()).toEqual(['Costco', 'Shell']);
    expect(canonical(ab)).toBe(canonical(ba));
    expect(canonical(mergeLedgers(ab, ab))).toBe(canonical(ab));
  });

  it('keeps the newer edit of the same transaction', () => {
    const { ledger: base, id } = add(newLedger('2026-10-01'), 'Costco');
    tick();
    const a = upsertTransaction(base, { ...base.transactions[0], payee: 'Costco Wholesale' });
    tick();
    const b = upsertTransaction(base, { ...base.transactions[0], narration: 'later edit' });
    const m = mergeLedgers(a, b);
    expect(m.transactions.find((t) => t.id === id)!.narration).toBe('later edit');
  });

  it('a deletion beats an older copy, but not a later edit', () => {
    const { ledger: base, id } = add(newLedger('2026-10-01'), 'Costco');
    tick();
    const deleted = deleteTransaction(base, id);
    expect(mergeLedgers(deleted, base).transactions).toHaveLength(0);
    tick();
    const editedLater = upsertTransaction(base, { ...base.transactions[0], payee: 'Edited after delete' });
    expect(mergeLedgers(deleted, editedLater).transactions).toHaveLength(1);
  });

  it('a full replacement drops older records from the other phone', () => {
    const a = add(newLedger('2026-10-01'), 'Old entry').ledger;
    tick();
    const replaced = markReplaced(add(newLedger('2026-10-01'), 'From backup').ledger);
    tick();
    const bNewer = add(a, 'Added after the restore').ledger;
    const m = mergeLedgers(bNewer, replaced);
    expect(m.transactions.map((t) => t.payee).sort()).toEqual(['Added after the restore', 'From backup']);
  });

  it('merges budgets and accounts by newest, keeping earliest open date', () => {
    tick();
    const base = newLedger('2026-10-01');
    const a = setBudget(base, { account: GROC, from: '2026-10', amount: 500, mode: 'rollover' });
    tick();
    const b = setBudget(updateAccount({ ...base, accounts: base.accounts.map((x) => x.name === CARD ? { ...x, open: '2026-01-01' } : x) }, CARD, { label: 'Chase Freedom' }),
      { account: GROC, from: '2026-10', amount: 700, mode: 'fixed' });
    const m = mergeLedgers(a, b);
    expect(m.budgets).toHaveLength(1);
    expect(m.budgets[0]).toMatchObject({ amount: 700, mode: 'fixed' });
    const chase = m.accounts.find((x) => x.name === CARD)!;
    expect(chase).toMatchObject({ label: 'Chase Freedom', open: '2026-01-01' });
  });
});
