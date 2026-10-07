// Minimal GitHub "contents" API client for the private data repo.
// Only encrypted files are ever sent through it.

import { fromB64, toB64 } from './crypto';

export interface RepoFile {
  path: string;
  sha: string;
  text: string;
}

export interface RepoEntry {
  name: string;
  path: string;
  sha: string;
}

export interface RepoClient {
  getFile(path: string): Promise<RepoFile | null>;
  /** Create or update a file. Pass the current sha when updating. Returns the new sha. */
  putFile(path: string, text: string, sha: string | undefined, message: string): Promise<string>;
  deleteFile(path: string, sha: string, message: string): Promise<void>;
  listDir(path: string): Promise<RepoEntry[]>;
}

/** Someone else changed the file since we read it. */
export class ConflictError extends Error {
  constructor() {
    super('The synced file changed while saving.');
  }
}

export class SyncError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function isValidRepo(repo: string): boolean {
  return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo);
}

export class GitHubClient implements RepoClient {
  constructor(private repo: string, private token: string, private fetchImpl: typeof fetch = fetch.bind(globalThis)) {
    if (!isValidRepo(repo)) throw new SyncError('Enter the data repo as owner/name, e.g. yourname/finance-data.');
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.github.com/repos/${this.repo}${path}`, {
        method,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SyncError('Can’t reach GitHub. Check your connection; sync will retry.');
    }
    return res;
  }

  private async fail(res: Response, what: string): Promise<never> {
    const status = res.status;
    if (status === 401) throw new SyncError('The GitHub access token is invalid or expired. Create a new one in Settings → Sync.', status);
    if (status === 403) {
      const text = await res.text().catch(() => '');
      if (/rate limit/i.test(text)) throw new SyncError('GitHub rate limit reached; sync will retry later.', status);
      throw new SyncError('The GitHub token doesn’t have permission. It needs “Contents: Read and write” on the data repo.', status);
    }
    if (status === 404) throw new SyncError('Data repo not found, or the token can’t access it. Check the repo name and token.', status);
    if (status === 409 || status === 422) throw new ConflictError();
    throw new SyncError(`GitHub error ${status} while ${what}.`, status);
  }

  /** Check the repo exists and the token can read it. */
  async check(): Promise<void> {
    const res = await this.call('GET', '');
    if (!res.ok) await this.fail(res, 'checking the repo');
  }

  async getFile(path: string): Promise<RepoFile | null> {
    const res = await this.call('GET', `/contents/${path}`);
    if (res.status === 404) {
      // Distinguish "file missing" from "repo missing": the repo check costs one call only on 404.
      const repo = await this.call('GET', '');
      if (!repo.ok) await this.fail(repo, 'reading the repo');
      return null;
    }
    if (!res.ok) await this.fail(res, `reading ${path}`);
    const json = await res.json();
    let b64: string = json.content ?? '';
    if (json.encoding !== 'base64' || (!b64 && json.size > 0)) {
      // Files over 1 MB come without content; fetch the blob instead.
      const blob = await this.call('GET', `/git/blobs/${json.sha}`);
      if (!blob.ok) await this.fail(blob, `reading ${path}`);
      b64 = (await blob.json()).content;
    }
    return { path, sha: json.sha, text: dec.decode(fromB64(b64.replace(/\s/g, ''))) };
  }

  async putFile(path: string, text: string, sha: string | undefined, message: string): Promise<string> {
    const res = await this.call('PUT', `/contents/${path}`, { message, content: toB64(enc.encode(text)), ...(sha ? { sha } : {}) });
    if (!res.ok) await this.fail(res, `saving ${path}`);
    return (await res.json()).content.sha;
  }

  async deleteFile(path: string, sha: string, message: string): Promise<void> {
    const res = await this.call('DELETE', `/contents/${path}`, { message, sha });
    if (res.status === 404 || res.status === 409 || res.status === 422) return; // already gone or changed; harmless
    if (!res.ok) await this.fail(res, `removing ${path}`);
  }

  async listDir(path: string): Promise<RepoEntry[]> {
    const res = await this.call('GET', `/contents/${path}`);
    if (res.status === 404) return [];
    if (!res.ok) await this.fail(res, `listing ${path}`);
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.filter((e) => e.type === 'file').map((e) => ({ name: e.name, path: e.path, sha: e.sha }));
  }
}
