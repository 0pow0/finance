// Read and write the Beancount text format (https://beancount.github.io/docs/).
// The writer produces files that pass `bean-check`. The reader understands the subset
// this app writes, plus common hand-written forms (elided posting amounts, comments, tags).

import { centsToDecimal, parseCents } from './money';
import {
  LEDGER_VERSION,
  isValidAccountName,
  newId,
  type Account,
  type BudgetEntry,
  type Ledger,
  type Posting,
  type Transaction,
  type TxnSource,
} from './ledger';

function quote(s: string): string {
  return `"${s.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tagify(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_/.-]/g, '-');
}

export function toBeancount(ledger: Ledger): string {
  const out: string[] = [];
  out.push(`option "title" ${quote(ledger.title)}`);
  out.push(`option "operating_currency" "${ledger.currency}"`);
  out.push('');

  // Open each account on or before the first date it is used.
  const firstUse = new Map<string, string>();
  for (const t of ledger.transactions) {
    for (const p of t.postings) {
      const cur = firstUse.get(p.account);
      if (!cur || t.date < cur) firstUse.set(p.account, t.date);
    }
  }
  const accounts = [...ledger.accounts].sort((a, b) => a.name.localeCompare(b.name));
  for (const a of accounts) {
    const used = firstUse.get(a.name);
    const open = used && used < a.open ? used : a.open;
    out.push(`${open} open ${a.name} ${ledger.currency}`);
    out.push(`  label: ${quote(a.label)}`);
  }
  out.push('');

  for (const b of ledger.budgets) {
    out.push(`${b.from}-01 custom "budget" ${b.account} "monthly" ${centsToDecimal(b.amount)} ${ledger.currency}`);
    out.push(`  mode: ${quote(b.mode)}`);
  }
  if (ledger.budgets.length) out.push('');

  const txns = [...ledger.transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const t of txns) {
    const tags = t.tags.map((x) => ` #${tagify(x)}`).join('');
    out.push(`${t.date} ${t.flag} ${quote(t.payee)} ${quote(t.narration)}${tags}`);
    out.push(`  id: ${quote(t.id)}`);
    out.push(`  source: ${quote(t.source)}`);
    if (t.externalId) out.push(`  external_id: ${quote(t.externalId)}`);
    for (const p of t.postings) {
      out.push(`  ${p.account}  ${centsToDecimal(p.amount)} ${ledger.currency}`);
    }
    out.push('');
  }
  return out.join('\n');
}

export class BeancountParseError extends Error {
  constructor(public line: number, message: string) {
    super(`Line ${line}: ${message}`);
  }
}

