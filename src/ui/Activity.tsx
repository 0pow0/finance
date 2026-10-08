import { useMemo, useState } from 'react';
import {
  SHARED, accountLabel, approveTransactions, isCard, ownerMap, sortedTransactions, txnAmount, txnOwner, txnSides,
  type Ledger, type Transaction,
} from '../lib/ledger';
import { formatUSD } from '../lib/money';
import { cards } from './common';

export function Activity({ ledger, onOpen, reviewOnly, setReviewOnly, onChange, toast }: {
  ledger: Ledger;
  onOpen: (t: Transaction) => void;
  reviewOnly: boolean;
  setReviewOnly: (v: boolean) => void;
  onChange: (l: Ledger) => void;
  toast: (m: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [card, setCard] = useState('');
  const [who, setWho] = useState('');
  const people = [...(ledger.people ?? []), ...(ledger.accounts.some((a) => isCard(a.name) && a.owner === SHARED) ? [SHARED] : [])];
  const [limit, setLimit] = useState(150);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const owners = ownerMap(ledger);
    return sortedTransactions(ledger).filter((t) => {
      if (reviewOnly && t.flag !== '!') return false;
      if (who && txnOwner(ledger, t, owners) !== who) return false;
      if (card && !t.postings.some((p) => p.account === card)) return false;
      if (!q) return true;
      return (
        t.payee.toLowerCase().includes(q) ||
        t.narration.toLowerCase().includes(q) ||
        t.postings.some((p) => accountLabel(ledger, p.account).toLowerCase().includes(q))
      );
    });
  }, [ledger, query, card, reviewOnly, who]);

  const days = new Map<string, Transaction[]>();
  for (const t of filtered.slice(0, limit)) days.set(t.date, [...(days.get(t.date) ?? []), t]);

  return (
    <div className="stack">
      <h1>Activity</h1>
      <input className="input search" type="search" placeholder="Search payee, note, category" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="chips">
        <button className={`chip ${!card && !reviewOnly && !who ? 'on' : ''}`} onClick={() => { setCard(''); setWho(''); setReviewOnly(false); }}>All</button>
        {people.map((p) => (
          <button key={p} className={`chip ${who === p ? 'on' : ''}`} onClick={() => setWho(who === p ? '' : p)}>{p}</button>
        ))}
        {cards(ledger).map((c) => (
          <button key={c.name} className={`chip ${card === c.name ? 'on' : ''}`} onClick={() => setCard(card === c.name ? '' : c.name)}>{c.label}</button>
        ))}
        <button className={`chip ${reviewOnly ? 'on' : ''}`} onClick={() => setReviewOnly(!reviewOnly)}>To review</button>
      </div>

      {reviewOnly && filtered.length > 0 && (
        <div className="card spread">
          <span className="small">Check the categories, tap any to fix, then approve.</span>
          <button className="btn primary" onClick={() => {
            onChange(approveTransactions(ledger, new Set(filtered.map((t) => t.id))));
            toast(`Approved ${filtered.length}`);
            setReviewOnly(false);
          }}>Approve {filtered.length}</button>
        </div>
      )}

      {filtered.length === 0 && (
        <div className="card muted small">
          {ledger.transactions.length === 0 ? 'No spending yet. Tap + to add your first purchase.' : 'Nothing matches.'}
        </div>
      )}

      {[...days].map(([day, txns]) => (
        <div key={day}>
          <div className="day-head">
            <span>{new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            <span>{formatUSD(txns.reduce((s, t) => s + txnAmount(t), 0))}</span>
          </div>
          <div className="list">
            {txns.map((t) => {
              const { from, to } = txnSides(t);
              const amt = txnAmount(t);
              return (
                <button className="row" key={t.id} onClick={() => onOpen(t)}>
                  <div className="grow">
                    <div className="title">
                      {t.payee || t.narration || '(no payee)'} {t.flag === '!' && <span className="badge review">Review</span>}
                    </div>
                    <div className="tiny muted title">
                      {to ? accountLabel(ledger, to.account) : ''}{from ? ` · ${accountLabel(ledger, from.account)}` : ''}
                      {t.narration && t.payee ? ` · ${t.narration}` : ''}
                    </div>
                  </div>
                  <span className={`amt ${amt < 0 ? 'good' : ''}`}>{amt < 0 ? `+${formatUSD(-amt)}` : formatUSD(amt)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {filtered.length > limit && <button className="btn block" onClick={() => setLimit(limit + 200)}>Show more</button>}
    </div>
  );
}
