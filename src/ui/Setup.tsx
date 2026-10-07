import { useState } from 'react';
import { checkPassphrase, createVault, restoreVault, type Session } from '../lib/vault';
import { readFileText, saveFile } from './common';

type Step = 'choose' | 'create' | 'recovery' | 'join';

export function Setup({ onReady }: { onReady: (s: Session) => void }) {
  const [step, setStep] = useState<Step>('choose');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [recovery, setRecovery] = useState('');
  const [backup, setBackup] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const passError = pass ? checkPassphrase(pass) : null;
  const mismatch = pass2 && pass !== pass2 ? 'Passphrases don’t match.' : null;
  const passOk = pass && !passError && pass === pass2;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const passFields = (
    <>
      <label className="field">
        <span>Passphrase for this phone</span>
        <input className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      <label className="field">
        <span>Type it again</span>
        <input className="input" type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
      </label>
      {(passError || mismatch) && <p className="error">{passError ?? mismatch}</p>}
    </>
  );

  if (step === 'choose') {
    return (
      <div className="center-screen">
        <img className="logo" src="./icon-192.png" alt="" />
        <h1>Household Ledger</h1>
        <p className="muted">
          Your family’s credit card spending and budgets. Everything is encrypted on this phone — only people with your
          household key can ever read it.
        </p>
        <button className="btn primary block" onClick={() => setStep('create')}>Start a new household ledger</button>
        <button className="btn block" onClick={() => setStep('join')}>Set up a second phone / restore</button>
      </div>
    );
  }

  if (step === 'create') {
    return (
      <div className="center-screen">
        <h1>Choose a passphrase</h1>
        <p className="muted small">
          You’ll use this to unlock the app on this phone. Each phone can have its own passphrase.
        </p>
        {passFields}
        {error && <p className="error">{error}</p>}
        <button className="btn primary block" disabled={!passOk || busy} onClick={() => run(async () => {
          const res = await createVault(pass);
          setSession(res.session);
          setRecovery(res.recoveryKey);
          setStep('recovery');
        })}>
          {busy ? 'Creating…' : 'Create ledger'}
        </button>
        <button className="btn link" onClick={() => setStep('choose')}>Back</button>
      </div>
    );
  }

  if (step === 'recovery') {
    return (
      <div className="center-screen">
        <h1>Your household key</h1>
        <p className="small">
          This key unlocks your data on any device. <strong>Write it down or print it and keep it somewhere safe.</strong>{' '}
          You’ll also use it to set up the second phone.
        </p>
        <div className="recovery">{recovery}</div>
        <div className="notice">
          If you lose every phone <em>and</em> this key, your data cannot be recovered — not by us, not by anyone.
          Never share it, photograph it into cloud albums, or paste it into chats.
        </div>
        <button className="btn block" onClick={() => saveFile('household-key.txt',
          `Household Ledger — household key\nCreated ${new Date().toDateString()}\n\n${recovery}\n\nKeep this private. Anyone with this key can read your ledger.\n`,
          'text/plain').catch(() => {})}>
          Save / print a copy
        </button>
        <label className="hstack small">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I’ve saved my household key somewhere safe
        </label>
        <button className="btn primary block" disabled={!saved} onClick={() => session && onReady(session)}>Continue</button>
      </div>
    );
  }

  return (
    <div className="center-screen">
      <h1>Set up this phone</h1>
      <p className="muted small">
        Enter your household key. To bring your existing transactions over, also choose a backup file from the other
        phone (Settings → Download encrypted backup).
      </p>
      <label className="field">
        <span>Household key</span>
        <textarea className="input" rows={3} autoCapitalize="characters" autoCorrect="off" spellCheck={false}
          value={recovery} onChange={(e) => setRecovery(e.target.value)} placeholder="XXXXX-XXXXX-…" />
      </label>
      <div className="spread">
        <span className="small muted">{backup ? 'Backup file selected ✓' : 'No backup file (start empty)'}</span>
        <button className="btn" onClick={async () => setBackup(await readFileText('.json,application/json'))}>
          Choose backup
        </button>
      </div>
      {passFields}
      {error && <p className="error">{error}</p>}
      <button className="btn primary block" disabled={!passOk || !recovery.trim() || busy}
        onClick={() => run(async () => onReady(await restoreVault(recovery, pass, backup ?? undefined)))}>
        {busy ? 'Unlocking…' : 'Set up'}
      </button>
      <button className="btn link" onClick={() => setStep('choose')}>Back</button>
    </div>
  );
}
