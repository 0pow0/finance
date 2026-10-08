import type { Cents } from './money';

export const LEDGER_VERSION = 1;

export interface Account {
  /** Beancount account name, e.g. "Liabilities:CreditCard:Chase". */
  name: string;
  /** Friendly name shown in the app, e.g. "Chase Sapphire". */
  label: string;
  open: string;
  closed?: boolean;
  /** For cards: whose card it is (a name from `people`, or SHARED). */
  owner?: string;
  /** Removed by the user. Kept as a marker so the removal syncs to the other phone. */
  deleted?: boolean;
  /** When this record last changed (ISO time). Used to merge edits from both phones. */
  updatedAt?: string;
}

export interface Posting {
  account: string;
  amount: Cents;
}

export type TxnSource = 'manual' | 'applepay' | 'simplefin' | 'import';

export interface Transaction {
  id: string;
  date: string;
  /** '*' = confirmed, '!' = needs review. */
  flag: '*' | '!';
  payee: string;
  narration: string;
  postings: Posting[];
  tags: string[];
  source: TxnSource;
  /** Id from the bank feed, used to avoid importing the same transaction twice. */
  externalId?: string;
  updatedAt?: string;
}

export type BudgetMode = 'rollover' | 'fixed';

/** A budget amount for a category, effective from `from` month until a later entry replaces it. */
export interface BudgetEntry {
  account: string;
  from: string;
  amount: Cents;
  mode: BudgetMode;
  updatedAt?: string;
}

export interface Ledger {
  version: number;
  title: string;
  currency: 'USD';
  accounts: Account[];
  transactions: Transaction[];
  budgets: BudgetEntry[];
  /** Deleted transactions (id -> when), so a deletion on one phone wins over an older copy on the other. */
  tombstones?: Record<string, Tombstone>;
  /** Set when the whole ledger was replaced (restore/import); older records from other phones are dropped. */
  resetAt?: string;
  /** Keys that bank imports are encrypted to. The private halves never leave the encrypted ledger. */
  importKeys?: ImportKey[];
  /** Bank-feed accounts seen so far, and which ledger account each one imports into (null = skip). */
  importAccounts?: Record<string, ImportAccount>;
  lastImportAt?: string;
  /** Bank-feed account ids present in the most recent import (older ones were removed or re-linked). */
  lastImportAccounts?: string[];
  /** Household members, for per-person spending. */
  people?: string[];
  peopleUpdatedAt?: string;
}

export const SHARED = 'Shared';

export interface Tombstone {
  at: string;
  externalId?: string;
}

export interface ImportKey {
  kid: string;
  createdAt: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

export interface ImportAccount {
  name: string;
  org: string;
  account: string | null;
  updatedAt?: string;
}

export function nowISO(): string {
  return new Date().toISOString();
}

const ROOTS = ['Assets', 'Liabilities', 'Equity', 'Income', 'Expenses'] as const;
const ACCOUNT_RE = /^(Assets|Liabilities|Equity|Income|Expenses)(:[A-Z0-9][A-Za-z0-9-]*)+$/;

export function isValidAccountName(name: string): boolean {
  return ACCOUNT_RE.test(name);
}

/** Turn "Coffee & snacks" into a valid account component "Coffee-Snacks". */
export function toAccountComponent(label: string): string {
  const words = label
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1));
  const joined = words.join('-');
  return joined || 'Other';
}

export const isCard = (a: string) => a.startsWith('Liabilities:CreditCard:');
export const isCategory = (a: string) => a.startsWith('Expenses:');
export const isBank = (a: string) => a.startsWith('Assets:');
export const rootOf = (a: string) => a.split(':')[0] as (typeof ROOTS)[number];

const DEFAULT_ACCOUNTS: Array<[string, string]> = [
  ['Liabilities:CreditCard:Chase', 'Chase'],
  ['Liabilities:CreditCard:Amex', 'American Express'],
  ['Assets:Bank:Checking', 'Checking'],
  ['Equity:Opening-Balances', 'Opening balances'],
  ['Income:Refunds-Rewards', 'Refunds & rewards'],
  ['Expenses:Food:Groceries', 'Groceries'],
  ['Expenses:Food:Dining', 'Dining out'],
  ['Expenses:Food:Coffee', 'Coffee'],
  ['Expenses:Transport:Gas', 'Gas'],
  ['Expenses:Transport:Parking-Tolls', 'Parking & tolls'],
  ['Expenses:Transport:Rideshare', 'Rideshare & transit'],
  ['Expenses:Home:Utilities', 'Utilities'],
  ['Expenses:Home:Supplies', 'Household supplies'],
  ['Expenses:Shopping:General', 'Shopping'],
  ['Expenses:Shopping:Clothing', 'Clothing'],
  ['Expenses:Health', 'Health'],
  ['Expenses:Entertainment', 'Entertainment'],
  ['Expenses:Subscriptions', 'Subscriptions'],
  ['Expenses:Travel', 'Travel'],
  ['Expenses:Gifts', 'Gifts'],
  ['Expenses:Personal-Care', 'Personal care'],
  ['Expenses:Fees-Interest', 'Card fees & interest'],
  ['Expenses:Misc', 'Other'],
];