function unquote(s: string): string {
  return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

const STR = String.raw`"(?:[^"\\]|\\.)*"`;
const DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const OPEN_RE = new RegExp(String.raw`^(${DATE})\s+open\s+(\S+)(?:\s+([A-Z,]+))?\s*$`);
const CLOSE_RE = new RegExp(String.raw`^(${DATE})\s+close\s+(\S+)\s*$`);
const TXN_RE = new RegExp(String.raw`^(${DATE})\s+(\*|!|txn)\s*((?:${STR}\s*){0,2})((?:\s*[#^][^\s]+)*)\s*$`);
const BUDGET_RE = new RegExp(
  String.raw`^(${DATE})\s+custom\s+"budget"\s+(\S+)\s+"monthly"\s+(-?[\d,]+(?:\.\d+)?)\s+([A-Z]+)\s*$`,
);
const META_RE = new RegExp(String.raw`^\s+([a-z][A-Za-z0-9_-]*):\s*(.*?)\s*$`);
const POSTING_RE = /^\s+(?:[*!]\s+)?([A-Z][A-Za-z0-9:-]+)(?:\s+(-?[\d,]*\.?\d+)\s+([A-Z]+))?\s*(?:;.*)?$/;
const STR_G = new RegExp(STR, 'g');

interface Block {
  line: number;
  head: string;
  body: Array<{ line: number; text: string }>;
}

function metaValue(v: string): string {
  return v.startsWith('"') ? unquote(v) : v;
}

export function fromBeancount(text: string): Ledger {
  const ledger: Ledger = {
    version: LEDGER_VERSION,
    title: 'Household',
    currency: 'USD',
    accounts: [],
    transactions: [],
    budgets: [],
  };

  // Group lines into directive blocks: an unindented head and its indented body.
  const blocks: Block[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (/^\s*(;.*)?$/.test(raw) || /^\s*[*#]/.test(raw) && !/^\s/.test(raw)) return;
    if (/^\s/.test(raw)) {
      const block = blocks[blocks.length - 1];
      if (!block) throw new BeancountParseError(lineNo, 'Indented line without a directive');
      block.body.push({ line: lineNo, text: raw.replace(/\s;.*$/, '') });
    } else {
      blocks.push({ line: lineNo, head: raw.replace(/\s;[^"]*$/, ''), body: [] });
    }
  });

  const accounts = new Map<string, Account>();

  for (const b of blocks) {
    const meta = new Map<string, string>();
    const rest: Array<{ line: number; text: string }> = [];
    for (const l of b.body) {
      const m = META_RE.exec(l.text);
      if (m && !/^\s+[A-Z]/.test(l.text)) meta.set(m[1], metaValue(m[2]));
      else rest.push(l);
    }

    let m: RegExpExecArray | null;
    if (b.head.startsWith('option ')) {
      const [key, value] = (b.head.match(STR_G) ?? []).map(unquote);
      if (key === 'title' && value) ledger.title = value;
      if (key === 'operating_currency' && value && value !== 'USD') {
        throw new BeancountParseError(b.line, `Only USD is supported (found ${value})`);
      }
    } else if ((m = OPEN_RE.exec(b.head))) {
      const [, date, name, cur] = m;
      if (!isValidAccountName(name)) throw new BeancountParseError(b.line, `Invalid account ${name}`);
      if (cur && cur.split(',').some((c) => c !== 'USD')) {
        throw new BeancountParseError(b.line, `Only USD is supported (account ${name})`);
      }
      accounts.set(name, { name, label: meta.get('label') ?? defaultLabel(name), open: date });
    } else if ((m = CLOSE_RE.exec(b.head))) {
      const acct = accounts.get(m[2]);
      if (acct) acct.closed = true;
    } else if ((m = BUDGET_RE.exec(b.head))) {
      const [, date, account, amount, cur] = m;
      if (cur !== 'USD') throw new BeancountParseError(b.line, `Only USD is supported (found ${cur})`);
      const cents = parseCents(amount);
      if (cents === null) throw new BeancountParseError(b.line, `Bad amount ${amount}`);
      const mode = meta.get('mode') === 'fixed' ? 'fixed' : 'rollover';
      ledger.budgets.push({ account, from: date.slice(0, 7), amount: cents, mode } satisfies BudgetEntry);
    } else if ((m = TXN_RE.exec(b.head))) {
      const [, date, flag, strs, tagStr] = m;
      const strings = (strs.match(STR_G) ?? []).map(unquote);
      const [payee, narration] = strings.length === 2 ? strings : ['', strings[0] ?? ''];
      const tags = (tagStr.match(/#[^\s]+/g) ?? []).map((t) => t.slice(1));
      const postings: Posting[] = [];
      let elided: string | null = null;
      for (const l of rest) {
        const pm = POSTING_RE.exec(l.text);
        if (!pm) throw new BeancountParseError(l.line, `Unsupported posting: ${l.text.trim()}`);
        const [, account, amount, cur] = pm;
        if (!amount) {
          if (elided) throw new BeancountParseError(l.line, 'Only one posting may omit its amount');
          elided = account;
          continue;
        }
        if (cur !== 'USD') throw new BeancountParseError(l.line, `Only USD is supported (found ${cur})`);
        const cents = parseCents(amount);
        if (cents === null) throw new BeancountParseError(l.line, `Bad amount ${amount}`);
        postings.push({ account, amount: cents });
      }
      const sum = postings.reduce((s, p) => s + p.amount, 0);
      if (elided) postings.push({ account: elided, amount: -sum });
      else if (sum !== 0) throw new BeancountParseError(b.line, 'Transaction does not balance');
      const source = (meta.get('source') ?? 'import') as TxnSource;
      const t: Transaction = {
        id: meta.get('id') ?? newId(),
        date,
        flag: flag === '!' ? '!' : '*',
        payee,
        narration,
        postings,
        tags,
        source: ['manual', 'applepay', 'simplefin', 'import'].includes(source) ? source : 'import',
      };
      const ext = meta.get('external_id');
      if (ext) t.externalId = ext;
      ledger.transactions.push(t);
    } else if (/^\d{4}-\d{2}-\d{2}\s+(balance|note|document|event|price|pad|commodity|custom|query)\b/.test(b.head)) {
      // Valid Beancount, but not something this app tracks yet.
    } else if (/^(plugin|include|pushtag|poptag|pushmeta|popmeta)\b/.test(b.head)) {
      // Ignored.
    } else {
      throw new BeancountParseError(b.line, `Unrecognized line: ${b.head}`);
    }
  }

  // Accounts used without an open directive get one on first use.
  for (const t of ledger.transactions) {
    for (const p of t.postings) {
      if (!accounts.has(p.account)) {
        accounts.set(p.account, { name: p.account, label: defaultLabel(p.account), open: t.date });
      }
    }
  }
  ledger.accounts = [...accounts.values()];
  return ledger;
}

function defaultLabel(name: string): string {
  return name.split(':').slice(-1)[0].replace(/-/g, ' ');
}
