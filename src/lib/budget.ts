import { addMonths, monthOf } from './dates';
import { isCategory, ownerMap, txnOwner, type BudgetEntry, type BudgetMode, type Ledger } from './ledger';
import type { Cents } from './money';

export interface BudgetRow {
  account: string;
  mode: BudgetMode;
  /** Amount budgeted for this month. */
  assigned: Cents;
  /** Leftover (or overspending, if negative) carried from last month. Always 0 in fixed mode. */
  carried: Cents;
  /** assigned + carried */
  available: Cents;
  spent: Cents;
  /** available - spent; negative means over budget. */
  remaining: Cents;
}

export interface MonthReport {
  month: string;
  rows: BudgetRow[];
  /** Spending in categories that have no budget (or under no budgeted parent). */
  unbudgeted: Array<{ account: string; spent: Cents }>;
  totalSpent: Cents;
  totalAvailable: Cents;
}

/** month -> expense account -> net spending in cents. */
export function spendingByMonth(ledger: Ledger): Map<string, Map<string, Cents>> {
  const out = new Map<string, Map<string, Cents>>();
  for (const t of ledger.transactions) {
    const month = monthOf(t.date);
    for (const p of t.postings) {
      if (!isCategory(p.account)) continue;
      let m = out.get(month);
      if (!m) out.set(month, (m = new Map()));
      m.set(p.account, (m.get(p.account) ?? 0) + p.amount);
    }
  }
  return out;
}

const within = (account: string, parent: string) => account === parent || account.startsWith(parent + ':');

function spentIn(spending: Map<string, Map<string, Cents>>, month: string, account: string): Cents {
  let total = 0;
  for (const [a, v] of spending.get(month) ?? []) if (within(a, account)) total += v;
  return total;
}

/** The budget entry in force for `account` during `month`, if any. */
export function entryFor(budgets: BudgetEntry[], account: string, month: string): BudgetEntry | undefined {
  let found: BudgetEntry | undefined;
  for (const b of budgets) if (b.account === account && b.from <= month && (!found || b.from >= found.from)) found = b;
  return found;
}

export function budgetReport(ledger: Ledger, month: string): MonthReport {
  const spending = spendingByMonth(ledger);
  const budgeted = [...new Set(ledger.budgets.map((b) => b.account))].sort();
  const rows: BudgetRow[] = [];

  for (const account of budgeted) {
    const first = ledger.budgets.filter((b) => b.account === account).map((b) => b.from).sort()[0];
    if (first > month) continue;
    let carried = 0;
    let row: BudgetRow | undefined;
    for (let m = first; m <= month; m = addMonths(m, 1)) {
      const entry = entryFor(ledger.budgets, account, m)!;
      const c = entry.mode === 'rollover' ? carried : 0;
      const spent = spentIn(spending, m, account);
      const available = entry.amount + c;
      row = { account, mode: entry.mode, assigned: entry.amount, carried: c, available, spent, remaining: available - spent };
      carried = entry.mode === 'rollover' ? row.remaining : 0;
    }
    // A budget set to $0 in fixed mode is treated as removed.
    if (row && !(row.assigned === 0 && row.mode === 'fixed' && row.carried === 0 && row.spent === 0)) rows.push(row);
  }

  // Only the most specific budgeted ancestor counts a posting, so totals don't double count.
  const active = rows.map((r) => r.account);
  const unbudgetedMap = new Map<string, Cents>();
  let totalSpent = 0;
  for (const [a, v] of spending.get(month) ?? []) {
    totalSpent += v;
    if (!active.some((b) => within(a, b))) unbudgetedMap.set(a, (unbudgetedMap.get(a) ?? 0) + v);
  }
  const topLevel = rows.filter((r) => !active.some((b) => b !== r.account && within(r.account, b)));

  return {
    month,
    rows,
    unbudgeted: [...unbudgetedMap]
      .filter(([, v]) => v !== 0)
      .map(([account, spent]) => ({ account, spent }))
      .sort((x, y) => y.spent - x.spent),
    totalSpent,
    totalAvailable: topLevel.reduce((s, r) => s + r.available, 0),
  };
}

/** Spending per category in a month, optionally only one person's (by card owner). */
export function categorySpending(ledger: Ledger, month: string, person?: string): Array<{ account: string; spent: Cents }> {
  const owners = ownerMap(ledger);
  const totals = new Map<string, Cents>();
  for (const t of ledger.transactions) {
    if (monthOf(t.date) !== month) continue;
    if (person !== undefined && txnOwner(ledger, t, owners) !== person) continue;
    for (const p of t.postings) if (isCategory(p.account)) totals.set(p.account, (totals.get(p.account) ?? 0) + p.amount);
  }
  return [...totals].filter(([, v]) => v !== 0).map(([account, spent]) => ({ account, spent })).sort((a, b) => b.spent - a.spent);
}

/** Total spending per card owner in a month. Key '' = cards without an owner. */
export function spendingByPerson(ledger: Ledger, month: string): Map<string, Cents> {
  const owners = ownerMap(ledger);
  const out = new Map<string, Cents>();
  for (const t of ledger.transactions) {
    if (monthOf(t.date) !== month) continue;
    const spent = t.postings.filter((p) => isCategory(p.account)).reduce((s, p) => s + p.amount, 0);
    if (!spent) continue;
    const who = txnOwner(ledger, t, owners) ?? '';
    out.set(who, (out.get(who) ?? 0) + spent);
  }
  return out;
}
