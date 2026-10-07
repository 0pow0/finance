// One sync round with the private data repo:
//   1. read the synced ledger and merge it with this phone's copy,
//   2. fold in any new bank imports waiting in inbox/,
//   3. save the merged ledger back (retrying if the other phone saved at the same moment),
//   4. publish the import public key for the daily job, and clear processed imports.

import { generateImportKey, openImport, type SealedImport } from './ecies';
import { ConflictError, type RepoClient } from './github';
import { applyImport, assertPayload } from './importer';
import type { Ledger } from './ledger';
import { canonical, mergeLedgers } from './merge';

export const LEDGER_PATH = 'ledger.enc.json';
export const INBOX_DIR = 'inbox';
export const PUBLIC_KEY_PATH = 'config/import-public-key.json';

export interface SyncDeps {
  client: RepoClient;
  /** Encrypt the ledger with the household key (file contents). */
  seal: (l: Ledger) => Promise<string>;
  /** Decrypt the synced file; throws if it belongs to a different household key. */
  open: (text: string) => Promise<Ledger>;
  device: string;
}

export interface SyncResult {
  ledger: Ledger;
  imported: number;
  pushed: boolean;
}

export async function syncLedger(local: Ledger, deps: SyncDeps): Promise<SyncResult> {
  const { client } = deps;
  for (let attempt = 0; ; attempt++) {
    const remoteFile = await client.getFile(LEDGER_PATH);
    const remote = remoteFile ? await deps.open(remoteFile.text) : null;
    let merged = remote ? mergeLedgers(local, remote) : mergeLedgers(local, local);

    if (!merged.importKeys?.length) merged = { ...merged, importKeys: [await generateImportKey()] };

    // Bank imports waiting for us.
    const inbox = await client.listDir(INBOX_DIR);
    const processed: typeof inbox = [];
    let imported = 0;
    for (const entry of inbox.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = await client.getFile(entry.path);
      if (!file) continue;
      try {
        const payload = await openImport(JSON.parse(file.text) as SealedImport, merged.importKeys ?? []);
        assertPayload(payload);
        const res = applyImport(merged, payload);
        merged = res.ledger;
        imported += res.added;
        processed.push({ ...entry, sha: file.sha });
      } catch (e) {
        console.warn(`Skipping import ${entry.name}:`, (e as Error).message);
      }
    }

    let pushed = false;
    if (!remote || canonical(merged) !== canonical(remote)) {
      try {
        await client.putFile(LEDGER_PATH, await deps.seal(merged), remoteFile?.sha, `Sync from ${deps.device}`);
        pushed = true;
      } catch (e) {
        if (e instanceof ConflictError && attempt < 4) continue; // the other phone saved first; merge again
        throw e;
      }
    }

    // Publish the import public key (oldest key wins, so both phones agree).
    const current = merged.importKeys![0];
    const keyFile = await client.getFile(PUBLIC_KEY_PATH);
    const wanted = JSON.stringify({ kid: current.kid, publicJwk: current.publicJwk }, null, 2) + '\n';
    if (!keyFile || keyFile.text !== wanted) {
      try {
        await client.putFile(PUBLIC_KEY_PATH, wanted, keyFile?.sha, 'Update import public key');
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }

    // Imports are now safely inside the synced ledger.
    for (const entry of processed) await client.deleteFile(entry.path, entry.sha, 'Imported');

    return { ledger: merged, imported, pushed };
  }
}
