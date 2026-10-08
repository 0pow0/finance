import { useCallback, useEffect, useRef, useState } from 'react';
import { monthOf, todayISO } from '../lib/dates';
import { deleteTransaction, markReplaced, upsertTransaction, type Ledger, type Transaction } from '../lib/ledger';
import { loadVault, requestPersistence, type Session } from '../lib/vault';
import { Activity } from './Activity';
import { Icon } from './common';
import { Home } from './Home';
import { Settings } from './Settings';
import { Setup } from './Setup';
import { TxnEditor } from './TxnEditor';
import { Unlock } from './Unlock';
import { describeStatus, useSync } from './useSync';

type Screen = 'loading' | 'setup' | 'locked' | 'open';
type Tab = 'home' | 'activity' | 'settings';

function readAutoLock(): number {
  try {
    return Number(localStorage.getItem('autoLockMinutes')) || 5;
  } catch {
    return 5;
  }
}

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [month, setMonth] = useState(monthOf(todayISO()));
  const [editing, setEditing] = useState<Transaction | 'new' | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState('');
  const [autoLock, setAutoLockState] = useState(readAutoLock);
  const lastActive = useRef(Date.now());
  const ledgerRef = useRef<Ledger | null>(null);
  ledgerRef.current = ledger;

  useEffect(() => {
    loadVault()
      .then((v) => setScreen(v ? 'locked' : 'setup'))
      .catch(() => setScreen('setup'));
  }, []);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 3000);
  }, []);

  const lock = useCallback(() => {
    setSession(null);
    setLedger(null);
    setEditing(null);
    setScreen('locked');
  }, []);

  // Auto-lock after inactivity, and when coming back to the app after being away too long.
  useEffect(() => {
    if (screen !== 'open') return;
    const bump = () => (lastActive.current = Date.now());
    const check = () => {
      if (Date.now() - lastActive.current > autoLock * 60_000) lock();
    };
    const onVisible = () => (document.visibilityState === 'visible' ? check() : undefined);
    bump();
    window.addEventListener('pointerdown', bump);
    window.addEventListener('keydown', bump);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(check, 15_000);
    return () => {
      window.removeEventListener('pointerdown', bump);
      window.removeEventListener('keydown', bump);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [screen, autoLock, lock]);

  function opened(s: Session) {
    setSession(s);
    setLedger(s.ledger);
    setTab('home');
    setScreen('open');
    requestPersistence();
  }

  const apply = useCallback(async (next: Ledger) => {
    if (!session) return;
    await session.save(next);
    ledgerRef.current = next;
    setLedger(next);
  }, [session]);

  const onImported = useCallback((n: number) => toast(`${n} new bank transaction${n === 1 ? '' : 's'} to review`), [toast]);
  const sync = useSync(session, ledgerRef, apply, onImported);

  async function commit(next: Ledger) {
    try {
      await apply(next);
      sync.requestSync();
    } catch (e) {
      toast(`Couldn’t save: ${(e as Error).message}`);
    }
  }

  function setAutoLock(m: number) {
    setAutoLockState(m);
    try {
      localStorage.setItem('autoLockMinutes', String(m));
    } catch {
      // not persisted; fine
    }
  }

  if (screen === 'loading') return null;
  if (screen === 'setup') return <Setup onReady={opened} />;
  if (screen === 'locked' || !session || !ledger) {
    return <Unlock onReady={opened} onErased={() => setScreen('setup')} />;
  }

  const reviewCount = ledger.transactions.filter((t) => t.flag === '!').length;
  const daysSinceBackup = session.lastBackupAt
    ? (Date.now() - new Date(session.lastBackupAt).getTime()) / 86_400_000
    : Infinity;

  return (
    <div className="app">
      {tab === 'home' && (
        <>
          <div className="spread">
            <h1>{ledger.title}</h1>
            {sync.device?.sync && (
              <button className={`btn link small sync-status ${sync.status.state === 'error' ? 'bad' : 'muted'}`}
                onClick={() => (sync.status.state === 'error' ? setTab('settings') : void sync.syncNow())}>
                {sync.status.state === 'error' ? 'Sync problem' : describeStatus(sync.status)}
              </button>
            )}
          </div>
          {!sync.device?.sync && ledger.transactions.length > 0 && daysSinceBackup > 7 && (
            <button className="card notice small" onClick={() => setTab('settings')}>
              {session.lastBackupAt ? 'It’s been over a week since your last backup.' : 'You haven’t made a backup yet.'}{' '}
              Turn on sync (Settings → Sync) or download an encrypted backup weekly.
            </button>
          )}
          <Home ledger={ledger} month={month} setMonth={setMonth} onChange={commit} reviewCount={reviewCount}
            onReview={() => { setReviewOnly(true); setTab('activity'); }}
            person={person} setPerson={setPerson} onOpenSettings={() => setTab('settings')} />
        </>
      )}
      {tab === 'activity' && (
        <Activity ledger={ledger} onOpen={setEditing} reviewOnly={reviewOnly} setReviewOnly={setReviewOnly}
          onChange={commit} toast={toast} />
      )}
      {tab === 'settings' && (
        <Settings session={session} ledger={ledger} onChange={commit} onReplace={(l) => commit(markReplaced(l))} onLock={lock}
          sync={sync}
          onErased={() => { setSession(null); setLedger(null); setScreen('setup'); }}
          autoLock={autoLock} setAutoLock={setAutoLock} toast={toast} />
      )}

      {editing && (
        <TxnEditor ledger={ledger} txn={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (t) => {
            await commit(upsertTransaction(ledger, t));
            setEditing(null);
            toast(editing === 'new' ? 'Saved' : 'Updated');
          }}
          onDelete={async (id) => {
            await commit(deleteTransaction(ledger, id));
            setEditing(null);
            toast('Deleted');
          }} />
      )}

      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}

      <nav className="tabbar">
        <div className="tabbar-inner">
          <button className={tab === 'home' ? 'on' : ''} onClick={() => setTab('home')}><Icon name="home" />Home</button>
          <button className={tab === 'activity' ? 'on' : ''} onClick={() => { setReviewOnly(false); setTab('activity'); }}>
            <Icon name="list" />Activity
          </button>
          <button className="add" aria-label="Add spending" onClick={() => setEditing('new')}><Icon name="plus" /></button>
          <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}><Icon name="gear" />Settings</button>
          <button onClick={lock}><Icon name="lock" />Lock</button>
        </div>
      </nav>
    </div>
  );
}
