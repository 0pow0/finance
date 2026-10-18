// Turns bank-feed data (from the daily SimpleFIN job) into ledger transactions awaiting review.

import { addDays, todayISO } from './dates';
import {
  OPENING_ACCOUNT, isCard, newId, nowISO, toAccountComponent,
  type BankBalance, type ImportAccount, type Ledger, type PendingCharge, type Transaction,
} from './ledger';
import { parseCents } from './money';
import { FALLBACK, classify, learnHistory, payeeKey, type History } from './classify';

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

/** Well-known merchants whose bank descriptions are hard to clean generically. */
const KNOWN_MERCHANTS: Array<[RegExp, string]> = [
  [/^(amzn|amazon)\b|amazon\.com|amzn mktp/i, 'Amazon'],
  [/uber\s*\*?\s*eats/i, 'Uber Eats'],
  [/^uber\b/i, 'Uber'],
  [/^lyft\b/i, 'Lyft'],
  [/^doordash\b/i, 'DoorDash'],
  [/^grubhub\b/i, 'Grubhub'],
  [/^instacart\b/i, 'Instacart'],
  [/^costco\b/i, 'Costco'],
  [/^trader joe/i, 'Trader Joe’s'],
  [/^whole ?foods/i, 'Whole Foods'],
  [/^cvs\b/i, 'CVS'],
  [/^walgreens\b/i, 'Walgreens'],
  [/^pg ?& ?e\b/i, 'PG&E'],
  [/^amc\b/i, 'AMC Theatres'],
  [/^netflix/i, 'Netflix'],
  [/^spotify/i, 'Spotify'],
  [/^apple\.com|^apple store/i, 'Apple'],
  [/^google\b/i, 'Google'],
  [/^target\b/i, 'Target'],
  [/^walmart|^wal-mart|^wm supercenter/i, 'Walmart'],
  [/^starbucks/i, 'Starbucks'],
  [/^(the )?home depot/i, 'The Home Depot'],
  [/^lowe'?s\b/i, 'Lowe’s'],
  [/^chipotle/i, 'Chipotle'],
  [/^mcdonald/i, 'McDonald’s'],
  [/^shell\b/i, 'Shell'],
  [/^chevron/i, 'Chevron'],
  [/^united airlines|^united \d/i, 'United Airlines'],
  [/^delta air/i, 'Delta Air Lines'],
  [/^southwest/i, 'Southwest Airlines'],
  [/^safeway/i, 'Safeway'],
  [/^7-eleven|^7 eleven/i, '7-Eleven'],
];

const SMALL_WORDS = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'in', 'on', 'at', 'for', 'to', 'by']);
const KEEP_UPPER = /^(?:[A-Z]{2,3}|[A-Z]&[A-Z]|[A-Z]+&[A-Z]+)$/; // CVS, AMC, PG&E, H&M
const DROP_WORDS = /\b(WHSE|MKTPL|MKTP|PMT|PYMT|ONLINE|WEB|INC|LLC|CO|CORP|USA|US|STORE)\b/gi;

