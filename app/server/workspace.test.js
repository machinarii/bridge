import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';

import {
  projectsBase,
  slugifyName,
  resolveRepoPath,
  ensureRepo,
  writeFiles,
  commitAll,
} from './workspace.js';

// ---------------------------------------------------------------------------
// 1. projectsBase
// ---------------------------------------------------------------------------

test('projectsBase defaults to ~/bridge-projects', () => {
  const saved = process.env.BRIDGE_PROJECTS_BASE;
  delete process.env.BRIDGE_PROJECTS_BASE;
  try {
    assert.equal(projectsBase(), join(homedir(), 'bridge-projects'));
  } finally {
    if (saved !== undefined) process.env.BRIDGE_PROJECTS_BASE = saved;
    else delete process.env.BRIDGE_PROJECTS_BASE;
  }
});

test('projectsBase expands leading ~ in env override', () => {
  const saved = process.env.BRIDGE_PROJECTS_BASE;
  process.env.BRIDGE_PROJECTS_BASE = '~/my-projects';
  try {
    assert.equal(projectsBase(), join(homedir(), 'my-projects'));
  } finally {
    if (saved !== undefined) process.env.BRIDGE_PROJECTS_BASE = saved;
    else delete process.env.BRIDGE_PROJECTS_BASE;
  }
});

test('projectsBase uses absolute env override as-is', () => {
  const saved = process.env.BRIDGE_PROJECTS_BASE;
  process.env.BRIDGE_PROJECTS_BASE = '/tmp/custom-projects';
  try {
    assert.equal(projectsBase(), '/tmp/custom-projects');
  } finally {
    if (saved !== undefined) process.env.BRIDGE_PROJECTS_BASE = saved;
    else delete process.env.BRIDGE_PROJECTS_BASE;
  }
});

// ---------------------------------------------------------------------------
// 2. slugifyName
// ---------------------------------------------------------------------------

test("slugifyName('FinTech app') === 'fintech-app'", () => {
  assert.equal(slugifyName('FinTech app'), 'fintech-app');
});

test('slugifyName collapses consecutive weird chars to single dash', () => {
  assert.equal(slugifyName('Hello  World!!!'), 'hello-world');
});

test('slugifyName strips leading and trailing dashes', () => {
  assert.equal(slugifyName('  --hello--  '), 'hello');
});

test('slugifyName all-invalid chars falls back to project', () => {
  assert.equal(slugifyName('!!!'), 'project');
});

test('slugifyName handles numbers', () => {
  assert.equal(slugifyName('App v2.0'), 'app-v2-0');
});

// ---------------------------------------------------------------------------
// 3. resolveRepoPath — deduplication
// ---------------------------------------------------------------------------

test('resolveRepoPath returns base/slug when no collision', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  process.env.BRIDGE_PROJECTS_BASE = tmpBase;
  try {
    const result = resolveRepoPath('FinTech App');
    assert.equal(result, join(tmpBase, 'fintech-app'));
  } finally {
    delete process.env.BRIDGE_PROJECTS_BASE;
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('resolveRepoPath dedupes by appending -2 when slug folder exists', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  process.env.BRIDGE_PROJECTS_BASE = tmpBase;
  try {
    mkdirSync(join(tmpBase, 'fintech-app'));
    const result = resolveRepoPath('FinTech App');
    assert.equal(result, join(tmpBase, 'fintech-app-2'));
  } finally {
    delete process.env.BRIDGE_PROJECTS_BASE;
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('resolveRepoPath dedupes to -3 when -2 also exists', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  process.env.BRIDGE_PROJECTS_BASE = tmpBase;
  try {
    mkdirSync(join(tmpBase, 'fintech-app'));
    mkdirSync(join(tmpBase, 'fintech-app-2'));
    const result = resolveRepoPath('FinTech App');
    assert.equal(result, join(tmpBase, 'fintech-app-3'));
  } finally {
    delete process.env.BRIDGE_PROJECTS_BASE;
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. ensureRepo
// ---------------------------------------------------------------------------

test('ensureRepo creates the directory and git-inits it', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const repoPath = join(tmpBase, 'my-repo');
  try {
    ensureRepo(repoPath);
    assert.ok(existsSync(repoPath), 'repo dir exists');
    assert.ok(existsSync(join(repoPath, '.git')), '.git exists');
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('ensureRepo is idempotent — second call does not throw', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const repoPath = join(tmpBase, 'my-repo');
  try {
    ensureRepo(repoPath);
    assert.doesNotThrow(() => ensureRepo(repoPath));
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. writeFiles
// ---------------------------------------------------------------------------

test('writeFiles writes nested files and returns the count', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const repoPath = join(tmpBase, 'repo');
  mkdirSync(repoPath);
  try {
    const count = writeFiles(repoPath, [
      { path: 'README.md', contents: '# Hello' },
      { path: 'src/index.js', contents: 'console.log("hi")' },
    ]);
    assert.equal(count, 2);
    assert.ok(existsSync(join(repoPath, 'README.md')));
    assert.ok(existsSync(join(repoPath, 'src', 'index.js')));
    assert.equal(readFileSync(join(repoPath, 'README.md'), 'utf8'), '# Hello');
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('writeFiles rejects ../evil.txt', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const repoPath = join(tmpBase, 'repo');
  mkdirSync(repoPath);
  try {
    assert.throws(
      () => writeFiles(repoPath, [{ path: '../evil.txt', contents: 'bad' }]),
      /unsafe path|path escapes/
    );
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('writeFiles rejects /etc/passwd', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const repoPath = join(tmpBase, 'repo');
  mkdirSync(repoPath);
  try {
    assert.throws(
      () => writeFiles(repoPath, [{ path: '/etc/passwd', contents: 'bad' }]),
      /unsafe path|path escapes/
    );
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('writeFiles rejects a/../../b.txt', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const repoPath = join(tmpBase, 'repo');
  mkdirSync(repoPath);
  try {
    assert.throws(
      () => writeFiles(repoPath, [{ path: 'a/../../b.txt', contents: 'bad' }]),
      /unsafe path|path escapes/
    );
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. commitAll
// ---------------------------------------------------------------------------

test('commitAll commits and returns a short sha, log contains message, status is clean', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const repoPath = join(tmpBase, 'repo');
  try {
    ensureRepo(repoPath);
    writeFiles(repoPath, [{ path: 'hello.txt', contents: 'world' }]);
    const sha = commitAll(repoPath, 'initial scaffold');
    assert.match(sha, /^[0-9a-f]{7,}$/, 'sha is 7+ hex chars');
    const log = execFileSync('git', ['log', '--oneline'], { cwd: repoPath }).toString();
    assert.ok(log.includes('initial scaffold'), 'log contains commit message');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoPath }).toString();
    assert.equal(status.trim(), '', 'working tree is clean after commit');
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

import { commitIfChanged } from './workspace.js';
test('commitIfChanged commits only when there are changes', () => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-ws-'));
  const repo = join(base, 'demo');
  ensureRepo(repo);
  assert.equal(commitIfChanged(repo, 'noop'), null, 'nothing to commit → null');
  writeFiles(repo, [{ path: 'x.txt', contents: 'x\n' }]);
  const sha = commitIfChanged(repo, 'add x');
  assert.match(sha, /^[0-9a-f]{7,}$/);
  assert.equal(commitIfChanged(repo, 'again'), null, 'clean tree → null');
});
