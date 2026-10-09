import { useMemo, useState } from 'react';
import { adjustToBank, cardBalances, type CardBalance } from '../lib/balances';
import { allPending } from '../lib/importer';
import { budgetReport, categorySpending, entryFor, spendingByPerson, type BudgetRow } from '../lib/budget';
import { addMonths, monthLabel, monthOf, todayISO } from '../lib/dates';
import {
  SHARED, accountLabel, isCard, ownerMap, setBudget, sortedTransactions, txnOwner, txnSides,
  type BudgetMode, type Ledger, type Transaction,
} from '../lib/ledger';
import { centsToDecimal, formatUSD, parseCents } from '../lib/money';
import { Icon, Sheet, categories } from './common';
import { useConfirm } from './confirm';

export function Home({ ledger, month, setMonth, onChange, reviewCount, onReview, person, setPerson, onOpenSettings, onOpenTxn }: {
  ledger: Ledger;
  month: string;
  setMonth: (m: string) => void;
  onChange: (l: Ledger) => void;
  reviewCount: number;
  onReview: () => void;
  person: string | null;
  setPerson: (p: string | null) => void;
  onOpenSettings: () => void;
  onOpenTxn: (t: Transaction) => void;
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  const [viewingCard, setViewingCard] = useState<string | null>(null);
  const balances = useMemo(() => cardBalances(ledger), [ledger]);
  const report = useMemo(() => budgetReport(ledger, month), [ledger, month]);
  const byPerson = useMemo(() => spendingByPerson(ledger, month), [ledger, month]);
  const people = ledger.people ?? [];
  const hasShared = ledger.accounts.some((a) => isCard(a.name) && a.owner === SHARED);
  const views = [...people, ...(hasShared ? [SHARED] : [])];
  const current = person && views.includes(person) ? person : null;
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

      {views.length > 0 && (
        <div className="seg" role="tablist" aria-label="Whose spending">
          <button role="tab" aria-selected={!current} className={!current ? 'on' : ''} onClick={() => setPerson(null)}>Family</button>
          {views.map((p) => (
            <button key={p} role="tab" aria-selected={current === p} className={current === p ? 'on' : ''} onClick={() => setPerson(p)}>{p}</button>
          ))}
        </div>
      )}

      {reviewCount > 0 && (
        <button className="card spread" onClick={onReview}>
          <span><strong>{reviewCount}</strong> new transaction{reviewCount === 1 ? '' : 's'} to review</span>
          <span className="badge review">Review</span>
        </button>
      )}

      {current ? <PersonView ledger={ledger} month={month} person={current} total={byPerson.get(current) ?? 0}
        familyTotal={report.totalSpent} onPick={setViewing} /> : (<>
      <div className="card stack">
        <div className="spread">
          <div>
            <p className="muted small">Spent</p>
            <p className="big-number">{formatUSD(report.totalSpent)}</p>
            {pendingTotal(ledger) !== 0 && <p className="tiny muted">+ {formatUSD(pendingTotal(ledger))} pending</p>}
          </div>
          {report.rows.length > 0 && (
            <div className="right">
              <p className="muted small">Left in budgets</p>
              <p className={`mid-number ${left < 0 ? 'bad' : ''}`}>{formatUSD(left)}</p>
            </div>
          )}
        </div>
      </div>

      <ByPerson ledger={ledger} byPerson={byPerson} views={views} total={report.totalSpent}
        onPick={setPerson} onOpenSettings={onOpenSettings} />

      <CardsSection ledger={ledger} balances={balances} onPick={setViewingCard} />

      <div className="section-head">
        <h3>Budgets</h3>
        <button className="btn link small-link" onClick={() => setEditing({})}>+ Add budget</button>
      </div>
      {report.rows.length === 0 ? (
        <div className="card muted small">
          No budgets yet. Add one for a category like Groceries or Dining to see how much is left each month.
        </div>
      ) : (
        <div className="list">
          {report.rows.map((r) => <BudgetLine key={r.account} ledger={ledger} row={r} onClick={() => setViewing(r.account)} />)}
        </div>
      )}

      {report.unbudgeted.length > 0 && (
        <>
          <h3>Other spending</h3>
          <div className="list">
            {report.unbudgeted.map((u) => (
              <button className="row" key={u.account} onClick={() => setViewing(u.account)}>
                <span className="grow title">{accountLabel(ledger, u.account)}</span>
                <span className="amt">{formatUSD(u.spent)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      </>)}

      {viewingCard && balances.find((b) => b.account.name === viewingCard) && (
        <CardBalanceSheet ledger={ledger} card={balances.find((b) => b.account.name === viewingCard)!}
          onClose={() => setViewingCard(null)}
          onOpenTxn={(t) => { setViewingCard(null); onOpenTxn(t); }}
          onAdjust={(c) => { onChange(adjustToBank(ledger, c)); setViewingCard(null); }} />
      )}

      {viewing && (
        <CategorySheet ledger={ledger} account={viewing} month={month} person={current}
          onClose={() => setViewing(null)}
          onOpenTxn={(t) => { setViewing(null); onOpenTxn(t); }}
          onEditBudget={() => { setEditing({ account: viewing }); setViewing(null); }} />
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
    <Sheet title={existing ? 'Edit budget' : 'New budget'} onClose={onClose}>
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

function ByPerson({ ledger, byPerson, views, total, onPick, onOpenSettings }: {
  ledger: Ledger;
  byPerson: Map<string, number>;
  views: string[];
  total: number;
  onPick: (p: string) => void;
  onOpenSettings: () => void;
}) {
  if (!views.length) {
    return (
      <button className="card spread" onClick={onOpenSettings}>
        <span className="small">See each person’s spending: add your names and pick whose card is whose.</span>
        <span className="badge">Set up</span>
      </button>
    );
  }
  const unassigned = byPerson.get('') ?? 0;
  const cardsWithoutOwner = ledger.accounts.filter((a) => isCard(a.name) && !a.closed && !a.owner).length;
  return (
    <>
      <h3>By person</h3>
      <div className="list">
        {views.map((p) => {
          const amt = byPerson.get(p) ?? 0;
          const pct = total > 0 ? Math.max(0, Math.min(100, (amt / total) * 100)) : 0;
          return (
            <button className="row" key={p} onClick={() => onPick(p)}>
              <div className="grow stack" style={{ gap: 6 }}>
                <div className="spread">
                  <span className="title">{p}</span>
                  <span className="amt">{formatUSD(amt)}</span>
                </div>
                <div className="bar person"><div style={{ width: `${pct}%` }} /></div>
              </div>
            </button>
          );
        })}
        {(unassigned !== 0 || cardsWithoutOwner > 0) && (
          <button className="row" onClick={onOpenSettings}>
            <span className="grow small muted">
              {unassigned !== 0 ? `${formatUSD(unassigned)} on cards without an owner. ` : ''}
              {cardsWithoutOwner > 0 ? `${cardsWithoutOwner} card${cardsWithoutOwner === 1 ? '' : 's'} need an owner.` : ''}
            </span>
            <span className="badge">Assign</span>
          </button>
        )}
      </div>
    </>
  );
}

function PersonView({ ledger, month, person, total, familyTotal, onPick }: {
  ledger: Ledger;
  month: string;
  person: string;
  total: number;
  familyTotal: number;
  onPick: (account: string) => void;
}) {
  const cats = categorySpending(ledger, month, person);
  const max = Math.max(1, ...cats.map((c) => c.spent));
  const cardNames = ledger.accounts.filter((a) => isCard(a.name) && a.owner === person).map((a) => a.label);
  return (
    <>
      <div className="card stack">
        <div className="spread">
          <div>
            <p className="muted small">{person === SHARED ? 'Shared cards spent' : `${person} spent`}</p>
            <p className="big-number">{formatUSD(total)}</p>
            {pendingTotal(ledger, undefined, person) !== 0 && <p className="tiny muted">+ {formatUSD(pendingTotal(ledger, undefined, person))} pending</p>}
          </div>
          {familyTotal > 0 && (
            <div className="right">
              <p className="muted small">Share of family</p>
              <p className="mid-number">{Math.round((total / familyTotal) * 100)}%</p>
            </div>
          )}
        </div>
        <p className="tiny muted">{cardNames.length ? `Cards: ${cardNames.join(', ')}` : 'No cards assigned yet (Settings → Cards).'}</p>
      </div>
      <h3>By category</h3>
      {cats.length === 0 ? (
        <div className="card muted small">No spending this month.</div>
      ) : (
        <div className="list">
          {cats.map((c) => (
            <button className="row" key={c.account} onClick={() => onPick(c.account)}>
              <div className="grow stack" style={{ gap: 6 }}>
                <div className="spread">
                  <span className="title">{accountLabel(ledger, c.account)}</span>
                  <span className="amt">{formatUSD(c.spent)}</span>
                </div>
                <div className="bar person"><div style={{ width: `${Math.max(0, (c.spent / max) * 100)}%` }} /></div>
              </div>
            </button>
          ))}
        </div>
      )}
      <p className="tiny muted">Budgets are for the whole family. Switch to Family to see them.</p>
    </>
  );
}

/** The transactions behind one category's total for the month (and person, if one is selected). */
function CategorySheet({ ledger, account, month, person, onClose, onOpenTxn, onEditBudget }: {
  ledger: Ledger;
  account: string;
  month: string;
  person: string | null;
  onClose: () => void;
  onOpenTxn: (t: Transaction) => void;
  onEditBudget: () => void;
}) {
  const owners = ownerMap(ledger);
  const inCategory = (a: string) => a === account || a.startsWith(account + ':');
  const rows = sortedTransactions(ledger)
    .filter((t) => t.date.startsWith(month) && (!person || txnOwner(ledger, t, owners) === person))
    .map((t) => ({ t, amount: t.postings.filter((p) => inCategory(p.account)).reduce((s, p) => s + p.amount, 0) }))
    .filter((r) => r.amount !== 0);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const hasBudget = ledger.budgets.some((b) => b.account === account);

  return (
    <Sheet title={accountLabel(ledger, account)} onClose={onClose}>
      <div className="stack">
        <div className="spread">
          <span className="muted small">{monthLabel(month)}{person ? ` · ${person}` : ''}</span>
          <span className="amt"><strong>{formatUSD(total)}</strong></span>
        </div>
        {rows.length === 0 ? (
          <div className="card muted small">No transactions in this category this month.</div>
        ) : (
          <div className="list">
            {rows.map(({ t, amount }) => {
              const { from } = txnSides(t);
              const card = from ? ledger.accounts.find((a) => a.name === from.account) : undefined;
              return (
                <button className="row" key={t.id} onClick={() => onOpenTxn(t)}>
                  <div className="grow">
                    <div className="title">
                      {t.flag === '!' && <span className="new-dot on inline" aria-label="Needs review" />}{t.payee || t.narration || '(no payee)'}
                    </div>
                    <div className="tiny muted title">
                      {new Date(`${t.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {card ? ` · ${card.label}` : ''}{card?.owner && !person ? ` · ${card.owner}` : ''}
                    </div>
                  </div>
                  <span className={`amt ${amount < 0 ? 'good' : ''}`}>{amount < 0 ? `+${formatUSD(-amount)}` : formatUSD(amount)}</span>
                </button>
              );
            })}
          </div>
        )}
        {!person && (
          <button className="btn block" onClick={onEditBudget}>{hasBudget ? 'Edit budget' : 'Set a monthly budget'}</button>
        )}
      </div>
    </Sheet>
  );
}

function pendingTotal(ledger: Ledger, card?: string, person?: string): number {
  const owners = ownerMap(ledger);
  return allPending(ledger)
    .filter((p) => (!card || p.card === card) && (!person || owners.get(p.card) === person))
    .reduce((s, p) => s + p.amount, 0);
}

function shortDate(d: string): string {
  return new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function statusLine(c: CardBalance): { text: string; cls: string } {
  if (!c.bank) return { text: 'No bank balance yet', cls: 'muted' };
  if (c.bank.status === 'match') return { text: '✓ Matches bank', cls: 'good' };
  if (c.bank.status === 'pending') return { text: `Matches once ${formatUSD(c.bank.pending)} pending posts`, cls: 'muted' };
  return { text: `⚠ Off by ${formatUSD(Math.abs(c.bank.difference))}`, cls: 'bad' };
}

function CardsSection({ ledger, balances, onPick }: { ledger: Ledger; balances: CardBalance[]; onPick: (account: string) => void }) {
  if (!balances.length) return null;
  const pendingByCard: Record<string, number> = {};
  for (const p of allPending(ledger)) pendingByCard[p.card] = (pendingByCard[p.card] ?? 0) + p.amount;
  const total = balances.reduce((s, c) => s + c.owed, 0);
  return (
    <>
      <div className="section-head">
        <h3>Cards</h3>
        <span className="small muted">You owe {formatUSD(total)}</span>
      </div>
      <div className="list">
        {balances.map((c) => {
          const st = statusLine(c);
          return (
            <button className="row" key={c.account.name} onClick={() => onPick(c.account.name)}>
              <div className="grow">
                <div className="title">{c.account.label}{c.account.owner ? <span className="tiny muted"> · {c.account.owner}</span> : null}</div>
                <div className={`tiny ${st.cls}`}>{st.text}</div>
                <div className="tiny muted">
                  {c.bank ? `Bank data as of ${shortDate(c.bank.asOf)}` : ''}
                  {pendingByCard[c.account.name] ? `${c.bank ? ' · ' : ''}${formatUSD(pendingByCard[c.account.name])} pending` : ''}
                </div>
              </div>
              <span className="amt">{formatUSD(c.owed)}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function CardBalanceSheet({ ledger, card, onClose, onOpenTxn, onAdjust }: {
  ledger: Ledger;
  card: CardBalance;
  onClose: () => void;
  onOpenTxn: (t: Transaction) => void;
  onAdjust: (c: CardBalance) => void;
}) {
  const ask = useConfirm();
  const recent = sortedTransactions(ledger).filter((t) => t.postings.some((p) => p.account === card.account.name)).slice(0, 15);
  const b = card.bank;
  const asOf = b ? new Date(`${b.asOf}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  return (
    <Sheet title={card.account.label} onClose={onClose}>
      <div className="stack">
        <div className="card stack">
          <div className="spread"><span className="muted small">You owe (this app)</span><span className="amt"><strong>{formatUSD(card.owed)}</strong></span></div>
          {b ? (
            <>
              <div className="spread"><span className="muted small">Bank data as of</span><span className="small">{asOf}</span></div>
              <div className="spread"><span className="muted small">This app on {asOf}</span><span className="amt">{formatUSD(b.ledgerOwed)}</span></div>
              <div className="spread"><span className="muted small">Bank says on {asOf}</span><span className="amt">{formatUSD(b.owed)}</span></div>
              {b.pending !== 0 && <div className="spread"><span className="muted small">Pending at the bank</span><span className="amt">{formatUSD(b.pending)}</span></div>}
              <div className="spread"><span className="small">Check</span><span className={`small ${statusLine(card).cls}`}>{statusLine(card).text}</span></div>
            </>
          ) : (
            <p className="tiny muted">The bank’s balance arrives with the next daily import.</p>
          )}
        </div>
        {b?.status === 'mismatch' && (
          <>
            <p className="small">
              {b.difference > 0 ? 'The bank says you owe more than this app shows: a purchase may be missing, or a refund was entered twice.'
                : 'This app shows more than the bank: a purchase may be duplicated, or a refund or payment is missing.'}
              {' '}Check the list below first. If everything looks right, you can book the difference.
            </p>
            <button className="btn block" onClick={async () => {
              if (await ask({
                title: 'Match the bank balance?',
                message: `This adds a ${formatUSD(Math.abs(b.difference))} “Balance adjustment” on ${asOf}, so this card matches the bank. It doesn’t count as spending.`,
                confirmLabel: 'Add adjustment',
              })) onAdjust(card);
            }}>Match bank balance</button>
          </>
        )}
        {b?.status === 'pending' && (
          <p className="small muted">The bank includes charges that haven’t posted yet. They’ll be imported once they post, and the check will pass.</p>
        )}
        {(ledger.pendingCharges?.[card.account.name]?.items.length ?? 0) > 0 && (
          <>
            <h3>Pending · not posted yet</h3>
            <div className="list">
              {ledger.pendingCharges![card.account.name].items.map((p) => (
                <div className="row" key={p.id}>
                  <div className="grow">
                    <div className="title">{p.payee}</div>
                    <div className="tiny muted">{shortDate(p.date)}</div>
                  </div>
                  <span className="amt muted">{formatUSD(p.amount)}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <h3>Recent on this card</h3>
        <div className="list">
          {recent.map((t) => {
            const amt = -t.postings.filter((p) => p.account === card.account.name).reduce((s, p) => s + p.amount, 0);
            return (
              <button className="row" key={t.id} onClick={() => onOpenTxn(t)}>
                <div className="grow">
                  <div className="title">{t.payee || t.narration}</div>
                  <div className="tiny muted">{new Date(`${t.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                </div>
                <span className={`amt ${amt < 0 ? 'good' : ''}`}>{amt < 0 ? `−${formatUSD(-amt)}` : formatUSD(amt)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}
