import { useMemo, useState } from 'react';
import { isValidDate, todayISO } from '../lib/dates';
import {
  accountLabel, isCategory, newId, sortedTransactions, txnSides,
  type Ledger, type Transaction,
} from '../lib/ledger';
import { centsToDecimal, parseCents } from '../lib/money';
import { Sheet, cards, categories, categoryGroup, transferAccounts } from './common';
import { useConfirm } from './confirm';

/** The most recent category and card used with this payee, to pre-fill the form. */
function lastUse(ledger: Ledger, payee: string): { category?: string; card?: string } {
  const p = payee.trim().toLowerCase();
  if (!p) return {};
  const t = sortedTransactions(ledger).find((x) => x.payee.trim().toLowerCase() === p);
  if (!t) return {};
  const { from, to } = txnSides(t);
  return { category: to?.account, card: from?.account };
}

export function TxnEditor({ ledger, txn, onSave, onDelete, onClose }: {
  ledger: Ledger;
  txn?: Transaction;
  onSave: (t: Transaction) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}) {
  const ask = useConfirm();
  const cardList = cards(ledger);
  const catList = categories(ledger);
  const sides = txn ? txnSides(txn) : undefined;
  const simple = !txn || txn.postings.length === 2;
  const initialAmount = sides?.to?.amount ?? 0;

  const [amount, setAmount] = useState(txn ? centsToDecimal(Math.abs(initialAmount)) : '');
  const [refund, setRefund] = useState(initialAmount < 0);
  const [payee, setPayee] = useState(txn?.payee ?? '');
  const [note, setNote] = useState(txn?.narration ?? '');
  const [date, setDate] = useState(txn?.date ?? todayISO());
  const [card, setCard] = useState(sides?.from?.account ?? localStorage.getItem('lastCard') ?? cardList[0]?.name ?? '');
  const [category, setCategory] = useState(sides?.to?.account ?? '');
  const [touchedCategory, setTouchedCategory] = useState(!!txn);
  const [error, setError] = useState('');

  const payees = useMemo(
    () => [...new Set(sortedTransactions(ledger).map((t) => t.payee).filter(Boolean))].slice(0, 200),
    [ledger],
  );

  const recentCats = useMemo(() => {
    const seen: string[] = [];
    for (const t of sortedTransactions(ledger)) {
      for (const p of t.postings) if (isCategory(p.account) && !seen.includes(p.account)) seen.push(p.account);
      if (seen.length >= 6) break;
    }
    return seen;
  }, [ledger]);

  function onPayee(v: string) {
    setPayee(v);
    if (!touchedCategory) {
      const u = lastUse(ledger, v);
      if (u.category) setCategory(u.category);
      if (u.card && !txn) setCard(u.card);
    }
  }

  function save() {
    const cents = parseCents(amount);
    if (cents === null || cents === 0) return setError('Enter an amount.');
    if (cents < 0) return setError('Use the Refund switch instead of a negative amount.');
    if (!payee.trim()) return setError('Enter where you spent it.');
    if (!category) return setError('Pick a category.');
    if (!card) return setError('Pick a card.');
    if (!isValidDate(date)) return setError('Pick a valid date.');
    const signed = refund ? -cents : cents;
    localStorage.setItem('lastCard', card);
    onSave({
      id: txn?.id ?? newId(),
      date,
      flag: '*', // saving from the editor counts as reviewed
      payee: payee.trim(),
      narration: note.trim(),
      postings: [
        { account: category, amount: signed },
        { account: card, amount: -signed },
      ],
      tags: txn?.tags ?? [],
      source: txn?.source ?? 'manual',
      externalId: txn?.externalId,
    });
  }

  if (!simple && txn) {
    return (
      <Sheet title="Transaction" onClose={onClose}>
        <div className="stack">
          <p className="muted small">This transaction has several parts (split). Splits can be viewed here and edited in the Beancount file.</p>
          <div className="list">
            {txn.postings.map((p, i) => (
              <div className="row" key={i}>
                <span className="grow">{accountLabel(ledger, p.account)}</span>
                <span className="amt">{centsToDecimal(p.amount)}</span>
              </div>
            ))}
          </div>
          {onDelete && <button className="btn danger block" onClick={() => onDelete(txn.id)}>Delete</button>}
        </div>
      </Sheet>
    );
  }

  const groups = new Map<string, typeof catList>();
  for (const c of catList) {
    const g = categoryGroup(c.name);
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }

  return (
    <Sheet title={txn ? 'Edit' : 'New spending'} onClose={onClose}
      action={<button className="btn link" onClick={save}><strong>Save</strong></button>}>
      <div className="stack">
        {txn?.flag === '!' && <div className="notice">Imported — check the details and tap Save to mark it reviewed.</div>}
        <input className="input amount-input" inputMode="decimal" placeholder="$0.00" autoFocus={!txn}
          value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" />
        <div className="seg">
          <button className={!refund ? 'on' : ''} onClick={() => setRefund(false)}>Purchase</button>
          <button className={refund ? 'on' : ''} onClick={() => setRefund(true)}>Refund</button>
        </div>

        <label className="field">
          <span>Where</span>
          <input className="input" list="payees" autoCapitalize="words" value={payee} onChange={(e) => onPayee(e.target.value)} placeholder="Trader Joe’s" />
          <datalist id="payees">{payees.map((p) => <option key={p} value={p} />)}</datalist>
        </label>

        <div className="field">
          <span>Category</span>
          {recentCats.length > 0 && (
            <div className="chips">
              {recentCats.map((c) => (
                <button key={c} className={`chip ${category === c ? 'on' : ''}`}
                  onClick={() => { setCategory(c); setTouchedCategory(true); }}>
                  {accountLabel(ledger, c)}
                </button>
              ))}
            </div>
          )}
          <select className="input" value={category} onChange={(e) => { setCategory(e.target.value); setTouchedCategory(true); }}>
            <option value="">Choose a category…</option>
            {[...groups].map(([g, list]) => (
              <optgroup key={g} label={g}>
                {list.map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
              </optgroup>
            ))}
            <optgroup label="Transfers">
              {transferAccounts(ledger).map((c) => <option key={c.name} value={c.name}>Card payment from {c.label}</option>)}
            </optgroup>
          </select>
        </div>

        <div className="field">
          <span>Card</span>
          <div className="seg">
            {cardList.map((c) => (
              <button key={c.name} className={card === c.name ? 'on' : ''} onClick={() => setCard(c.name)}>{c.label}</button>
            ))}
          </div>
        </div>

        <label className="field">
          <span>Date</span>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>

        <label className="field">
          <span>Note (optional)</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        {error && <p className="error">{error}</p>}
        <button className="btn primary block" onClick={save}>Save</button>
        {txn && onDelete && (
          <button className="btn danger block" onClick={async () => {
            if (await ask({ title: 'Delete this transaction?', message: `${txn.payee} on ${txn.date}`, confirmLabel: 'Delete', danger: true })) {
              onDelete(txn.id);
            }
          }}>Delete</button>
        )}
      </div>
    </Sheet>
  );
}
