// Encryption for the ledger, using only the browser's built-in Web Crypto API.
//
// - The "household key" is a random 256-bit AES-GCM key. It encrypts the ledger and every
//   backup/sync copy. Nobody can read the data without it.
// - On each device the household key is stored wrapped (encrypted) by a key derived from the
//   passphrase with PBKDF2-SHA256, so the device storage alone is not enough to read it.
// - The household key is shown once as a "recovery key" to print and keep safe. It is also how a
//   second phone is set up. Backups contain only data encrypted with the household key, never a
//   passphrase-wrapped key, so a leaked backup can't be attacked by guessing the passphrase.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 600_000;
const DATA_AAD = enc.encode('household-ledger/data/v1');
const WRAP_AAD = enc.encode('household-ledger/key/v1');

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function generateHouseholdKey(): Promise<Uint8Array<ArrayBuffer>> {
  return randomBytes(32);
}

export async function importHouseholdKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Short fingerprint so we can tell whether a backup belongs to this household's key. */
export async function keyId(raw: Uint8Array<ArrayBuffer>): Promise<string> {
  const h = new Uint8Array(await subtle.digest('SHA-256', raw));
  return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Recovery key: the household key as typeable text, with a checksum to catch typos ----

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)

function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Uint8Array<ArrayBuffer> | null {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function encodeRecoveryKey(raw: Uint8Array<ArrayBuffer>): Promise<string> {
  const check = new Uint8Array(await subtle.digest('SHA-256', raw)).slice(0, 2);
  const all = new Uint8Array(34);
  all.set(raw);
  all.set(check, 32);
  return base32(all).match(/.{1,5}/g)!.join('-');
}

export async function decodeRecoveryKey(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const cleaned = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[OIL]/g, (c) => (c === 'O' ? '0' : '1'));
  const bytes = unbase32(cleaned);
  if (!bytes || bytes.length !== 34) throw new Error('That recovery key is not the right length.');
  const raw = bytes.slice(0, 32);
  const check = new Uint8Array(await subtle.digest('SHA-256', raw)).slice(0, 2);
  if (check[0] !== bytes[32] || check[1] !== bytes[33]) {
    throw new Error('That recovery key has a typo — please check it again.');
  }
  return raw;
}

// ---- Passphrase wrapping (device storage) ----

export interface WrappedKey {
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
}

async function passphraseKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapWithPassphrase(
  raw: Uint8Array<ArrayBuffer>,
  passphrase: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<WrappedKey> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = await passphraseKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: WRAP_AAD }, kek, raw));
  return { kdf: 'PBKDF2-SHA256', iterations, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase.');
  }
}

export async function unwrapWithPassphrase(w: WrappedKey, passphrase: string): Promise<Uint8Array<ArrayBuffer>> {
  const kek = await passphraseKey(passphrase, fromB64(w.salt), w.iterations);
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(w.iv), additionalData: WRAP_AAD }, kek, fromB64(w.ct));
    return new Uint8Array(pt);
  } catch {
    throw new WrongPassphraseError();
  }
}

// ---- Data encryption ----

export interface EncryptedBlob {
  format: 'household-ledger';
  v: 1;
  keyId: string;
  iv: string;
  ct: string;
}

async function gzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encryptJSON(key: CryptoKey, kid: string, value: unknown): Promise<EncryptedBlob> {
  const iv = randomBytes(12);
  const plain = await gzip(enc.encode(JSON.stringify(value)));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: DATA_AAD }, key, plain));
  return { format: 'household-ledger', v: 1, keyId: kid, iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJSON(key: CryptoKey, blob: EncryptedBlob): Promise<unknown> {
  if (blob.format !== 'household-ledger' || blob.v !== 1) throw new Error('Not a household ledger file.');
  let plain: Uint8Array<ArrayBuffer>;
  try {
    plain = new Uint8Array(
      await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv), additionalData: DATA_AAD }, key, fromB64(blob.ct)),
    );
  } catch {
    throw new Error('This file could not be decrypted with your household key.');
  }
  return JSON.parse(dec.decode(await gunzip(plain)));
}

// ---- Wrapping with a high-entropy secret (e.g. from a passkey) ----

export interface SecretWrappedKey {
  iv: string;
  ct: string;
}

const PASSKEY_INFO = enc.encode('household-ledger/passkey/v1');

async function secretKek(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const ikm = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: PASSKEY_INFO }, ikm,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function wrapWithSecret(raw: Uint8Array<ArrayBuffer>, secret: Uint8Array<ArrayBuffer>): Promise<SecretWrappedKey> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: PASSKEY_INFO }, await secretKek(secret), raw));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function unwrapWithSecret(w: SecretWrappedKey, secret: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(w.iv), additionalData: PASSKEY_INFO }, await secretKek(secret), fromB64(w.ct));
    return new Uint8Array(pt);
  } catch {
    throw new Error('Face ID unlock didn’t work. Use your passphrase, then turn Face ID off and on again in Settings.');
  }
}
