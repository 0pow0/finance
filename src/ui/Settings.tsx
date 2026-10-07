import { useState } from 'react';
import { fromBeancount, toBeancount } from '../lib/beancount';
import { todayISO } from '../lib/dates';
import {
  addAccount, isCard, isCategory, toAccountComponent, updateAccount,
  type Account, type Ledger,
} from '../lib/ledger';
import { checkPassphrase, eraseVault, type Session } from '../lib/vault';
import { Sheet, categoryGroup, readFileText, saveFile } from './common';

type Dialog =
  | { kind: 'account'; type: 'card' | 'category'; account?: Account }
  | { kind: 'passphrase' }
  | { kind: 'reveal' };

export function Settings({ session, ledger, onChange, onReplace, onLock, onErased, autoLock, setAutoLock, toast }: {
  session: Session;
  ledger: Ledger;
  onChange: (l: Ledger) => void;
  onReplace: (l: Ledger) => void;
  onLock: () => void;
  onErased: () => void;
  autoLock: number;
  setAutoLock: (m: number) => void;
  toast: (msg: string) => void;
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const cardAccounts = ledger.accounts.filter((a) => isCard(a.name));
  const catAccounts = ledger.accounts.filter((a) => isCategory(a.name)).sort((a, b) => a.name.localeCompare(b.name));
  const lastBackup = session.lastBackupAt ? new Date(session.lastBackupAt).toLocaleDateString() : 'never';

  async function guard(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <h1>Settings</h1>

      <h3>Cards</h3>
      <div className="list">
        {cardAccounts.map((a) => (
          <button className="row" key={a.name} onClick={() => setDialog({ kind: 'account', type: 'card', account: a })}>
            <span className="grow">{a.label}</span>
            {a.closed && <span className="badge">Hidden</span>}
          </button>
        ))}
        <button className="row" onClick={() => setDialog({ kind: 'account', type: 'card' })}><span className="grow">+ Add a card</span></button>
      </div>

      <h3>Categories</h3>
      <div className="list">
        {catAccounts.map((a) => (
          <button className="row" key={a.name} onClick={() => setDialog({ kind: 'account', type: 'category', account: a })}>
            <span className="grow">{a.label}</span>
            <span className="settings-row-value">{categoryGroup(a.name)}</span>
            {a.closed && <span className="badge">Hidden</span>}
          </button>
        ))}
        <button className="row" onClick={() => setDialog({ kind: 'account', type: 'category' })}><span className="grow">+ Add a category</span></button>
      </div>

      <h3>Backup &amp; files</h3>
      <div className="list">
        <button className="row" onClick={() => guard(async () => {
          await saveFile(`household-ledger-backup-${todayISO()}.json`, await session.exportBackup(), 'application/json');
          toast('Encrypted backup saved');
        })}>
          <span className="grow">Download encrypted backup</span>
          <span className="settings-row-value">Last: {lastBackup}</span>
        </button>
        <button className="row" onClick={() => guard(async () => {
          const text = await readFileText('.json,application/json');
          if (!text) return;
          const restored = await session.readBackup(text);
          if (confirm(`Replace everything on this phone with the backup (${restored.transactions.length} transactions)?`)) {
            onReplace(restored);
            toast('Backup restored');
          }
        })}>
          <span className="grow">Restore from backup…</span>
        </button>
        <button className="row" onClick={() => guard(async () => {
          if (!confirm('The Beancount file is NOT encrypted. Only save it somewhere private (not a shared or cloud folder). Continue?')) return;
          await saveFile(`household-${todayISO()}.beancount`, toBeancount(ledger), 'text/plain');
        })}>
          <span className="grow">Export Beancount file</span>
          <span className="settings-row-value">unencrypted</span>
        </button>
        <button className="row" onClick={() => guard(async () => {
          const text = await readFileText('.beancount,.bean,.txt,text/plain');
          if (!text) return;
          const imported = fromBeancount(text);
          if (confirm(`Replace everything on this phone with this file (${imported.transactions.length} transactions, ${imported.budgets.length} budgets)?`)) {
            onReplace(imported);
            toast('Beancount file imported');
          }
        })}>
          <span className="grow">Import Beancount file…</span>
        </button>
      </div>

      <h3>Security</h3>
      <div className="list">
        <div className="row">
          <span className="grow">Auto-lock</span>
          <select className="input" style={{ width: 'auto', minHeight: 36 }} value={autoLock} onChange={(e) => setAutoLock(Number(e.target.value))}>
            <option value={1}>1 minute</option>
            <option value={5}>5 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={60}>1 hour</option>
          </select>
        </div>
        <button className="row" onClick={() => setDialog({ kind: 'passphrase' })}><span className="grow">Change passphrase</span></button>
        <button className="row" onClick={() => setDialog({ kind: 'reveal' })}><span className="grow">Show household key</span></button>
        <button className="row" onClick={onLock}><span className="grow">Lock now</span></button>
      </div>

      <div className="notice small">
        Your ledger is encrypted on this phone (AES-256). Backups are encrypted with your household key and can be
        stored anywhere — they can’t be read without it.
      </div>

      <button className="btn danger block" onClick={async () => {
        if (prompt('This permanently deletes the ledger on this phone. Make sure you have a backup and your household key. Type DELETE to confirm.') === 'DELETE') {
          await eraseVault();
          onErased();
        }
      }}>Erase this phone’s ledger</button>
      <p className="tiny muted">Household Ledger v{__APP_VERSION__} · key {session.keyId.slice(0, 8)}</p>

      {dialog?.kind === 'account' && (
        <AccountSheet ledger={ledger} type={dialog.type} account={dialog.account} onClose={() => setDialog(null)}
          onSave={(l) => { onChange(l); setDialog(null); }} />
      )}
      {dialog?.kind === 'passphrase' && <PassphraseSheet session={session} onClose={() => setDialog(null)} toast={toast} />}
      {dialog?.kind === 'reveal' && <RevealSheet session={session} onClose={() => setDialog(null)} />}
    </div>
  );
}

function AccountSheet({ ledger, type, account, onSave, onClose }: {
  ledger: Ledger;
  type: 'card' | 'category';
  account?: Account;
  onSave: (l: Ledger) => void;
  onClose: () => void;
}) {
  const groups = [...new Set(ledger.accounts.filter((a) => isCategory(a.name) && a.name.split(':').length > 2)
    .map((a) => a.name.split(':')[1]))].sort();
  const [label, setLabel] = useState(account?.label ?? '');
  const [group, setGroup] = useState('');
  const [error, setError] = useState('');

  function save() {
    const name = label.trim();
    if (!name) return setError('Enter a name.');
    try {
      if (account) return onSave(updateAccount(ledger, account.name, { label: name }));
      const component = toAccountComponent(name);
      const full = type === 'card'
        ? `Liabilities:CreditCard:${component}`
        : `Expenses:${group ? `${group}:` : ''}${component}`;
      onSave(addAccount(ledger, full, name, todayISO()));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Sheet title={account ? 'Edit' : type === 'card' ? 'New card' : 'New category'} onClose={onClose}
      action={<button className="btn link" onClick={save}><strong>Save</strong></button>}>
      <div className="stack">
        <label className="field">
          <span>Name</span>
          <input className="input" autoFocus value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder={type === 'card' ? 'Amex Gold' : 'Pet supplies'} />
        </label>
        {!account && type === 'category' && (
          <label className="field">
            <span>Group</span>
            <select className="input" value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">None</option>
              {groups.map((g) => <option key={g} value={g}>{g.replace(/-/g, ' ')}</option>)}
            </select>
          </label>
        )}
        {account && <p className="tiny muted">Beancount account: {account.name}</p>}
        {error && <p className="error">{error}</p>}
        <button className="btn primary block" onClick={save}>Save</button>
        {account && (
          <button className="btn block" onClick={() => onSave(updateAccount(ledger, account.name, { closed: !account.closed }))}>
            {account.closed ? 'Show in pickers again' : 'Hide from pickers'}
          </button>
        )}
      </div>
    </Sheet>
  );
}

function PassphraseSheet({ session, onClose, toast }: { session: Session; onClose: () => void; toast: (m: string) => void }) {
  const [oldP, setOldP] = useState('');
  const [newP, setNewP] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const check = newP ? checkPassphrase(newP) : null;
  return (
    <Sheet title="Change passphrase" onClose={onClose}>
      <div className="stack">
        <label className="field"><span>Current passphrase</span>
          <input className="input" type="password" autoComplete="current-password" value={oldP} onChange={(e) => setOldP(e.target.value)} />
        </label>
        <label className="field"><span>New passphrase</span>
          <input className="input" type="password" autoComplete="new-password" value={newP} onChange={(e) => setNewP(e.target.value)} />
        </label>
        {(check || error) && <p className="error">{check ?? error}</p>}
        <button className="btn primary block" disabled={busy || !oldP || !newP || !!check} onClick={async () => {
          setBusy(true);
          try {
            await session.changePassphrase(oldP, newP);
            toast('Passphrase changed');
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}>Change</button>
      </div>
    </Sheet>
  );
}

function RevealSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const [pass, setPass] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  return (
    <Sheet title="Household key" onClose={onClose}>
      <div className="stack">
        {key ? (
          <>
            <div className="recovery">{key}</div>
            <p className="small muted">Use this to set up the other phone. Keep it private.</p>
          </>
        ) : (
          <>
            <label className="field"><span>Enter your passphrase to show the key</span>
              <input className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="btn primary block" disabled={!pass} onClick={async () => {
              try {
                setKey(await session.revealRecoveryKey(pass));
              } catch (e) {
                setError((e as Error).message);
              }
            }}>Show</button>
          </>
        )}
      </div>
    </Sheet>
  );
}
