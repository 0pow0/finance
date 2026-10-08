import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { simpleTxn, upsertTransaction } from './ledger';
import { createVault, eraseVault, loadVault, resetPassphrase, restoreVault, unlockVault } from './vault';

describe('vault', () => {
  beforeEach(() => eraseVault());

  it('creates, saves, locks and unlocks', async () => {
    const { session, recoveryKey } = await createVault('our family passphrase');
    expect(recoveryKey.length).toBeGreaterThan(50);
    const l = upsertTransaction(session.ledger, simpleTxn({
      date: '2026-10-07', payee: 'Costco', amount: 15000,
      card: 'Liabilities:CreditCard:Chase', category: 'Expenses:Food:Groceries',
    }));
    await session.save(l);

    const stored = JSON.stringify(await loadVault());
    expect(stored).not.toContain('Costco');

    const again = await unlockVault('our family passphrase');
    expect(again.ledger.transactions[0].payee).toBe('Costco');
    await expect(unlockVault('nope nope nope')).rejects.toThrow(/Wrong passphrase/);
  });

  it('restores on a new device from the recovery key and a backup', async () => {
    const { session, recoveryKey } = await createVault('first phone passphrase');
    await session.save(upsertTransaction(session.ledger, simpleTxn({
      date: '2026-10-07', payee: 'Shell', amount: 4000,
      card: 'Liabilities:CreditCard:Amex', category: 'Expenses:Transport:Gas',
    })));
    const backup = await session.exportBackup();
    expect(backup).not.toContain('Shell');

    await eraseVault(); // "new phone"
    const restored = await restoreVault(recoveryKey, 'second phone passphrase', backup);
    expect(restored.ledger.transactions[0].payee).toBe('Shell');
    expect(restored.keyId).toBe(session.keyId);
    expect((await unlockVault('second phone passphrase')).ledger.transactions).toHaveLength(1);
  });

  it('refuses a backup from a different household', async () => {
    const a = await createVault('household a passphrase');
    const backupA = await a.session.exportBackup();
    const b = await createVault('household b passphrase');
    await expect(b.session.readBackup(backupA)).rejects.toThrow(/different household/);
    await expect(restoreVault(b.recoveryKey, 'whatever passphrase', backupA)).rejects.toThrow(/different/);
  });

  it('changes the passphrase and reveals the recovery key', async () => {
    const { session, recoveryKey } = await createVault('old passphrase 123');
    await session.changePassphrase('old passphrase 123', 'new passphrase 456');
    await expect(unlockVault('old passphrase 123')).rejects.toThrow();
    const s2 = await unlockVault('new passphrase 456');
    expect(await s2.revealRecoveryKey('new passphrase 456')).toBe(recoveryKey);
  });
});

describe('forgotten passphrase', () => {
  beforeEach(() => eraseVault());
  it('resets with the household key and keeps the data', async () => {
    const { session, recoveryKey } = await createVault('forgotten passphrase');
    await session.save({ ...session.ledger, title: 'Ours' });
    const s = await resetPassphrase(recoveryKey, 'brand new passphrase');
    expect(s.ledger.title).toBe('Ours');
    expect((await unlockVault('brand new passphrase')).ledger.title).toBe('Ours');
    const other = await createVault('x'.repeat(12)); // replaces vault; use its key against a fresh one
    await eraseVault();
    await createVault('third passphrase');
    await expect(resetPassphrase(other.recoveryKey, 'whatever passphrase')).rejects.toThrow(/not the household key/);
  });
});

describe('Face ID (passkey) unlock', () => {
  beforeEach(() => eraseVault());
  it('unlocks with the passkey secret, and not with a wrong one', async () => {
    const { unlockWithPasskey } = await import('./vault');
    const { session } = await createVault('passphrase for face id');
    await session.save({ ...session.ledger, title: 'Face ID test' });
    const secret = crypto.getRandomValues(new Uint8Array(32));
    await expect(session.enablePasskey('wrong passphrase', { credentialId: 'x', salt: 's', secret })).rejects.toThrow();
    await session.enablePasskey('passphrase for face id', { credentialId: 'cred1', salt: 'salt1', secret });
    expect(session.hasPasskey).toBe(true);

    const s2 = await unlockWithPasskey(async (id, salt) => {
      expect([id, salt]).toEqual(['cred1', 'salt1']);
      return secret;
    });
    expect(s2.ledger.title).toBe('Face ID test');
    await expect(unlockWithPasskey(async () => crypto.getRandomValues(new Uint8Array(32)))).rejects.toThrow(/passphrase/);

    // Saving the ledger keeps Face ID set up; turning it off removes it.
    await s2.save({ ...s2.ledger, title: 'Saved again' });
    expect((await unlockWithPasskey(async () => secret)).ledger.title).toBe('Saved again');
    await s2.disablePasskey();
    await expect(unlockWithPasskey(async () => secret)).rejects.toThrow(/isn’t set up/);
  });
});