export function newLedger(openDate: string): Ledger {
  return {
    version: LEDGER_VERSION,
    title: 'Household',
    currency: 'USD',
    accounts: DEFAULT_ACCOUNTS.map(([name, label]) => ({ name, label, open: openDate })),
    transactions: [],
    budgets: [],
  };
}

export function newId(): string {
  return crypto.randomUUID();
}

export function accountLabel(ledger: Ledger, name: string): string {
  return ledger.accounts.find((a) => a.name === name)?.label ?? name.split(':').slice(1).join(' › ');
}

export function txnBalances(t: Transaction): boolean {
  return t.postings.reduce((s, p) => s + p.amount, 0) === 0;
}

/**
 * A simple card purchase: `amount` charged to `card`, spent on `category`.
 * A negative amount is a refund.
 */
export function simpleTxn(fields: {
  date: string;
  payee: string;
  narration?: string;
  amount: Cents;
  card: string;
  category: string;
  source?: TxnSource;
  flag?: '*' | '!';
  externalId?: string;
}): Transaction {
  return {
    id: newId(),
    date: fields.date,
    flag: fields.flag ?? '*',
    payee: fields.payee,
    narration: fields.narration ?? '',
    postings: [
      { account: fields.category, amount: fields.amount },
      { account: fields.card, amount: -fields.amount },
    ],
    tags: [],
    source: fields.source ?? 'manual',
    externalId: fields.externalId,
  };
}

/** For a two-posting purchase, the "from" (card/bank) and "to" (category) sides. */
export function txnSides(t: Transaction): { from?: Posting; to?: Posting } {
  const from = t.postings.find((p) => rootOf(p.account) === 'Liabilities' || rootOf(p.account) === 'Assets');
  const to = t.postings.find((p) => p !== from);
  return { from, to };
}

/** Amount spent (positive) for display; refunds are negative. */
export function txnAmount(t: Transaction): Cents {
  const expense = t.postings.filter((p) => isCategory(p.account)).reduce((s, p) => s + p.amount, 0);
  if (expense !== 0) return expense;
  const { to } = txnSides(t);
  return to?.amount ?? 0;
}

/** Ensure every account used by a transaction exists and is opened on or before its first use. */
export function ensureAccounts(ledger: Ledger, t: Transaction): Ledger {
  let accounts = ledger.accounts;
  for (const p of t.postings) {
    const existing = accounts.find((a) => a.name === p.account);
    if (!existing) {
      accounts = [...accounts, { name: p.account, label: accountLabel(ledger, p.account), open: t.date, updatedAt: nowISO() }];
    } else if (t.date < existing.open) {
      accounts = accounts.map((a) => (a.name === p.account ? { ...a, open: t.date, updatedAt: nowISO() } : a));
    }
  }
  return accounts === ledger.accounts ? ledger : { ...ledger, accounts };
}

export function upsertTransaction(ledger: Ledger, input: Transaction): Ledger {
  if (!txnBalances(input)) throw new Error('Transaction does not balance');
  const t = { ...input, updatedAt: nowISO() };
  const exists = ledger.transactions.some((x) => x.id === t.id);
  const transactions = exists
    ? ledger.transactions.map((x) => (x.id === t.id ? t : x))
    : [...ledger.transactions, t];
  return ensureAccounts({ ...ledger, transactions }, t);
}

export function deleteTransaction(ledger: Ledger, id: string): Ledger {
  const t = ledger.transactions.find((x) => x.id === id);
  const tombstone: Tombstone = { at: nowISO(), ...(t?.externalId ? { externalId: t.externalId } : {}) };
  return {
    ...ledger,
    transactions: ledger.transactions.filter((x) => x.id !== id),
    tombstones: { ...ledger.tombstones, [id]: tombstone },
  };
}

export function sortedTransactions(ledger: Ledger): Transaction[] {
  return [...ledger.transactions].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
}

export function addAccount(ledger: Ledger, name: string, label: string, open: string): Ledger {
  if (!isValidAccountName(name)) throw new Error(`Invalid account name: ${name}`);
  if (ledger.accounts.some((a) => a.name === name)) throw new Error('That account already exists');
  return { ...ledger, accounts: [...ledger.accounts, { name, label, open, updatedAt: nowISO() }] };
}

export function updateAccount(ledger: Ledger, name: string, patch: Partial<Pick<Account, 'label' | 'closed' | 'owner'>>): Ledger {
  return {
    ...ledger,
    accounts: ledger.accounts.map((a) => (a.name === name ? { ...a, ...patch, updatedAt: nowISO() } : a)),
  };
}

/** Set (or change) a category's budget starting from `from` month. Replaces an entry for the same month. */
export function setBudget(ledger: Ledger, entry: BudgetEntry): Ledger {
  const budgets = ledger.budgets.filter((b) => !(b.account === entry.account && b.from === entry.from));
  budgets.push({ ...entry, updatedAt: nowISO() });
  budgets.sort((a, b) => (a.from === b.from ? a.account.localeCompare(b.account) : a.from < b.from ? -1 : 1));
  return { ...ledger, budgets };
}

