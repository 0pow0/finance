import { useState } from 'react';
import { checkPassphrase, eraseVault, resetPassphrase, unlockVault, type Session } from '../lib/vault';

export function Unlock({ onReady, onErased }: { onReady: (s: Session) => void; onErased: () => void }) {
  const [mode, setMode] = useState<'pass' | 'forgot'>('pass');
  const [pass, setPass] = useState('');
  const [recovery, setRecovery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  if (mode === 'forgot') {
    const passError = pass ? checkPassphrase(pass) : null;
    return (
      <div className="center-screen">
        <h1>Reset passphrase</h1>
        <p className="muted small">Enter your household key, then choose a new passphrase for this phone.</p>
        <label className="field">
          <span>Household key</span>
          <textarea className="input" rows={3} autoCapitalize="characters" autoCorrect="off" spellCheck={false}
            value={recovery} onChange={(e) => setRecovery(e.target.value)} />
        </label>
        <label className="field">
          <span>New passphrase</span>
          <input className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </label>
        {passError && <p className="error">{passError}</p>}
        {error && <p className="error">{error}</p>}
        <button className="btn primary block" disabled={busy || !recovery || !pass || !!passError}
          onClick={() => run(async () => onReady(await resetPassphrase(recovery, pass)))}>
          {busy ? 'Unlocking…' : 'Reset and unlock'}
        </button>
        <button className="btn link" onClick={() => { setMode('pass'); setPass(''); setError(''); }}>Back</button>
        <hr />
        <button className="btn danger block" onClick={async () => {
          if (prompt('This permanently deletes the ledger stored on this phone. Type DELETE to confirm.') === 'DELETE') {
            await eraseVault();
            onErased();
          }
        }}>Erase this phone’s ledger</button>
      </div>
    );
  }

  return (
    <div className="center-screen">
      <img className="logo" src="./icon-192.png" alt="" />
      <h1>Household Ledger</h1>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => onReady(await unlockVault(pass))); }}>
        <label className="field">
          <span>Passphrase</span>
          <input className="input" type="password" autoComplete="current-password" autoFocus value={pass}
            onChange={(e) => setPass(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary block" disabled={!pass || busy}>{busy ? 'Unlocking…' : 'Unlock'}</button>
      </form>
      <button className="btn link" onClick={() => { setMode('forgot'); setPass(''); setError(''); }}>Forgot passphrase?</button>
    </div>
  );
}
