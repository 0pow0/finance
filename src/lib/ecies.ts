// Public-key encryption for bank imports (ECIES: P-256 ECDH + HKDF-SHA256 + AES-256-GCM).
//
// The daily import job only knows the *public* key, so it can encrypt new transactions for the
// phones but can never decrypt anything. The private key lives inside the encrypted ledger.
// importer/ecies.mjs is the job's side of this; tests check the two stay compatible.

import { fromB64, toB64 } from './crypto';
import type { ImportKey } from './ledger';

const subtle = globalThis.crypto.subtle;
const INFO = new TextEncoder().encode('household-ledger/import/v1');

export interface SealedImport {
  format: 'household-ledger-import';
  v: 1;
  kid: string;
  epk: string;
  iv: string;
  ct: string;
}

export async function publicKeyId(publicJwk: JsonWebKey): Promise<string> {
  const key = await subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const raw = new Uint8Array(await subtle.exportKey('raw', key));
  const h = new Uint8Array(await subtle.digest('SHA-256', raw));
  return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function generateImportKey(createdAt = new Date().toISOString()): Promise<ImportKey> {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicJwk = await subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await subtle.exportKey('jwk', pair.privateKey);
  const pub: JsonWebKey = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };
  return { kid: await publicKeyId(pub), createdAt, publicJwk: pub, privateJwk };
}

async function aesKey(shared: ArrayBuffer, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

export async function openImport(sealed: SealedImport, keys: ImportKey[]): Promise<unknown> {
  if (sealed.format !== 'household-ledger-import' || sealed.v !== 1) throw new Error('Not an import file.');
  const key = keys.find((k) => k.kid === sealed.kid);
  if (!key) throw new Error(`Import was encrypted to an unknown key (${sealed.kid}).`);
  const priv = await subtle.importKey('jwk', key.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const epkRaw = fromB64(sealed.epk);
  const epk = await subtle.importKey('raw', epkRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256);
  const aes = await aesKey(shared, epkRaw);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: INFO }, aes, fromB64(sealed.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

export { toB64 };