/** Light structural check for data loaded from storage or a backup. */
export function assertLedger(x: unknown): asserts x is Ledger {
  const l = x as Ledger;
  if (!l || typeof l !== 'object' || l.version !== LEDGER_VERSION || !Array.isArray(l.accounts) ||
      !Array.isArray(l.transactions) || !Array.isArray(l.budgets)) {
    throw new Error('Not a valid ledger');
  }
}

/** Mark every record as new: used when the ledger is replaced by a restore or file import. */
export function markReplaced(ledger: Ledger): Ledger {
  const at = nowISO();
  return {
    ...ledger,
    resetAt: at,
    accounts: ledger.accounts.map((a) => ({ ...a, updatedAt: at })),
    transactions: ledger.transactions.map((t) => ({ ...t, updatedAt: at })),
    budgets: ledger.budgets.map((b) => ({ ...b, updatedAt: at })),
    tombstones: {},
  };
}

/** Mark the given transactions (default: all awaiting review) as reviewed. */
export function approveTransactions(ledger: Ledger, ids?: Set<string>): Ledger {
  const at = nowISO();
  return {
    ...ledger,
    transactions: ledger.transactions.map((t) =>
      t.flag === '!' && (!ids || ids.has(t.id)) ? { ...t, flag: '*', updatedAt: at } : t),
  };
}

export function setPeople(ledger: Ledger, names: string[]): Ledger {
  const people = [...new Set(names.map((n) => n.trim()).filter((n) => n && n !== SHARED))];
  return { ...ledger, people, peopleUpdatedAt: nowISO() };
}

/** Rename a person everywhere (their cards follow). */
export function renamePerson(ledger: Ledger, from: string, to: string): Ledger {
  const name = to.trim();
  if (!name || name === from) return ledger;
  const at = nowISO();
  return {
    ...setPeople(ledger, (ledger.people ?? []).map((p) => (p === from ? name : p))),
    accounts: ledger.accounts.map((a) => (a.owner === from ? { ...a, owner: name, updatedAt: at } : a)),
  };
}

/** Remove a person; their cards become unassigned. */
export function removePerson(ledger: Ledger, name: string): Ledger {
  const at = nowISO();
  return {
    ...setPeople(ledger, (ledger.people ?? []).filter((p) => p !== name)),
    accounts: ledger.accounts.map((a) => (a.owner === name ? { ...a, owner: undefined, updatedAt: at } : a)),
  };
}

/** Whose spending a transaction is: the owner of the card (or bank account) it was paid with. */
export function txnOwner(ledger: Ledger, t: Transaction, owners?: Map<string, string | undefined>): string | undefined {
  const from = t.postings.find((p) => p.account.startsWith('Liabilities:') || p.account.startsWith('Assets:'));
  if (!from) return undefined;
  if (owners) return owners.get(from.account);
  return ledger.accounts.find((a) => a.name === from.account)?.owner;
}

export function ownerMap(ledger: Ledger): Map<string, string | undefined> {
  return new Map(ledger.accounts.map((a) => [a.name, a.owner]));
}

/**
 * Remove every transaction, on all synced phones, keeping people, cards, categories, budgets and
 * bank-account mappings. Bank transactions come back on the next import.
 */
export function startOver(ledger: Ledger): Ledger {
  const at = nowISO();
  return {
    ...ledger,
    resetAt: at,
    transactions: [],
    tombstones: {},
    accounts: ledger.accounts.map((a) => ({ ...a, updatedAt: at })),
    budgets: ledger.budgets.map((b) => ({ ...b, updatedAt: at })),
  };
}

/** Whether an account is in use: by a transaction, a budget, or a current bank-feed mapping. */
export function isAccountUsed(ledger: Ledger, name: string): boolean {
  if (ledger.transactions.some((t) => t.postings.some((p) => p.account === name))) return true;
  if (ledger.budgets.some((b) => b.account === name && b.amount > 0)) return true;
  const current = ledger.lastImportAccounts;
  return Object.entries(ledger.importAccounts ?? {}).some(
    ([id, a]) => a.account === name && (!current || current.includes(id)),
  );
}

/** Remove unused accounts (on all phones). Stale bank-feed mappings to them are cleared. */
export function deleteAccounts(ledger: Ledger, names: string[]): Ledger {
  const doomed = new Set(names.filter((n) => !isAccountUsed(ledger, n)));
  if (!doomed.size) return ledger;
  const at = nowISO();
  const importAccounts = Object.fromEntries(Object.entries(ledger.importAccounts ?? {}).map(([id, a]) =>
    [id, a.account && doomed.has(a.account) ? { ...a, account: null, updatedAt: at } : a]));
  return {
    ...ledger,
    accounts: ledger.accounts.map((a) => (doomed.has(a.name) ? { ...a, deleted: true, closed: true, updatedAt: at } : a)),
    ...(ledger.importAccounts ? { importAccounts } : {}),
  };
}
