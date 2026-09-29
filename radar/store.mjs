// The `data` branch of the repo is the shared database for every runner (Mac + GitHub Actions).
// Each publish is a compare-and-swap: push --force-with-lease against the commit we started from,
// so two runners can never silently overwrite each other; the loser re-pulls and replays.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class DataStore {
  constructor({ dir, remote, branch = 'data', log = console.error }) {
    this.dir = dir;
    this.remote = remote;
    this.branch = branch;
    this.log = log;
    this.base = null; // sha of the remote commit our working state is based on
  }

  git(args, opts = {}) {
    return execFileSync('git', ['-C', this.dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      ...opts,
    }).trim();
  }

  ensure() {
    if (!existsSync(join(this.dir, '.git'))) {
      mkdirSync(this.dir, { recursive: true });
      this.git(['init', '-q']);
      this.git(['remote', 'add', 'origin', this.remote]);
    } else {
      this.git(['remote', 'set-url', 'origin', this.remote]);
    }
    this.git(['config', 'user.name', 'jobradar-bot']);
    this.git(['config', 'user.email', 'jobradar-bot@users.noreply.github.com']);
    this.git(['config', 'gc.auto', '0']);
  }

  /** Fetch the latest data commit and check it out. Returns its sha, or null if the branch doesn't exist yet. */
  pull() {
    try {
      this.git(['fetch', '-q', '--depth', '1', 'origin', `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`], { timeout: 120_000 });
    } catch (e) {
      const msg = String(e.stderr || e.message);
      if (/couldn't find remote ref|not found/i.test(msg)) { this.base = null; return null; }
      throw new Error(`git fetch failed: ${msg.slice(0, 300)}`);
    }
    const sha = this.git(['rev-parse', `refs/remotes/origin/${this.branch}`]);
    this.git(['checkout', '-q', '-f', '-B', this.branch, sha]);
    this.git(['clean', '-qfd']);
    this.base = sha;
    return sha;
  }

  /** Cheap remote head check (no download). */
  remoteHead() {
    const out = this.git(['ls-remote', 'origin', `refs/heads/${this.branch}`], { timeout: 60_000 });
    return out.split(/\s+/)[0] || null;
  }

  read(name) {
    const p = join(this.dir, name);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
      this.log(`store: ${name} unreadable (${e.message})`);
      return null;
    }
  }

  /** Commit files on top of `this.base` and CAS-push. Returns { ok, sha } | { conflict: true }. */
  publish(files, message) {
    if (this.base) this.git(['checkout', '-q', '-f', '-B', this.branch, this.base]);
    else {
      try { this.git(['checkout', '-q', '--orphan', this.branch]); } catch { /* already on it */ }
      try { this.git(['rm', '-rqf', '--cached', '.']); } catch { /* empty */ }
    }
    for (const [name, content] of Object.entries(files)) writeFileSync(join(this.dir, name), content);
    this.git(['add', '-A']);
    const dirty = this.git(['status', '--porcelain']);
    if (!dirty) return { ok: true, sha: this.base, noop: true };
    this.git(['commit', '-q', '-m', message]);
    const sha = this.git(['rev-parse', 'HEAD']);
    try {
      this.git(['push', '-q', 'origin', `HEAD:refs/heads/${this.branch}`, `--force-with-lease=refs/heads/${this.branch}:${this.base || ''}`], { timeout: 180_000 });
    } catch (e) {
      const msg = String(e.stderr || e.message);
      if (/stale info|rejected|fetch first|non-fast-forward|failed to push/i.test(msg)) return { conflict: true, msg: msg.slice(0, 300) };
      throw new Error(`git push failed: ${msg.slice(0, 300)}`);
    }
    this.base = sha;
    return { ok: true, sha };
  }

  /** Collapse history to a single commit (keeps the branch small). CAS-protected like publish. */
  squash(message = 'squash data history') {
    const cur = this.pull();
    if (!cur) return { ok: false };
    const tree = this.git(['rev-parse', `${cur}^{tree}`]);
    const orphan = this.git(['commit-tree', tree, '-m', message]);
    try {
      this.git(['push', '-q', 'origin', `${orphan}:refs/heads/${this.branch}`, `--force-with-lease=refs/heads/${this.branch}:${cur}`], { timeout: 180_000 });
    } catch (e) {
      return { ok: false, conflict: true, msg: String(e.stderr || e.message).slice(0, 300) };
    }
    this.base = orphan;
    this.git(['checkout', '-q', '-f', '-B', this.branch, orphan]);
    return { ok: true, sha: orphan };
  }
}
