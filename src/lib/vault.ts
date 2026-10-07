// The encrypted vault on this device (IndexedDB). Nothing here is ever stored unencrypted.

import {
  decodeRecoveryKey,
  decryptJSON,
  encodeRecoveryKey,
  encryptJSON,
  generateHouseholdKey,
  importHouseholdKey,
  keyId,
  unwrapWithPassphrase,
  wrapWithPassphrase,
  type EncryptedBlob,
  type WrappedKey,
} from './crypto';
import { assertLedger, newLedger, type Ledger } from './ledger';
import { todayISO } from './dates';

export interface VaultRecord {
  v: 1;
  keyId: string;
  wrapped: WrappedKey;
  data: EncryptedBlob;
  updatedAt: string;
  lastBackupAt?: string;
}

const DB_NAME = 'household-ledger';
const STORE = 'vault';
const KEY = 'main';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function loadVault(): Promise<VaultRecord | undefined> {
  return tx('readonly', (s) => s.get(KEY) as IDBRequest<VaultRecord | undefined>);
}

async function storeVault(rec: VaultRecord): Promise<void> {
  await tx('readwrite', (s) => s.put(rec, KEY));
}

export async function eraseVault(): Promise<void> {
  await tx('readwrite', (s) => s.delete(KEY));
}

/** Ask the browser not to evict our storage. Best effort. */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** An unlocked ledger. Holds the household key only in memory (non-extractable). */
export class Session {
  private constructor(
    private key: CryptoKey,
    readonly keyId: string,
    private record: VaultRecord,
    public ledger: Ledger,
  ) {}

  get lastBackupAt(): string | undefined {
    return this.record.lastBackupAt;
  }

  static async open(raw: Uint8Array<ArrayBuffer>, record: VaultRecord): Promise<Session> {
    const key = await importHouseholdKey(raw);
    const ledger = await decryptJSON(key, record.data);
    assertLedger(ledger);
    return new Session(key, record.keyId, record, ledger);
  }

  async save(ledger: Ledger): Promise<void> {
    const data = await encryptJSON(this.key, this.keyId, ledger);
    const record: VaultRecord = { ...this.record, data, updatedAt: new Date().toISOString() };
    await storeVault(record);
    this.record = record;
    this.ledger = ledger;
  }

  /** An encrypted backup file's contents. Readable only with the household key. */
  async exportBackup(): Promise<string> {
    const blob = await encryptJSON(this.key, this.keyId, this.ledger);
    this.record = { ...this.record, lastBackupAt: new Date().toISOString() };
    await storeVault(this.record);
    return JSON.stringify(blob);
  }

  async readBackup(text: string): Promise<Ledger> {
    const blob = parseBlob(text);
    if (blob.keyId !== this.keyId) throw new Error('This backup belongs to a different household key.');
    const ledger = await decryptJSON(this.key, blob);
    assertLedger(ledger);
    return ledger;
  }

  async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
    const raw = await unwrapWithPassphrase(this.record.wrapped, oldPassphrase);
    const wrapped = await wrapWithPassphrase(raw, newPassphrase);
    this.record = { ...this.record, wrapped };
    await storeVault(this.record);
  }

  async revealRecoveryKey(passphrase: string): Promise<string> {
    return encodeRecoveryKey(await unwrapWithPassphrase(this.record.wrapped, passphrase));
  }
}

function parseBlob(text: string): EncryptedBlob {
  try {
    const b = JSON.parse(text);
    if (b?.format === 'household-ledger') return b;
  } catch {
    // fall through
  }
  throw new Error('That file is not a household ledger backup.');
}

export const MIN_PASSPHRASE = 10;

export function checkPassphrase(p: string): string | null {
  if (p.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters — a few random words works well.`;
  return null;
}

/** Brand-new household: makes the key, an empty ledger, and returns the recovery key to print. */
export async function createVault(passphrase: string): Promise<{ session: Session; recoveryKey: string }> {
  const raw = await generateHouseholdKey();
  const record = await buildRecord(raw, passphrase, newLedger(todayISO()));
  await storeVault(record);
  return { session: await Session.open(raw, record), recoveryKey: await encodeRecoveryKey(raw) };
}

export async function unlockVault(passphrase: string): Promise<Session> {
  const record = await loadVault();
  if (!record) throw new Error('No ledger on this device.');
  return Session.open(await unwrapWithPassphrase(record.wrapped, passphrase), record);
}

/**
 * Set up this device with an existing household key (from the recovery key), optionally
 * restoring a backup file. Without a backup the ledger starts empty until sync is added.
 */
export async function restoreVault(recoveryKey: string, passphrase: string, backupText?: string): Promise<Session> {
  const raw = await decodeRecoveryKey(recoveryKey);
  const kid = await keyId(raw);
  let ledger = newLedger(todayISO());
  if (backupText) {
    const blob = parseBlob(backupText);
    if (blob.keyId !== kid) throw new Error('This backup was made with a different household key.');
    const restored = await decryptJSON(await importHouseholdKey(raw), blob);
    assertLedger(restored);
    ledger = restored;
  }
  const record = await buildRecord(raw, passphrase, ledger);
  await storeVault(record);
  return Session.open(raw, record);
}

async function buildRecord(raw: Uint8Array<ArrayBuffer>, passphrase: string, ledger: Ledger): Promise<VaultRecord> {
  const kid = await keyId(raw);
  const key = await importHouseholdKey(raw);
  return {
    v: 1,
    keyId: kid,
    wrapped: await wrapWithPassphrase(raw, passphrase),
    data: await encryptJSON(key, kid, ledger),
    updatedAt: new Date().toISOString(),
  };
}

/** Forgot the passphrase: unlock with the household key and set a new passphrase, keeping the data. */
export async function resetPassphrase(recoveryKey: string, newPassphrase: string): Promise<Session> {
  const record = await loadVault();
  if (!record) throw new Error('No ledger on this device.');
  const raw = await decodeRecoveryKey(recoveryKey);
  if ((await keyId(raw)) !== record.keyId) throw new Error('That is not the household key for this ledger.');
  const updated: VaultRecord = { ...record, wrapped: await wrapWithPassphrase(raw, newPassphrase) };
  await storeVault(updated);
  return Session.open(raw, updated);
}
