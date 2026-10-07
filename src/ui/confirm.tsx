import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  /** If set, the person must type this word to enable the confirm button. */
  typeToConfirm?: string;
}

type Ask = (o: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask>(async () => false);

/** In-app confirmation dialogs (the browser's confirm()/prompt() don't suit an installed app). */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');

  const ask = useCallback<Ask>((o) => new Promise((resolve) => {
    setTyped('');
    setPending({ ...o, resolve });
  }), []);

  function finish(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  const blocked = !!pending?.typeToConfirm && typed.trim().toUpperCase() !== pending.typeToConfirm;

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {pending && (
        <div className="sheet-backdrop confirm-backdrop" onClick={() => finish(false)}>
          <div className="sheet confirm" role="alertdialog" aria-label={pending.title} onClick={(e) => e.stopPropagation()}>
            <div className="stack">
              <h2>{pending.title}</h2>
              <p className="small">{pending.message}</p>
              {pending.typeToConfirm && (
                <label className="field">
                  <span>Type {pending.typeToConfirm} to confirm</span>
                  <input className="input" autoCapitalize="characters" autoCorrect="off" autoFocus value={typed}
                    onChange={(e) => setTyped(e.target.value)} />
                </label>
              )}
              <button className={`btn block ${pending.danger ? 'danger-fill' : 'primary'}`} disabled={blocked}
                onClick={() => finish(true)}>{pending.confirmLabel}</button>
              <button className="btn block" onClick={() => finish(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Ask {
  return useContext(ConfirmContext);
}
