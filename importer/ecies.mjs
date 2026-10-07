// Encrypts an import for the household's public key. Must stay compatible with src/lib/ecies.ts.
const subtle = globalThis.crypto.subtle;
const INFO = new TextEncoder().encode('household-ledger/import/v1');

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

export async function sealImport(publicJwk, kid, value) {
  const recipient = await subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epkRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const shared = await subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256);
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: epkRaw, info: INFO }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: INFO }, key, new TextEncoder().encode(JSON.stringify(value)),
  ));
  return { format: 'household-ledger-import', v: 1, kid, epk: b64(epkRaw), iv: b64(iv), ct: b64(ct) };
}

// Symmetric helpers for keeping the SimpleFIN access URL encrypted in the repo.
async function secretKey(secret) {
  const ikm = await subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('household-ledger/simplefin/v1') },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function encryptWithSecret(secret, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(secret), new TextEncoder().encode(text));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) });
}

export async function decryptWithSecret(secret, json) {
  const { iv, ct } = JSON.parse(json);
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, await secretKey(secret), Buffer.from(ct, 'base64'),
  );
  return new TextDecoder().decode(plain);
}
