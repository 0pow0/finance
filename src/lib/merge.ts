// Merging two copies of the ledger (this phone's and the synced copy).
//
// Every record carries `updatedAt`; for each record the newer copy wins. Deleted transactions
// leave a tombstone, which beats any copy older than the deletion. A whole-ledger replacement
// (restore or file import) sets `resetAt`, which drops older records the other side still has.
// The merge is order-independent, so phones converge whichever syncs first.

import type { Account, BudgetEntry, ImportAccount, ImportKey, Ledger, Tombstone, Transaction } from './ledger';

const ts = (x?: string) => x ?? '';

function newer<T extends { updatedAt?: string }>(a: T, b: T): T {
  const ta = ts(a.updatedAt), tb = ts(b.updatedAt);
  if (ta !== tb) return ta > tb ? a : b;
  // Same timestamp: pick deterministically so both phones agree.
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

function mergeBy<T extends { updatedAt?: string }>(a: T[], b: T[], key: (x: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const x of [...a, ...b]) {
    const k = key(x);
    const cur = out.get(k);
    out.set(k, cur ? newer(cur, x) : x);
  }
  return out;
}

export function mergeLedgers(a: Ledger, b: Ledger): Ledger {
  const reset = [a.resetAt, b.resetAt].filter(Boolean).sort().pop();
  // Records from a side that predates the latest reset survive only if changed after it.
  const survives = (side: Ledger) => (x: { updatedAt?: string }) =>
    !reset || ts(side.resetAt) >= reset || ts(x.updatedAt) >= reset;

  const tombstones: Record<string, Tombstone> = {};
  for (const side of [a, b]) {
    if (reset && ts(side.resetAt) < reset) continue;
    for (const [id, t] of Object.entries(side.tombstones ?? {})) {
      if (!tombstones[id] || t.at > tombstones[id].at) tombstones[id] = t;
    }
  }

  const txns = mergeBy<Transaction>(a.transactions.filter(survives(a)), b.transactions.filter(survives(b)), (t) => t.id);
  const transactions = [...txns.values()]
    .filter((t) => !tombstones[t.id] || ts(t.updatedAt) > tombstones[t.id].at)
    .sort((x, y) => (x.date === y.date ? x.id.localeCompare(y.id) : x.date < y.date ? -1 : 1));

  // Accounts are never deleted (only hidden), so keep all of them; the earliest open date wins.
  const accts = mergeBy<Account>(a.accounts, b.accounts, (x) => x.name);
  const opens = new Map<string, string>();
  for (const x of [...a.accounts, ...b.accounts]) {
    const cur = opens.get(x.name);
    if (!cur || x.open < cur) opens.set(x.name, x.open);
  }
  const accounts = [...accts.values()]
    .map((x) => ({ ...x, open: opens.get(x.name)! }))
    .sort((x, y) => x.name.localeCompare(y.name));

  const budgets = [...mergeBy<BudgetEntry>(a.budgets.filter(survives(a)), b.budgets.filter(survives(b)),
    (x) => `${x.account}|${x.from}`).values()]
    .sort((x, y) => (x.from === y.from ? x.account.localeCompare(y.account) : x.from < y.from ? -1 : 1));

  const keys = new Map<string, ImportKey>();
  for (const k of [...(a.importKeys ?? []), ...(b.importKeys ?? [])]) if (!keys.has(k.kid)) keys.set(k.kid, k);
  const importKeys = [...keys.values()].sort((x, y) =>
    x.createdAt === y.createdAt ? x.kid.localeCompare(y.kid) : x.createdAt < y.createdAt ? -1 : 1);

  const importAccounts: Record<string, ImportAccount> = {};
  for (const side of [a, b]) {
    for (const [id, acct] of Object.entries(side.importAccounts ?? {})) {
      importAccounts[id] = importAccounts[id] ? newer(importAccounts[id], acct) : acct;
    }
  }

  const merged: Ledger = {
    version: a.version,
    title: a.title,
    currency: a.currency,
    accounts,
    transactions,
    budgets,
    tombstones,
  };
  if (reset) merged.resetAt = reset;
  if (importKeys.length) merged.importKeys = importKeys;
  if (Object.keys(importAccounts).length) merged.importAccounts = importAccounts;
  const bankBalances: NonNullable<Ledger['bankBalances']> = {};
  for (const side of [a, b]) {
    for (const [acct, bal] of Object.entries(side.bankBalances ?? {})) {
      if (reset && ts(side.resetAt) < reset && bal.fetchedAt < reset) continue; // cleared by "Start over"
      if (!bankBalances[acct] || bal.fetchedAt > bankBalances[acct].fetchedAt) bankBalances[acct] = bal;
    }
  }
  if (Object.keys(bankBalances).length) merged.bankBalances = bankBalances;
  const peopleSide = ts(a.peopleUpdatedAt) >= ts(b.peopleUpdatedAt) ? a : b;
  if (peopleSide.people) {
    merged.people = peopleSide.people;
    if (peopleSide.peopleUpdatedAt) merged.peopleUpdatedAt = peopleSide.peopleUpdatedAt;
  }
  const importSide = ts(a.lastImportAt) >= ts(b.lastImportAt) ? a : b;
  if (importSide.lastImportAt) merged.lastImportAt = importSide.lastImportAt;
  if (importSide.lastImportAccounts) merged.lastImportAccounts = importSide.lastImportAccounts;
  return merged;
}

/** Stable JSON for comparing ledgers regardless of array order. */
export function canonical(l: Ledger): string {
  return JSON.stringify(mergeLedgers(l, l));
}
