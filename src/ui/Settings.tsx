import { useState } from 'react';
import { fromBeancount, toBeancount } from '../lib/beancount';
import { todayISO } from '../lib/dates';
import {
  SHARED, addAccount, deleteAccounts, isAccountUsed, isCard, isCategory, removePerson, renamePerson, setPeople, startOver, toAccountComponent, updateAccount,
  type Account, type Ledger,
} from '../lib/ledger';
import { checkPassphrase, eraseVault, type Session } from '../lib/vault';
import { Sheet, categoryGroup, readFileText, saveFile } from './common';
import { useConfirm } from './confirm';
import { createPasskey, describePasskeyError, passkeySecret } from '../lib/passkey';
import { describeStatus, timeAgo, type SyncControls } from './useSync';
import { importedCount, removeUnreviewedImports } from '../lib/importer';

type Dialog =
  | { kind: 'account'; type: 'card' | 'category'; account?: Account }
  | { kind: 'passphrase' }
  | { kind: 'reveal' }
  | { kind: 'sync' }
  | { kind: 'person'; name?: string }
  | { kind: 'faceid' }
  | { kind: 'bank'; id: string };

export function Settings({ session, ledger, onChange, onReplace, onLock, onErased, autoLock, setAutoLock, toast, sync }: {
  session: Session;
  sync: SyncControls;
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
  const ask = useConfirm();
  const [showHidden, setShowHidden] = useState(false);
  const [, setFaceIdTick] = useState(0); // re-render after Face ID changes
  const cardAccounts = ledger.accounts.filter((a) => isCard(a.name) && !a.deleted);
  const activeCards = cardAccounts.filter((a) => !a.closed);
  const hiddenCards = cardAccounts.filter((a) => a.closed);
  const unusedOwnerless = activeCards.filter((a) => !a.owner && !isAccountUsed(ledger, a.name));
  const catAccounts = ledger.accounts.filter((a) => isCategory(a.name) && !a.deleted).sort((a, b) => a.name.localeCompare(b.name));
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

      <h3>Sync between phones</h3>
      <div className="list">
        {sync.device?.sync ? (
          <>
            <div className="row">
              <span className={`status-dot ${sync.status.state}`} />
              <span className="grow small">{describeStatus(sync.status)}</span>
              <button className="btn" disabled={sync.status.state === 'syncing'} onClick={() => void sync.syncNow()}>Sync now</button>
            </div>
            <button className="row" onClick={() => setDialog({ kind: 'sync' })}>
              <span className="grow">Data repo</span>
              <span className="settings-row-value">{sync.device.sync.repo}</span>
            </button>
          </>
        ) : (
          <button className="row" onClick={() => setDialog({ kind: 'sync' })}>
            <span className="grow">Set up sync</span>
            <span className="settings-row-value">Off</span>
          </button>
        )}
      </div>

      <h3>Bank import</h3>
      <div className="list">
        <div className="row">
          <span className="grow small">
            {ledger.lastImportAt
              ? `Last bank import ${timeAgo(ledger.lastImportAt)}`
              : sync.device?.sync
                ? 'Waiting for the first daily import from SimpleFIN.'
                : 'Bank import arrives through sync. Set up sync first.'}
          </span>
        </div>
        {Object.entries(ledger.importAccounts ?? {})
          .filter(([id]) => !ledger.lastImportAccounts || ledger.lastImportAccounts.includes(id))
          .map(([id, a]) => (
          <button className="row" key={id} onClick={() => setDialog({ kind: 'bank', id })}>
            <span className="grow">
              <span className="title">{a.name}</span>
              <span className="tiny muted"> · {a.org}</span>
            </span>
            <span className="settings-row-value">
              {a.account ? ledger.accounts.find((x) => x.name === a.account)?.label ?? a.account : 'Not imported'}
            </span>
          </button>
        ))}
      </div>

      <h3>People</h3>
      <div className="list">
        {(ledger.people ?? []).map((p) => (
          <button className="row" key={p} onClick={() => setDialog({ kind: 'person', name: p })}>
            <span className="grow">{p}</span>
            <span className="settings-row-value">
              {cardAccounts.filter((a) => a.owner === p).length} card{cardAccounts.filter((a) => a.owner === p).length === 1 ? '' : 's'}
            </span>
          </button>
        ))}
        <button className="row" onClick={() => setDialog({ kind: 'person' })}><span className="grow">+ Add a person</span></button>
      </div>

      <h3>Cards</h3>
      <div className="list">
        {(showHidden ? cardAccounts : activeCards).map((a) => (
          <button className="row" key={a.name} onClick={() => setDialog({ kind: 'account', type: 'card', account: a })}>
            <span className="grow">{a.label}</span>
            <span className="settings-row-value">{a.owner ?? (ledger.people?.length ? 'No owner' : '')}</span>
            {a.closed && <span className="badge">Hidden</span>}
          </button>
        ))}
        <button className="row" onClick={() => setDialog({ kind: 'account', type: 'card' })}><span className="grow">+ Add a card</span></button>
        {hiddenCards.length > 0 && (
          <button className="row" onClick={() => setShowHidden(!showHidden)}>
            <span className="grow small muted">{showHidden ? 'Hide' : 'Show'} {hiddenCards.length} hidden card{hiddenCards.length === 1 ? '' : 's'}</span>
          </button>
        )}
      </div>
      {unusedOwnerless.length > 0 && (
        <button className="btn block" onClick={async () => {
          if (await ask({
            title: `Remove ${unusedOwnerless.length} unused card${unusedOwnerless.length === 1 ? '' : 's'}?`,
            message: `${unusedOwnerless.map((a) => a.label).join(', ')}. These have no owner, no transactions and no bank connection.`,
            confirmLabel: 'Remove', danger: true,
          })) {
            onChange(deleteAccounts(ledger, unusedOwnerless.map((a) => a.name)));
            toast('Removed');
          }
        }}>Remove {unusedOwnerless.length} unused card{unusedOwnerless.length === 1 ? '' : 's'} without an owner</button>
      )}

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
          if (await ask({
            title: 'Restore backup?',
            message: `This replaces everything on this phone with the backup (${restored.transactions.length} transactions).`,
            confirmLabel: 'Replace with backup', danger: true,
          })) {
            onReplace(restored);
            toast('Backup restored');
          }
        })}>
          <span className="grow">Restore from backup…</span>
        </button>
        <button className="row" onClick={() => guard(async () => {
          if (!(await ask({
            title: 'Export unencrypted file?',
            message: 'The Beancount file is not encrypted. Only save it somewhere private, not in a shared or cloud folder.',
            confirmLabel: 'Export',
          }))) return;
          await saveFile(`household-${todayISO()}.beancount`, toBeancount(ledger), 'text/plain');
        })}>
          <span className="grow">Export Beancount file</span>
          <span className="settings-row-value">unencrypted</span>
        </button>
        <button className="row" onClick={() => guard(async () => {
          const text = await readFileText('.beancount,.bean,.txt,text/plain');
          if (!text) return;
          const imported = fromBeancount(text);
          if (await ask({
            title: 'Import Beancount file?',
            message: `This replaces everything on this phone with the file (${imported.transactions.length} transactions, ${imported.budgets.length} budgets).`,
            confirmLabel: 'Replace with file', danger: true,
          })) {
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
        <button className="row" onClick={async () => {
          if (!session.hasPasskey) return setDialog({ kind: 'faceid' });
          if (await ask({ title: 'Turn off Face ID?', message: 'You’ll unlock with your passphrase on this phone.', confirmLabel: 'Turn off' })) {
            await session.disablePasskey();
            toast('Face ID turned off');
            setFaceIdTick((n) => n + 1);
          }
        }}>
          <span className="grow">Unlock with Face ID</span>
          <span className="settings-row-value">{session.hasPasskey ? 'On' : 'Off'}</span>
        </button>
        <button className="row" onClick={() => setDialog({ kind: 'passphrase' })}><span className="grow">Change passphrase</span></button>
        <button className="row" onClick={() => setDialog({ kind: 'reveal' })}><span className="grow">Show household key</span></button>
        <button className="row" onClick={onLock}><span className="grow">Lock now</span></button>
      </div>

      <div className="notice small">
        Your ledger is encrypted on this phone (AES-256). Backups are encrypted with your household key and can be
        stored anywhere — they can’t be read without it.
      </div>

      <button className="btn danger block" onClick={async () => {
        if (await ask({
          title: 'Remove all transactions?',
          message: `This removes all ${ledger.transactions.length} transactions on both phones. People, cards, categories, budgets and bank connections stay. Bank transactions come back with the next import.`,
          confirmLabel: 'Remove all transactions', danger: true, typeToConfirm: 'DELETE',
        })) {
          onChange(startOver(ledger));
          toast('All transactions removed');
        }
      }}>Start over: remove all transactions</button>

      <button className="btn danger block" onClick={async () => {
        if (await ask({
          title: 'Erase this phone’s ledger?',
          message: 'This permanently deletes the ledger on this phone. Make sure you have a backup and your household key.',
          confirmLabel: 'Erase', danger: true, typeToConfirm: 'DELETE',
        })) {
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
      {dialog?.kind === 'faceid' && (
        <FaceIdSheet session={session} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); setFaceIdTick((n) => n + 1); toast('Face ID is on for this phone'); }} />
      )}
      {dialog?.kind === 'sync' && <SyncSheet sync={sync} onClose={() => setDialog(null)} toast={toast} />}
      {dialog?.kind === 'person' && (
        <PersonSheet ledger={ledger} name={dialog.name} onClose={() => setDialog(null)}
          onSave={(l) => { onChange(l); setDialog(null); }} />
      )}
      {dialog?.kind === 'bank' && (
        <BankAccountSheet ledger={ledger} id={dialog.id} onClose={() => setDialog(null)}
          onSave={(l) => { onChange(l); setDialog(null); }} />
      )}
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
  const ask = useConfirm();
  const groups = [...new Set(ledger.accounts.filter((a) => isCategory(a.name) && a.name.split(':').length > 2)
    .map((a) => a.name.split(':')[1]))].sort();
  const [label, setLabel] = useState(account?.label ?? '');
  const [group, setGroup] = useState('');
  const [owner, setOwner] = useState(account?.owner ?? '');
  const [error, setError] = useState('');

  function save() {
    const name = label.trim();
    if (!name) return setError('Enter a name.');
    try {
      const ownerPatch = type === 'card' ? { owner: owner || undefined } : {};
      if (account) return onSave(updateAccount(ledger, account.name, { label: name, ...ownerPatch }));
      const component = toAccountComponent(name);
      const full = type === 'card'
        ? `Liabilities:CreditCard:${component}`
        : `Expenses:${group ? `${group}:` : ''}${component}`;
      const added = addAccount(ledger, full, name, todayISO());
      onSave(type === 'card' && owner ? updateAccount(added, full, ownerPatch) : added);
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
        {type === 'card' && (
          <label className="field">
            <span>Belongs to</span>
            <select className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Not set</option>
              {(ledger.people ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
              <option value={SHARED}>Shared (family card)</option>
            </select>
            {!ledger.people?.length && <span className="tiny muted">Add people in Settings → People first.</span>}
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
        {account && (isAccountUsed(ledger, account.name) ? (
          <p className="tiny muted">This {type} has transactions{type === 'card' ? ' or a bank connection' : ''}, so it can be hidden but not removed.</p>
        ) : (
          <button className="btn danger block" onClick={async () => {
            if (await ask({ title: `Remove ${account.label}?`, message: 'It has no transactions, so nothing else changes.', confirmLabel: 'Remove', danger: true })) {
              onSave(deleteAccounts(ledger, [account.name]));
            }
          }}>Remove {type === 'card' ? 'card' : 'category'}</button>
        ))}
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

function SyncSheet({ sync, onClose, toast }: { sync: SyncControls; onClose: () => void; toast: (m: string) => void }) {
  const current = sync.device?.sync;
  const ask = useConfirm();
  const [repo, setRepo] = useState(current?.repo ?? '');
  const [token, setToken] = useState('');
  const [name, setName] = useState(current?.deviceName ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      await sync.connect(repo, token || current?.token || '', name);
      toast('Sync connected');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Sync" onClose={onClose}>
      <div className="stack">
        <p className="small">
          Both phones save the ledger, encrypted with your household key, to a private GitHub repo. GitHub only ever
          sees scrambled data.
        </p>
        <ol className="steps">
          <li>On GitHub, create a <strong>private</strong> repo (for example <code>finance-data</code>).</li>
          <li>
            Create a token: GitHub → Settings → Developer settings → Fine-grained tokens → Generate. Under
            <em> Repository access</em> pick only that repo; under <em>Permissions → Contents</em> choose
            <strong> Read and write</strong>.
          </li>
          <li>Paste the repo name and token below. Each phone can use its own token.</li>
        </ol>
        <label className="field">
          <span>Data repo (owner/name)</span>
          <input className="input" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="yourname/finance-data"
            value={repo} onChange={(e) => setRepo(e.target.value)} />
        </label>
        <label className="field">
          <span>{current ? 'New token (leave empty to keep the current one)' : 'GitHub token'}</span>
          <input className="input" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false}
            placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <label className="field">
          <span>Name for this phone</span>
          <input className="input" placeholder="e.g. Alex’s iPhone" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="tiny muted">The token is stored encrypted on this phone only and is never synced.</p>
        {error && <p className="error">{error}</p>}
        <button className="btn primary block" disabled={busy || !repo.trim() || (!token.trim() && !current)} onClick={connect}>
          {busy ? 'Checking…' : current ? 'Save' : 'Connect'}
        </button>
        {current && (
          <button className="btn danger block" onClick={async () => {
            if (await ask({
              title: 'Turn off sync on this phone?',
              message: 'This phone keeps its data but stops syncing. The other phone and the data repo are not affected.',
              confirmLabel: 'Turn off', danger: true,
            })) {
              await sync.disconnect();
              toast('Sync turned off');
              onClose();
            }
          }}>Turn off sync on this phone</button>
        )}
      </div>
    </Sheet>
  );
}

function BankAccountSheet({ ledger, id, onSave, onClose }: {
  ledger: Ledger;
  id: string;
  onSave: (l: Ledger) => void;
  onClose: () => void;
}) {
  const ask = useConfirm();
  const acct = ledger.importAccounts?.[id];
  const [target, setTarget] = useState(acct?.account ?? '');
  if (!acct) return null;
  const options = ledger.accounts.filter((a) => (isCard(a.name) || a.name.startsWith('Assets:')) && !a.closed);
  const counts = importedCount(ledger, id);

  async function save() {
    let next: Ledger = {
      ...ledger,
      importAccounts: { ...ledger.importAccounts, [id]: { ...acct!, account: target || null, updatedAt: new Date().toISOString() } },
    };
    if (!target && counts.unreviewed > 0 && await ask({
      title: 'Remove its imported transactions?',
      message: `${counts.unreviewed} transaction${counts.unreviewed === 1 ? '' : 's'} from this account are waiting for review. Remove them too? Ones you already approved stay.`,
      confirmLabel: `Remove ${counts.unreviewed}`, danger: true,
    })) {
      next = removeUnreviewedImports(next, id).ledger;
    }
    onSave(next);
  }

  return (
    <Sheet title="Bank account" onClose={onClose}>
      <div className="stack">
        <p><strong>{acct.name}</strong> <span className="muted">· {acct.org}</span></p>
        <p className="small muted">
          {counts.total ? `${counts.total} imported${counts.unreviewed ? `, ${counts.unreviewed} waiting for review` : ''}.` : 'Nothing imported from this account yet.'}
        </p>
        <label className="field">
          <span>Import its transactions into</span>
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Don’t import this account</option>
            {options.map((a) => <option key={a.name} value={a.name}>{a.label}</option>)}
          </select>
        </label>
        <p className="tiny muted">
          Checking and savings accounts are off by default, so paychecks and transfers don’t count as spending.
          Turning an account on picks up its transactions from the next daily import (the last 10 days).
        </p>
        <button className="btn primary block" onClick={save}>Save</button>
      </div>
    </Sheet>
  );
}

function PersonSheet({ ledger, name, onSave, onClose }: {
  ledger: Ledger;
  name?: string;
  onSave: (l: Ledger) => void;
  onClose: () => void;
}) {
  const ask = useConfirm();
  const [value, setValue] = useState(name ?? '');
  const [error, setError] = useState('');
  const people = ledger.people ?? [];

  function save() {
    const v = value.trim();
    if (!v) return setError('Enter a name.');
    if (v === SHARED) return setError('“Shared” is reserved for family cards.');
    if (v !== name && people.includes(v)) return setError('That name is already in the list.');
    onSave(name ? renamePerson(ledger, name, v) : setPeople(ledger, [...people, v]));
  }

  return (
    <Sheet title={name ? 'Edit person' : 'Add a person'} onClose={onClose}
      action={<button className="btn link" onClick={save}><strong>Save</strong></button>}>
      <div className="stack">
        <label className="field">
          <span>Name</span>
          <input className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. Rui" />
        </label>
        <p className="tiny muted">Then open Settings → Cards and choose whose each card is.</p>
        {error && <p className="error">{error}</p>}
        <button className="btn primary block" onClick={save}>Save</button>
        {name && (
          <button className="btn danger block" onClick={async () => {
            if (await ask({
              title: `Remove ${name}?`,
              message: 'Their cards stay, but won’t have an owner until you pick one.',
              confirmLabel: 'Remove', danger: true,
            })) onSave(removePerson(ledger, name));
          }}>Remove {name}</button>
        )}
      </div>
    </Sheet>
  );
}

function FaceIdSheet({ session, onClose, onDone }: { session: Session; onClose: () => void; onDone: () => void }) {
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // iPhones need two Face ID taps: one to create the passkey, one to use it.
  const [created, setCreated] = useState<{ credentialId: string; salt: string } | null>(null);

  async function step(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(describePasskeyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Face ID" onClose={onClose}>
      <div className="stack">
        {!created ? (
          <>
            <p className="small">
              Unlock this phone’s ledger with Face ID instead of typing your passphrase. Your passphrase still works as
              a backup. This saves a passkey for Household Ledger in Apple Passwords on this phone.
            </p>
            <label className="field"><span>Step 1 of 2: enter your passphrase</span>
              <input className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="btn primary block" disabled={busy || !pass} onClick={() => step(async () => {
              await session.verifyPassphrase(pass);
              const p = await createPasskey('Household Ledger');
              if (p.secret) {
                await session.enablePasskey(pass, { ...p, secret: p.secret });
                onDone();
              } else {
                setCreated({ credentialId: p.credentialId, salt: p.salt });
              }
            })}>{busy ? 'Waiting for Face ID…' : 'Create passkey'}</button>
            <p className="tiny muted">If iPhone asks where to save the passkey, choose Passwords (iCloud Keychain).</p>
          </>
        ) : (
          <>
            <p className="small">Passkey saved. Step 2 of 2: confirm with Face ID once to finish.</p>
            {error && <p className="error">{error}</p>}
            <button className="btn primary block" disabled={busy} onClick={() => step(async () => {
              const secret = await passkeySecret(created.credentialId, created.salt);
              await session.enablePasskey(pass, { ...created, secret });
              onDone();
            })}>{busy ? 'Waiting for Face ID…' : 'Confirm with Face ID'}</button>
          </>
        )}
      </div>
    </Sheet>
  );
}
