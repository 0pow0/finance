// Test helpers: an in-memory stand-in for the GitHub data repo.
import { ConflictError, type RepoClient, type RepoEntry, type RepoFile } from './github';

export class FakeRepo implements RepoClient {
  files = new Map<string, { sha: string; text: string }>();
  private n = 0;
  /** Called just before a put is applied; lets tests simulate the other phone saving first. */
  beforePut?: (path: string) => void;

  set(path: string, text: string) {
    this.files.set(path, { sha: `sha${++this.n}`, text });
  }
  async getFile(path: string): Promise<RepoFile | null> {
    const f = this.files.get(path);
    return f ? { path, ...f } : null;
  }
  async putFile(path: string, text: string, sha: string | undefined): Promise<string> {
    this.beforePut?.(path);
    const cur = this.files.get(path);
    if ((cur && cur.sha !== sha) || (!cur && sha)) throw new ConflictError();
    this.set(path, text);
    return this.files.get(path)!.sha;
  }
  async deleteFile(path: string, sha: string): Promise<void> {
    if (this.files.get(path)?.sha === sha) this.files.delete(path);
  }
  async listDir(dir: string): Promise<RepoEntry[]> {
    return [...this.files.entries()]
      .filter(([p]) => p.startsWith(dir + '/'))
      .map(([p, f]) => ({ name: p.slice(dir.length + 1), path: p, sha: f.sha }));
  }
}
