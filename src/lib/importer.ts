// Turns bank-feed data (from the daily SimpleFIN job) into ledger transactions awaiting review.

import { addDays, todayISO } from './dates';
import {
  OPENING_ACCOUNT, isCard, newId, nowISO, toAccountComponent,
  type BankBalance, type ImportAccount, type Ledger, type Transaction,
} from './ledger';
import { parseCents } from './money';

/** What the daily job encrypts into inbox/*.json (see importer/import.mjs). */
export interface ImportPayload {
  v: 1;
  fetchedAt: string;
  accounts: Array<{
    id: string; name: string; org: string; currency: string;
    /** Bank-reported balance (negative = owed on a card), as of balanceDate (unix seconds). */
    balance?: string; balanceDate?: number | null;
    /** Sum of pending (not yet posted) transactions. */
    pending?: string;
  }>;
  transactions: Array<{
    id: string;
    account: string;
    posted: number;
    transactedAt?: number | null;
    amount: string;
    description: string;
    payee?: string;
    pending?: boolean;
  }>;
}

export function assertPayload(x: unknown): asserts x is ImportPayload {
  const p = x as ImportPayload;
  if (!p || p.v !== 1 || !Array.isArray(p.accounts) || !Array.isArray(p.transactions)) throw new Error('Bad import file');
}

