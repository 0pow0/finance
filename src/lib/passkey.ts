// Face ID / Touch ID unlock using a passkey with the WebAuthn "prf" extension (iOS 18+, Safari).
// The passkey gives us a secret only after the person passes Face ID; that secret is turned into a
// key that unlocks the household key on this phone. Nothing about the passkey is synced by us.

import { fromB64, toB64 } from './crypto';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export class PasskeyUnsupportedError extends Error {
  constructor(detail = '') {
    super(
      'This phone can’t use Face ID for this app yet. It needs iOS 18 or newer, the app opened from the Home Screen ' +
      'icon, and the passkey saved to Apple Passwords (iCloud Keychain), not another password manager.' +
      (detail ? ` (${detail})` : ''),
    );
  }
}

/** A readable message for errors from the Face ID / passkey prompts. */
export function describePasskeyError(e: unknown): string {
  const err = e as Error;
  if (err?.name === 'NotAllowedError') return 'Face ID was cancelled or timed out. Tap the button to try again.';
  if (err?.name === 'InvalidStateError') return 'A passkey for this app already exists on this phone. Try again.';
  if (err?.name === 'SecurityError') return 'Face ID only works on the app’s real address (0pow0.github.io).';
  return err?.message ?? String(e);
}

export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

type PrfResults = { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } };
const prfOf = (cred: PublicKeyCredential) =>
  (cred.getClientExtensionResults() as { prf?: PrfResults }).prf;

function bytes(x: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(x instanceof Uint8Array ? x.slice().buffer : x);
}

/**
 * Create a passkey on this phone (asks for Face ID). Returns its id and salt, plus the secret if the
 * platform gives it at creation. iPhones usually don't: then call passkeySecret() from a second tap.
 */
export async function createPasskey(displayName: string): Promise<{ credentialId: string; salt: string; secret?: Uint8Array<ArrayBuffer> }> {
  if (!passkeysAvailable()) throw new PasskeyUnsupportedError();
  const salt = random(32);
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Household Ledger' },
      user: { id: random(16), name: 'household-ledger', displayName },
      challenge: random(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'platform' },
      timeout: 60_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new PasskeyUnsupportedError('no passkey was created');
  const prf = prfOf(cred);
  if (!prf) throw new PasskeyUnsupportedError('passkey has no PRF support');
  if (prf.enabled === false && !prf.results?.first) throw new PasskeyUnsupportedError('PRF not enabled for this passkey');
  const credentialId = toB64(new Uint8Array(cred.rawId));
  return { credentialId, salt: toB64(salt), secret: prf.results?.first ? bytes(prf.results.first) : undefined };
}

/** Use the passkey (asks for Face ID) and return its secret. */
export async function passkeySecret(credentialId: string, salt: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!passkeysAvailable()) throw new PasskeyUnsupportedError();
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: 'public-key', id: fromB64(credentialId) }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: fromB64(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const first = cred && prfOf(cred)?.results?.first;
  if (!first) throw new PasskeyUnsupportedError('passkey returned no secret');
  return bytes(first);
}
