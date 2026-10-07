import { useMemo, useState } from 'react';
import { accountLabel, sortedTransactions, txnAmount, txnSides, type Ledger, type Transaction } from '../lib/ledger';
import { formatUSD } from '../lib/money';
import { cards } from './common';

export function Activity({ ledger, onOpen, reviewOnly, setReviewOnly }: {
  ledger: Ledger;
  onOpen: (t: Transaction) => void;
  reviewOnly: boolean;
  setReviewOnly: (v: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [card, setCard] = useState('');
  const [limit, setLimit] = useState(150);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortedTransactions(ledger).filter((t) => {
      if (reviewOnly && t.flag !== '!') return false;
      if (card && !t.postings.some((p) => p.account === card)) return false;
      if (!q) return true;
      return (
        t.payee.toLowerCase().includes(q) ||
        t.narration.toLowerCase().includes(q) ||
        t.postings.some((p) => accountLabel(ledger, p.account).toLowerCase().includes(q))
      );
    });
  }, [ledger, query, card, reviewOnly]);

  const days = new Map<string, Transaction[]>();
  for (const t of filtered.slice(0, limit)) days.set(t.date, [...(days.get(t.date) ?? []), t]);

  return (
    <div className="stack">
      <h1>Activity</h1>
      <input className="input search" type="search" placeholder="Search payee, note, category" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="chips">
        <button className={`chip ${!card && !reviewOnly ? 'on' : ''}`} onClick={() => { setCard(''); setReviewOnly(false); }}>All</button>
        {cards(ledger).map((c) => (
          <button key={c.name} className={`chip ${card === c.name ? 'on' : ''}`} onClick={() => setCard(card === c.name ? '' : c.name)}>{c.label}</button>
        ))}
        <button className={`chip ${reviewOnly ? 'on' : ''}`} onClick={() => setReviewOnly(!reviewOnly)}>To review</button>
      </div>

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