/** "TST* BLUE BOTTLE COFFEE #123 OAKLAND CA" -> "Blue Bottle Coffee" (best effort). */
export function cleanPayee(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ');
  s = s.replace(/^(SQ|TST|PY|SP|DD|PP|IC|GOOGLE|PAYPAL|APL|AMZN MKTP US)\s*\*\s*/i, '');
  s = s.replace(/\s+(#\d+|\d{3,}).*$/, ''); // store numbers and what follows
  s = s.replace(/\s+[A-Z][A-Za-z]+\s+[A-Z]{2}$/, (m) => (/[a-z]/.test(m) ? m : '')); // trailing "CITY ST"
  s = s.replace(/[*#]+\s*$/, '').trim();
  if (!s) s = raw.trim();
  if (s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/'S\b/g, "'s");
    s = s.replace(/\.(Com|Net|Org|Io|Co)\b/g, (m) => m.toLowerCase());
  }
  return s;
}

function payeeKey(p: string): string {
  return p.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 3).join(' ');
}

const RULES: Array<[RegExp, string]> = [
  [/trader joe|whole foods|safeway|kroger|costco|walmart grocery|aldi|wegmans|publix|h-?e-?b\b|sprouts|stop & shop|ralphs|vons|albertsons|instacart|grocery|market/i, 'Expenses:Food:Groceries'],
  [/starbucks|dunkin|peet|blue bottle|philz|coffee|cafe|tea\b/i, 'Expenses:Food:Coffee'],
  [/doordash|uber ?eats|grubhub|restaurant|pizza|burger|chipotle|mcdonald|taco|sushi|kitchen|grill|bistro|diner|bar\b|bbq|ramen|thai|deli/i, 'Expenses:Food:Dining'],
  [/shell|chevron|exxon|mobil|bp\b|arco|76\b|valero|sunoco|speedway|wawa|gas\b|fuel/i, 'Expenses:Transport:Gas'],
  [/uber|lyft|metro|transit|mta\b|bart|clipper|amtrak/i, 'Expenses:Transport:Rideshare'],
  [/parking|toll|ez ?pass|fastrak|spothero/i, 'Expenses:Transport:Parking-Tolls'],
  [/netflix|spotify|hulu|disney|apple\.com\/bill|youtube|hbo|max\.com|paramount|peacock|audible|icloud|patreon|subscription/i, 'Expenses:Subscriptions'],
  [/pg&e|con ?ed|electric|water|utility|comcast|xfinity|verizon|at&t|t-mobile|spectrum|internet/i, 'Expenses:Home:Utilities'],
  [/cvs|walgreens|rite aid|pharmacy|doctor|dental|clinic|hospital|medical|optometr/i, 'Expenses:Health'],
  [/home depot|lowe|ikea|bed bath|container store|ace hardware/i, 'Expenses:Home:Supplies'],
  [/amazon|amzn|target|best buy|ebay|etsy|walmart/i, 'Expenses:Shopping:General'],
  [/nordstrom|macy|gap\b|old navy|uniqlo|zara|h&m|nike|tj ?maxx|marshalls/i, 'Expenses:Shopping:Clothing'],
  [/airline|airlines|delta|united|southwest|jetblue|hotel|marriott|hilton|airbnb|expedia|booking\.com/i, 'Expenses:Travel'],
  [/movie|cinema|amc\b|theater|theatre|ticketmaster|steam|playstation|xbox|nintendo/i, 'Expenses:Entertainment'],
  [/salon|barber|spa\b|sephora|ulta/i, 'Expenses:Personal-Care'],
  [/interest charge|annual fee|late fee|foreign transaction/i, 'Expenses:Fees-Interest'],
];

const PAYMENT_RE = /payment|autopay|thank you|pymt|online transfer/i;

/** Best category guess: what you chose last time for this payee, else keyword rules, else Other. */
export function guessCategory(ledger: Ledger, payee: string, raw: string): string {
  const key = payeeKey(payee);
  let best: Transaction | undefined;
  for (const t of ledger.transactions) {
    if (t.flag !== '*' || payeeKey(t.payee) !== key) continue;
    if (!best || t.date > best.date) best = t;
  }
  const fromHistory = best?.postings.find((p) => p.account.startsWith('Expenses:'))?.account;
  if (fromHistory) return fromHistory;
  const exists = (a: string) => ledger.accounts.some((x) => x.name === a && !x.closed);
  for (const [re, account] of RULES) if ((re.test(payee) || re.test(raw)) && exists(account)) return account;
  return 'Expenses:Misc';
}

/** Checking, savings and investment accounts: not credit cards, so skipped unless you turn them on. */
const NOT_A_CARD_RE = /checking|chk\b|ckg\b|savings|\bsav\b|money market|\bmma\b|brokerage|invest|retire|\bira\b|401|\bhsa\b|\bcd\b|certificate|deposit|mortgage|auto loan|student loan/i;

export function looksLikeBankAccount(acct: { name: string; org: string }): boolean {
  return NOT_A_CARD_RE.test(acct.name);
}

/** Pick which ledger card a newly seen bank account should import into. */
function autoMap(ledger: Ledger, mapped: Set<string>, acct: { name: string; org: string }): { account: string; create?: string } {
  const text = `${acct.org} ${acct.name}`.toLowerCase();
  const cards = ledger.accounts.filter((a) => isCard(a.name) && !a.closed);
  const brand = /american express|amex/.test(text) ? /amex|american express/i : /chase/.test(text) ? /chase/i : null;
  const match = brand && cards.find((c) => !mapped.has(c.name) && brand.test(`${c.name} ${c.label}`));
  if (match) return { account: match.name };
  // A new card account, named after the bank account.
  const base = `Liabilities:CreditCard:${toAccountComponent(acct.name || acct.org)}`;
  let name = base;
  for (let i = 2; ledger.accounts.some((a) => a.name === name); i++) name = `${base}-${i}`;
  return { account: name, create: acct.name || acct.org };
}

function localDate(unix: number): string {
  return todayISO(new Date(unix * 1000));
}

/** Add new bank transactions to the ledger (flagged for review). Returns how many were added. */
export function applyImport(ledger: Ledger, payload: ImportPayload): { ledger: Ledger; added: number } {
  const now = nowISO();
  let accounts = [...ledger.accounts];
  const importAccounts: Record<string, ImportAccount> = { ...ledger.importAccounts };

  const mapped = new Set(Object.values(importAccounts).map((a) => a.account).filter((a): a is string => !!a));
  // Accounts we knew before but that are missing from this import: likely re-linked under a new id.
  const inPayload = new Set(payload.accounts.map((a) => a.id));
  const gone = new Map(Object.entries(importAccounts).filter(([id]) => !inPayload.has(id)));
  const relinkedFrom = new Map<string, string>(); // new id -> old id
  const same = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();
  for (const a of payload.accounts) {
    if (importAccounts[a.id]) continue;
    const old = [...gone].find(([, o]) => same(o.name, a.name) && same(o.org, a.org));
    if (old) {
      gone.delete(old[0]);
      relinkedFrom.set(a.id, old[0]);
      importAccounts[a.id] = { name: a.name, org: a.org, account: old[1].account, updatedAt: now };
      continue;
    }
    if ((a.currency && a.currency !== 'USD') || looksLikeBankAccount(a)) {
      importAccounts[a.id] = { name: a.name, org: a.org, account: null, updatedAt: now };
      continue;
    }
    const pick = autoMap({ ...ledger, accounts }, mapped, a);
    if (pick.create) accounts.push({ name: pick.account, label: pick.create, open: todayISO(), updatedAt: now });
    mapped.add(pick.account);
    importAccounts[a.id] = { name: a.name, org: a.org, account: pick.account, updatedAt: now };
  }

  const seen = new Set<string>();
  for (const t of ledger.transactions) if (t.externalId) seen.add(t.externalId);
  for (const tomb of Object.values(ledger.tombstones ?? {})) if (tomb.externalId) seen.add(tomb.externalId);

  // For re-linked accounts the bank ids change too, so also match on card, date, amount and description.
  const fingerprint = (card: string, date: string, cents: number, desc: string) => `${card}|${date}|${cents}|${desc.trim().toLowerCase()}`;
  const existing = new Map<string, number>();
  if (relinkedFrom.size) {
    for (const t of ledger.transactions) {
      if (t.source !== 'simplefin') continue;
      const card = t.postings.find((p) => isCard(p.account));
      if (!card) continue;
      const key = fingerprint(card.account, t.date, card.amount, t.narration || t.payee);
      existing.set(key, (existing.get(key) ?? 0) + 1);
    }
  }

  const working: Ledger = { ...ledger, accounts };
  const added: Transaction[] = [];
  for (const t of payload.transactions) {
    if (t.pending) continue;
    const target = importAccounts[t.account]?.account;
    if (!target) continue;
    const externalId = `simplefin:${t.account}:${t.id}`;
    if (seen.has(externalId)) continue;
    const bankAmount = parseCents(t.amount);
    if (bankAmount === null || bankAmount === 0) continue;
    seen.add(externalId);

    const raw = (t.payee || t.description || '').trim();
    const payee = cleanPayee(raw) || 'Unknown';
    const spend = -bankAmount; // card purchases come as negative amounts
    const date = localDate(t.transactedAt || t.posted);
    if (relinkedFrom.has(t.account)) {
      const key = fingerprint(target, date, -spend, raw !== payee ? raw : payee);
      const n = existing.get(key) ?? 0;
      if (n > 0) {
        existing.set(key, n - 1);
        continue;
      }
    }
    const isPayment = spend < 0 && PAYMENT_RE.test(raw);
    const other = isPayment ? 'Assets:Bank:Checking' : guessCategory(working, payee, raw);
    added.push({
      id: newId(),
      date,
      flag: '!',
      payee: isPayment ? 'Card payment' : payee,
      narration: raw !== payee ? raw : '',
      postings: [
        { account: other, amount: spend },
        { account: target, amount: -spend },
      ],
      tags: [],
      source: 'simplefin',
      externalId,
      updatedAt: now,
    });
  }

  // Bank balances, and a starting balance per card so the ledger can match the bank.
  const bankBalances: Record<string, BankBalance> = { ...ledger.bankBalances };
  const allTxns = [...ledger.transactions, ...added];
  const taken = new Set([
    ...allTxns.map((t) => t.externalId).filter(Boolean),
    ...Object.values(ledger.tombstones ?? {}).map((x) => x.externalId).filter(Boolean),
  ]);
  for (const a of payload.accounts) {
    const target = importAccounts[a.id]?.account;
    const amount = a.balance !== undefined ? parseCents(a.balance) : null;
    if (!target || !isCard(target) || amount === null) continue;
    const asOf = localDate(a.balanceDate || Date.parse(payload.fetchedAt) / 1000);
    const prev = bankBalances[target];
    if (!prev || payload.fetchedAt >= prev.fetchedAt) {
      bankBalances[target] = { amount, asOf, pending: parseCents(a.pending ?? '0') ?? 0, fetchedAt: payload.fetchedAt };
    }
    // The starting balance is set once: the first time the bank reports this card's balance.
    const openingId = `opening:${target}`;
    if (prev || taken.has(openingId)) continue;
    taken.add(openingId);
    const onCard = allTxns.filter((t) => t.postings.some((p) => p.account === target));
    const sum = onCard.filter((t) => t.date <= asOf)
      .reduce((s, t) => s + t.postings.filter((p) => p.account === target).reduce((x, p) => x + p.amount, 0), 0);
    const diff = amount - sum;
    if (diff === 0) continue;
    const first = onCard.map((t) => t.date).sort()[0] ?? asOf;
    const opening: Transaction = {
      id: newId(),
      date: addDays(first < asOf ? first : asOf, -1),
      flag: '*',
      payee: 'Starting balance',
      narration: 'Balance owed before the first bank import',
      postings: [
        { account: target, amount: diff },
        { account: OPENING_ACCOUNT, amount: -diff },
      ],
      tags: [],
      source: 'import',
      externalId: openingId,
      updatedAt: now,
    };
    added.push(opening);
    allTxns.push(opening);
  }

  // Make sure every account used exists and opens on or before its first use.
  for (const t of added) {
    for (const p of t.postings) {
      const a = accounts.find((x) => x.name === p.account);
      if (!a) accounts.push({ name: p.account, label: p.account.split(':').pop()!.replace(/-/g, ' '), open: t.date, updatedAt: now });
      else if (t.date < a.open) accounts = accounts.map((x) => (x.name === p.account ? { ...x, open: t.date, updatedAt: now } : x));
    }
  }

  const newest = !ledger.lastImportAt || payload.fetchedAt >= ledger.lastImportAt;
  const lastImportAt = newest ? payload.fetchedAt : ledger.lastImportAt;
  const lastImportAccounts = newest ? payload.accounts.map((a) => a.id) : ledger.lastImportAccounts;
  return {
    ledger: {
      ...ledger, accounts, importAccounts, transactions: [...ledger.transactions, ...added], lastImportAt,
      ...(Object.keys(bankBalances).length ? { bankBalances } : {}),
      ...(lastImportAccounts ? { lastImportAccounts } : {}),
    },
    added: added.filter((t) => !t.externalId?.startsWith('opening:')).length,
  };
}

/** Remove imported transactions from one bank-feed account that haven't been reviewed yet. */
export function removeUnreviewedImports(ledger: Ledger, importAccountId: string): { ledger: Ledger; removed: number } {
  const prefix = `simplefin:${importAccountId}:`;
  const doomed = ledger.transactions.filter((t) => t.flag === '!' && t.externalId?.startsWith(prefix));
  const at = nowISO();
  const tombstones = { ...ledger.tombstones };
  for (const t of doomed) tombstones[t.id] = { at, externalId: t.externalId };
  const ids = new Set(doomed.map((t) => t.id));
  return {
    ledger: { ...ledger, transactions: ledger.transactions.filter((t) => !ids.has(t.id)), tombstones },
    removed: doomed.length,
  };
}

export function importedCount(ledger: Ledger, importAccountId: string): { total: number; unreviewed: number } {
  const prefix = `simplefin:${importAccountId}:`;
  let total = 0, unreviewed = 0;
  for (const t of ledger.transactions) {
    if (!t.externalId?.startsWith(prefix)) continue;
    total++;
    if (t.flag === '!') unreviewed++;
  }
  return { total, unreviewed };
}
