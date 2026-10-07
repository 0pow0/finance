import { useMemo, useState } from 'react';
import { budgetReport, entryFor, type BudgetRow } from '../lib/budget';
import { addMonths, monthLabel, monthOf, todayISO } from '../lib/dates';
import { accountLabel, setBudget, type BudgetMode, type Ledger } from '../lib/ledger';
import { centsToDecimal, formatUSD, parseCents } from '../lib/money';
import { Icon, Sheet, categories } from './common';

export function Home({ ledger, month, setMonth, onChange, reviewCount, onReview }: {
  ledger: Ledger;
  month: string;
  setMonth: (m: string) => void;
  onChange: (l: Ledger) => void;
  reviewCount: number;
  onReview: () => void;
}) {
  const report = useMemo(() => budgetReport(ledger, month), [ledger, month]);
  const [editing, setEditing] = useState<{ account?: string } | null>(null);
  const thisMonth = monthOf(todayISO());
  const left = report.totalAvailable - report.rows
    .filter((r) => !report.rows.some((p) => p.account !== r.account && r.account.startsWith(p.account + ':')))
    .reduce((s, r) => s + r.spent, 0);

  return (
    <div className="stack">
      <div className="spread">
        <button className="btn link" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><Icon name="chevL" /></button>
        <h2>{monthLabel(month)}</h2>
        <button className="btn link" aria-label="Next month" disabled={month >= thisMonth} onClick={() => setMonth(addMonths(month, 1))}><Icon name="chevR" /></button>
      </div>

      {reviewCount > 0 && (
        <button className="card spread" onClick={onReview}>
          <span><strong>{reviewCount}</strong> new transaction{reviewCount === 1 ? '' : 's'} to review</span>
          <span className="badge review">Review</span>
        </button>
      )}

      <div className="card stack">
        <div className="spread">
          <div>
            <p className="muted small">Spent</p>
            <p className="big-number">{formatUSD(report.totalSpent)}</p>
          </div>
          {report.rows.length > 0 && (
            <div className="right">
              <p className="muted small">Left in budgets</p>
              <p className={`big-number ${left < 0 ? 'bad' : ''}`}>{formatUSD(left)}</p>
            </div>
          )}
        </div>
      </div>

      <div className="spread">
        <h3>Budgets</h3>
        <button className="btn link" onClick={() => setEditing({})}>+ Add budget</button>
      </div>
      {report.rows.length === 0 ? (
        <div className="card muted small">
          No budgets yet. Add one for a category like Groceries or Dining to see how much is left each month.
        </div>
      ) : (
        <div className="list">
          {report.rows.map((r) => <BudgetLine key={r.account} ledger={ledger} row={r} onClick={() => setEditing({ account: r.account })} />)}
        </div>
      )}

      {report.unbudgeted.length > 0 && (
        <>
          <h3>Other spending</h3>
          <div className="list">
            {report.unbudgeted.map((u) => (
              <button className="row" key={u.account} onClick={() => setEditing({ account: u.account })}>
                <span className="grow title">{accountLabel(ledger, u.account)}</span>
                <span className="amt">{formatUSD(u.spent)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {editing && (
        <BudgetEditor ledger={ledger} account={editing.account} month={month}
          onClose={() => setEditing(null)}
          onSave={(l) => { onChange(l); setEditing(null); }} />
      )}
    </div>
  );
}

function BudgetLine({ ledger, row, onClick }: { ledger: Ledger; row: BudgetRow; onClick: () => void }) {
  const pct = row.available > 0 ? Math.min(100, (row.spent / row.available) * 100) : row.spent > 0 ? 100 : 0;
  const state = row.remaining < 0 ? 'over' : pct >= 85 ? 'warn' : '';
  return (
    <button className="row" onClick={onClick}>
      <div className="grow stack" style={{ gap: 6 }}>
        <div className="spread">
          <span className="title">
            {accountLabel(ledger, row.account)}
            {row.mode === 'rollover' && row.carried !== 0 && (
              <span className="tiny muted"> · {row.carried > 0 ? '+' : ''}{formatUSD(row.carried)} rolled over</span>
            )}
          </span>
          <span className={`amt small ${row.remaining < 0 ? 'bad' : ''}`}>
            {row.remaining < 0 ? `${formatUSD(-row.remaining)} over` : `${formatUSD(row.remaining)} left`}
          </span>
        </div>
        <div className={`bar ${state}`}><div style={{ width: `${pct}%` }} /></div>
        <span className="tiny muted">{formatUSD(row.spent)} of {formatUSD(row.available)}</span>
      </div>
    </button>
  );
}

function BudgetEditor({ ledger, account, month, onSave, onClose }: {
  ledger: Ledger;
  account?: string;
  month: string;
  onSave: (l: Ledger) => void;
  onClose: () => void;
}) {
  const existing = account ? entryFor(ledger.budgets, account, month) : undefined;
  const [acct, setAcct] = useState(account ?? '');
  const [amount, setAmount] = useState(existing ? centsToDecimal(existing.amount) : '');
  const [mode, setMode] = useState<BudgetMode>(existing?.mode ?? 'rollover');
  const [error, setError] = useState('');
  const budgeted = new Set(ledger.budgets.map((b) => b.account));

  function save(remove = false) {
    const cents = remove ? 0 : parseCents(amount);
    if (!acct) return setError('Pick a category.');
    if (cents === null || cents < 0) return setError('Enter a monthly amount.');
    onSave(setBudget(ledger, { account: acct, from: month, amount: cents, mode: remove ? 'fixed' : mode }));
  }

  return (
    <Sheet title={existing ? 'Edit budget' : 'New budget'} onClose={onClose}
      action={<button className="btn link" onClick={() => save()}><strong>Save</strong></button>}>
      <div className="stack">
        <label className="field">
          <span>Category</span>
          <select className="input" value={acct} disabled={!!account} onChange={(e) => setAcct(e.target.value)}>
            <option value="">Choose…</option>
            {categories(ledger).map((c) => (
              <option key={c.name} value={c.name} disabled={!account && budgeted.has(c.name)}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Monthly amount</span>
          <input className="input" inputMode="decimal" placeholder="$500" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <div className="field">
          <span>When the month ends</span>
          <div className="seg">
            <button className={mode === 'rollover' ? 'on' : ''} onClick={() => setMode('rollover')}>Roll over</button>
            <button className={mode === 'fixed' ? 'on' : ''} onClick={() => setMode('fixed')}>Start fresh</button>
          </div>
          <p className="tiny muted">
            {mode === 'rollover'
              ? 'Money left over is added to next month. Overspending is taken from next month.'
              : 'Every month starts with the same amount. Leftovers don’t carry over.'}
          </p>
        </div>
        <p className="tiny muted">Applies from {monthLabel(month)} onward. Earlier months keep their old budget.</p>
        {error && <p className="error">{error}</p>}
        <button className="btn primary block" onClick={() => save()}>Save budget</button>
        {existing && existing.amount > 0 && (
          <button className="btn danger block" onClick={() => save(true)}>Stop budgeting this category</button>
        )}
      </div>
    </Sheet>
  );
}