function titleCase(s: string): string {
  return s.split(' ').map((w, i) => {
    if (KEEP_UPPER.test(w) && !SMALL_WORDS.has(w.toLowerCase())) return w;
    const lower = w.toLowerCase();
    if (i > 0 && SMALL_WORDS.has(lower)) return lower;
    return lower.replace(/(^|[-/])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
  }).join(' ');
}

/** "TST* BLUE BOTTLE COFFEE #123 OAKLAND CA" -> "Blue Bottle Coffee" (best effort). */
export function cleanPayee(raw: string): string {
  const original = raw.trim().replace(/\s+/g, ' ');
  for (const [re, name] of KNOWN_MERCHANTS) if (re.test(original)) return name;
  let s = original.replace(/^(SQ|TST|PY|SP|DD|PP|IC|PAYPAL|APL|BT|CKE|SPO|FS)\s*\*\s*/i, '');
  const star = s.indexOf('*');
  if (star > 0) s = s.slice(0, star); // "MERCHANT*REFERENCE": keep the merchant
  s = s.replace(/\s+(#\s*\d+|\d{3,}).*$/, ''); // store numbers and what follows
  s = s.replace(/\s+[A-Z][A-Z]+(?:\s+[A-Z]+)?\s+[A-Z]{2}$/, ''); // trailing "CITY ST"
  s = s.replace(/\b(\w+) S\b/g, "$1'S"); // "JOE S" -> "JOE'S"
  s = s.replace(/\b[\w-]+\.(com|net|org)\b.*$/i, (m) => (s.trim() === m.trim() ? m : '')); // trailing web address
  if (s === s.toUpperCase()) s = s.replace(DROP_WORDS, ' ');
  s = s.replace(/[*#]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) s = original;
  if (s === s.toUpperCase()) {
    s = titleCase(s).replace(/'S\b/g, "’s").replace(/'s\b/g, '’s');
    s = s.replace(/\.(Com|Net|Org|Io|Co)\b/g, (m) => m.toLowerCase());
  }
  return s;
}

const PAYMENT_RE = /payment|autopay|thank you|pymt|online transfer/i;

/** Best category guess: what you chose before for this store, else the merchant list, else Other. */
export function guessCategory(ledger: Ledger, payee: string, raw: string, history?: History): string {
  return classify(ledger, payee, raw, history);
}

/** Checking, savings and investment accounts: not credit cards, so skipped unless you turn them on. */
const NOT_A_CARD_RE = /checking|chk\b|ckg\b|savings|\bsav\b|money market|\bmma\b|brokerage|invest|retire|\bira\b|401|\bhsa\b|\bcd\b|certificate|deposit|mortgage|auto loan|student loan/i;

export function looksLikeBankAccount(acct: { name: string; org: string }): boolean {
  return NOT_A_CARD_RE.test(acct.name);
}

/** "Chase Bank" -> "Chase", "American Express" -> "Amex". */
function shortBank(org: string): string {
  if (/american express|amex/i.test(org)) return 'Amex';
  return org.replace(/\b(bank|n\.?a\.?|card services|financial|credit card)\b/gi, '').replace(/\s+/g, ' ').trim();
}

/** A clear card name from the bank account, e.g. "Chase Sapphire Preferred", "Amex Gold Card". */
export function cardLabel(acct: { name: string; org: string }): string {
  const bank = shortBank(acct.org);
  const name = acct.name.replace(/\s*\(?[.…]*\d{4}\)?\s*$/, '').trim(); // drop "(...1234)"
  if (!name) return bank || acct.org;
  if (!bank || name.toLowerCase().includes(bank.toLowerCase())) return name;
  return `${bank} ${name}`;
}

const DEFAULT_CARD_LABELS = new Set(['Chase', 'American Express']);

const sameText = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();

/** "Chase Bank", "Chase Bank Rui", "JPMorgan Chase" all count as Chase. */
function bankBrand(org: string): string {
  const o = org.toLowerCase();
  for (const b of ['chase', 'american express', 'amex', 'citi', 'capital one', 'discover', 'wells fargo', 'bank of america', 'us bank', 'barclays', 'apple card']) {
    if (o.includes(b)) return b === 'amex' ? 'american express' : b;
  }
  return shortBank(org).toLowerCase().split(' ')[0] ?? o;
}
const sameBank = (x: string, y: string) => bankBrand(x) === bankBrand(y);

/** How many (date, amount) pairs from a bank account's existing imports appear in `incoming`. */
function overlap(ledger: Ledger, importId: string, incoming: Array<{ date: string; cents: number }>): number {
  const have = new Map<string, number>();
  for (const t of ledger.transactions) {
    if (!t.externalId?.startsWith(`simplefin:${importId}:`)) continue;
    const card = t.postings.find((p) => isCard(p.account));
    if (card) have.set(`${t.date}|${card.amount}`, (have.get(`${t.date}|${card.amount}`) ?? 0) + 1);
  }
  let n = 0;
  for (const t of incoming) {
    const k = `${t.date}|${t.cents}`; // bank sign equals the card posting's sign
    if ((have.get(k) ?? 0) > 0) { have.set(k, have.get(k)! - 1); n++; }
  }
  return n;
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
  return { account: name, create: cardLabel(acct) };
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
  for (const a of payload.accounts) {
    if (importAccounts[a.id]) continue;
    // Same card name at the same bank (the connection's display name may change, e.g. "Chase Bank Rui").
    // With several candidates, prefer the one whose past transactions overlap this account's.
    const candidates = [...gone].filter(([, o]) => sameText(o.name, a.name) && sameBank(o.org, a.org));
    const incoming = payload.transactions.filter((t) => t.account === a.id && !t.pending)
      .map((t) => ({ date: localDate(t.transactedAt || t.posted), cents: parseCents(t.amount) ?? 0 }));
    const old = candidates.length <= 1 ? candidates[0] : candidates
      .map((c) => ({ c, score: overlap(ledger, c[0], incoming) }))
      .sort((x, y) => y.score - x.score)[0]?.c;
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
  const history = learnHistory(ledger);
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
    const other = isPayment ? 'Assets:Bank:Checking' : guessCategory(working, payee, raw, history);
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

  // Pending charges: replace each card's snapshot with what the bank shows now.
  const pendingCharges: NonNullable<Ledger['pendingCharges']> = { ...ledger.pendingCharges };
  for (const a of payload.accounts) {
    const target = importAccounts[a.id]?.account;
    if (!target) continue;
    if (pendingCharges[target] && pendingCharges[target].fetchedAt > payload.fetchedAt) continue;
    const items: PendingCharge[] = [];
    for (const t of payload.transactions) {
      if (!t.pending || t.account !== a.id) continue;
      const cents = parseCents(t.amount);
      if (cents === null || cents === 0) continue;
      const raw = (t.payee || t.description || '').trim();
      const payee = cleanPayee(raw) || 'Unknown';
      items.push({
        id: `${t.account}:${t.id}`,
        date: localDate(t.transactedAt || t.posted || Date.parse(payload.fetchedAt) / 1000),
        payee,
        description: raw,
        amount: -cents,
        category: guessCategory(working, payee, raw, history),
      });
    }
    pendingCharges[target] = { fetchedAt: payload.fetchedAt, items: items.sort((x, y) => (x.date < y.date ? 1 : -1)) };
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
      bankBalances[target] = {
        amount, asOf, pending: parseCents(a.pending ?? '0') ?? 0, fetchedAt: payload.fetchedAt,
        ...(a.balanceDate ? { refreshedAt: new Date(a.balanceDate * 1000).toISOString() } : {}),
      };
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

  // Give cards still called just "Chase" / "American Express" the bank account's name.
  for (const a of payload.accounts) {
    const target = importAccounts[a.id]?.account;
    const card = target && accounts.find((x) => x.name === target);
    if (card && DEFAULT_CARD_LABELS.has(card.label)) {
      accounts = accounts.map((x) => (x.name === target ? { ...x, label: cardLabel(a), updatedAt: now } : x));
    }
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
  const result: Ledger = {
    ...ledger, accounts, importAccounts, transactions: [...recategorized({ ...ledger, accounts, transactions: recleaned(ledger.transactions, now) }, now, history), ...added], lastImportAt,
    ...(Object.keys(bankBalances).length ? { bankBalances } : {}),
    ...(Object.keys(pendingCharges).length ? { pendingCharges } : {}),
    ...(lastImportAccounts ? { lastImportAccounts } : {}),
  };
  const repaired = repairRelinks(result);
  const removed = result.transactions.length - repaired.ledger.transactions.length;
  return {
    ledger: repaired.ledger,
    added: Math.max(0, added.filter((t) => !t.externalId?.startsWith('opening:')).length - removed),
  };
}

/**
 * Undo duplicates left by a bank reconnect that wasn't recognized: a bank account re-added under a
 * new id (same card name, same bank) got its own new card. Move it back onto the original card,
 * drop transactions already imported there, the extra starting balance and the extra card.
 * Owners, categories and reviews on the original card are kept.
 */
export function repairRelinks(ledger: Ledger): { ledger: Ledger; repaired: number } {
  const current = new Set(ledger.lastImportAccounts ?? []);
  if (!current.size) return { ledger, repaired: 0 };
  let l = ledger;
  let repaired = 0;
  const now = nowISO();
  for (const [nid, n] of Object.entries(l.importAccounts ?? {})) {
    if (!current.has(nid) || !n.account) continue;
    const cardNew = n.account;
    // Only repair cards that this bank account alone feeds.
    if (Object.entries(l.importAccounts ?? {}).some(([id, x]) => id !== nid && current.has(id) && x.account === cardNew)) continue;
    const incoming = l.transactions
      .filter((t) => t.externalId?.startsWith(`simplefin:${nid}:`))
      .map((t) => ({ date: t.date, cents: t.postings.find((p) => p.account === cardNew)?.amount ?? 0 }));
    const candidates = Object.entries(l.importAccounts ?? {}).filter(([oid, o]) =>
      oid !== nid && !current.has(oid) && o.account && o.account !== cardNew &&
      sameText(o.name, n.name) && sameBank(o.org, n.org) &&
      l.accounts.some((a) => a.name === o.account && !a.deleted));
    if (!candidates.length) continue;
    const scored = candidates.map(([oid, o]) => ({ oid, card: o.account!, score: overlap(l, oid, incoming) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (candidates.length > 1 && (best.score === 0 || scored[1].score === best.score)) continue; // ambiguous
    const cardOld = best.card;

    // (date, amount) of what the original account already imported onto the original card.
    const have = new Map<string, number>();
    for (const t of l.transactions) {
      if (!t.externalId?.startsWith(`simplefin:${best.oid}:`)) continue;
      const amt = t.postings.find((p) => p.account === cardOld)?.amount;
      if (amt !== undefined) have.set(`${t.date}|${amt}`, (have.get(`${t.date}|${amt}`) ?? 0) + 1);
    }
    const tombstones = { ...l.tombstones };
    const transactions: Transaction[] = [];
    for (const t of l.transactions) {
      if (!t.postings.some((p) => p.account === cardNew)) { transactions.push(t); continue; }
      if (t.externalId === `opening:${cardNew}`) {
        tombstones[t.id] = { at: now, externalId: t.externalId };
        continue;
      }
      const amt = t.postings.find((p) => p.account === cardNew)!.amount;
      const k = `${t.date}|${amt}`;
      if (t.externalId?.startsWith(`simplefin:${nid}:`) && (have.get(k) ?? 0) > 0) {
        have.set(k, have.get(k)! - 1);
        tombstones[t.id] = { at: now, externalId: t.externalId };
        continue;
      }
      transactions.push({ ...t, postings: t.postings.map((p) => (p.account === cardNew ? { ...p, account: cardOld } : p)), updatedAt: now });
    }
    const moveNewer = <T extends { fetchedAt: string }>(m: Record<string, T> | undefined) => {
      if (!m?.[cardNew]) return m;
      const out = { ...m };
      if (!out[cardOld] || out[cardNew].fetchedAt >= out[cardOld].fetchedAt) out[cardOld] = out[cardNew];
      delete out[cardNew];
      return out;
    };
    l = {
      ...l,
      transactions,
      tombstones,
      importAccounts: { ...l.importAccounts, [nid]: { ...n, account: cardOld, updatedAt: now } },
      accounts: l.accounts.map((a) => (a.name === cardNew ? { ...a, deleted: true, closed: true, updatedAt: now } : a)),
      ...(l.bankBalances ? { bankBalances: moveNewer(l.bankBalances) } : {}),
      ...(l.pendingCharges ? { pendingCharges: moveNewer(l.pendingCharges) } : {}),
    };
    repaired++;
  }
  return { ledger: l, repaired };
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

/** All pending charges, newest first, with the card they're on. */
export function allPending(ledger: Ledger): Array<PendingCharge & { card: string }> {
  return Object.entries(ledger.pendingCharges ?? {})
    .flatMap(([card, snap]) => snap.items.map((p) => ({ ...p, card })))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Re-apply the store-name cleanup to imported transactions that haven't been reviewed yet. */
function recleaned(txns: Transaction[], now: string): Transaction[] {
  return txns.map((t) => {
    if (t.source !== 'simplefin' || t.flag !== '!' || !t.narration || t.payee === 'Card payment') return t;
    const payee = cleanPayee(t.narration);
    return payee && payee !== t.payee ? { ...t, payee, updatedAt: now } : t;
  });
}

/**
 * Re-guess categories for imported purchases you haven't reviewed, and for reviewed ones left in
 * Other, so a better guess (or something you taught it since) applies to them too.
 */
function recategorized(ledger: Ledger, now: string, history: History): Transaction[] {
  return ledger.transactions.map((t) => {
    if (t.source !== 'simplefin' || t.payee === 'Card payment' || t.postings.length !== 2) return t;
    const i = t.postings.findIndex((p) => p.account.startsWith('Expenses:'));
    if (i < 0) return t;
    const current = t.postings[i].account;
    if (t.flag !== '!' && current !== FALLBACK) return t;
    const guess = classify(ledger, t.payee, t.narration || t.payee, history);
    if (guess === current || (t.flag !== '!' && guess === FALLBACK)) return t;
    return { ...t, postings: t.postings.map((p, j) => (j === i ? { ...p, account: guess } : p)), updatedAt: now };
  });
}

/** Recategorize now (e.g. right after an update), without waiting for the next import. */
export function recategorize(ledger: Ledger): Ledger {
  const now = nowISO();
  const transactions = recategorized(ledger, now, learnHistory(ledger));
  return transactions.every((t, i) => t === ledger.transactions[i]) ? ledger : { ...ledger, transactions };
}

/**
 * After you change a purchase's category, give the same store's other unreviewed purchases the
 * same category. Returns how many others changed.
 */
export function applyCategoryToSimilar(ledger: Ledger, edited: Transaction): { ledger: Ledger; changed: number } {
  const category = edited.postings.find((p) => p.account.startsWith('Expenses:'))?.account;
  if (!category || category === FALLBACK) return { ledger, changed: 0 };
  const key = payeeKey(edited.payee);
  if (!key) return { ledger, changed: 0 };
  const now = nowISO();
  let changed = 0;
  const transactions = ledger.transactions.map((t) => {
    if (t.id === edited.id || t.flag !== '!' || payeeKey(t.payee) !== key || t.postings.length !== 2) return t;
    const i = t.postings.findIndex((p) => p.account.startsWith('Expenses:'));
    if (i < 0 || t.postings[i].account === category) return t;
    changed++;
    return { ...t, postings: t.postings.map((p, j) => (j === i ? { ...p, account: category } : p)), updatedAt: now };
  });
  return changed ? { ledger: { ...ledger, transactions }, changed } : { ledger, changed: 0 };
}
