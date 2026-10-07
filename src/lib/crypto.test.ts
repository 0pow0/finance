import { describe, expect, it } from 'vitest';
import {
  decodeRecoveryKey, decryptJSON, encodeRecoveryKey, encryptJSON, generateHouseholdKey,
  importHouseholdKey, keyId, unwrapWithPassphrase, wrapWithPassphrase, WrongPassphraseError,
} from './crypto';

describe('crypto', () => {
  it('recovery key round-trips and catches typos', async () => {
    const raw = await generateHouseholdKey();
    const text = await encodeRecoveryKey(raw);
    expect(text).toMatch(/^([0-9A-Z]{5}-){10}[0-9A-Z]{5}$/);
    expect(await decodeRecoveryKey(text)).toEqual(raw);
    expect(await decodeRecoveryKey(text.toLowerCase().replace(/-/g, ' '))).toEqual(raw);
    const typo = (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
    await expect(decodeRecoveryKey(typo)).rejects.toThrow(/typo/);
    await expect(decodeRecoveryKey('ABC')).rejects.toThrow(/length/);
  });

  it('wraps the key with a passphrase', async () => {
    const raw = await generateHouseholdKey();
    const w = await wrapWithPassphrase(raw, 'correct horse battery', 1000);
    expect(await unwrapWithPassphrase(w, 'correct horse battery')).toEqual(raw);
    await expect(unwrapWithPassphrase(w, 'wrong')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('encrypts data and detects tampering or the wrong key', async () => {
    const raw = await generateHouseholdKey();
    const key = await importHouseholdKey(raw);
    const blob = await encryptJSON(key, await keyId(raw), { hello: 'world', n: [1, 2, 3] });
    expect(JSON.stringify(blob)).not.toContain('world');
    expect(await decryptJSON(key, blob)).toEqual({ hello: 'world', n: [1, 2, 3] });

    const ct = blob.ct;
    const flipped = { ...blob, ct: (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1) };
    await expect(decryptJSON(key, flipped)).rejects.toThrow(/could not be decrypted/);

    const other = await importHouseholdKey(await generateHouseholdKey());
    await expect(decryptJSON(other, blob)).rejects.toThrow(/could not be decrypted/);
  });

  it('uses a fresh IV each time', async () => {
    const raw = await generateHouseholdKey();
    const key = await importHouseholdKey(raw);
    const a = await encryptJSON(key, 'k', 1);
    const b = await encryptJSON(key, 'k', 1);
    expect(a.iv).not.toBe(b.iv);
  });
});
