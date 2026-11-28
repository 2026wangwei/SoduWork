'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const journal = require('../main/conversation/file-change-journal');
const artifacts = require('../main/conversation/device-history-artifacts.cjs');
const storage = require('../main/conversation/device-artifact-archive.cjs');
const versions = require('../main/conversation/artifact-versions.cjs');
const runtime = require('../main/conversation/artifact-runtime');
const gallery = require('../main/conversation/history-gallery.cjs');
const links = require('../components/panels/chat-output-links');

async function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-gallery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'), cwd = path.join(root, 'project');
  fs.mkdirSync(profile); fs.mkdirSync(cwd);
  const row = { id: 'gallery-chat', cwd, adapterId: 'pi' };
  const text = ['```soduwork-media', JSON.stringify({ type: 'gallery', items: [{ url: 'shared.png' }, { url: 'missing.png' }] }), '```'].join('\n');
  const messages = ['user', 'assistant', 'user', 'assistant'].map(role => role === 'assistant' ? { role, blocks: [{ kind: 'text', text }] } : { role });
  const snapshot = { localReplica: true, messages };
  let history, allowed = true;
  const guard = () => { if (!allowed) throw Error('view closed'); };
  const guards = { guard, authorize: async () => guard() };
  async function deliver(turnId, index, files, verifiedTurn = true) {
    const before = await journal.snapshot(cwd);
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), bytes);
    const changes = journal.compare(before, await journal.snapshot(cwd), { turnId });
    changes.userMessageIndex = index;
    const next = await artifacts.capture({ row, previous: history, journal: changes, verifiedTurn });
    history = await storage.preserve(profile, row.id, next, history, guard);
  }
  async function open(ref, scope) {
    const view = { ref, cwd, sessionId: row.id, localReplica: true, snapshot: () => snapshot,
      historyArtifacts: artifacts.archivedView(profile, row.id, cwd, history, guard, guards.authorize) };
    runtime.bindTurnArchives(view, () => versions.readers(profile, row.id, history.archive, guard, guards.authorize));
    const files = await gallery.initial({ profile, row, history, view, guards, scope });
    return { view, files, read: id => runtime.action(view, ref, id, 'image-full', {}) };
  }
  return { snapshot, open, deliver, revoke: () => { allowed = false; } };
}

test('initial gallery and full output index select the same archived image in each turn', async t => {
  const f = await fixture(t);
  await f.deliver('one', 0, { 'shared.png': 'first image', 'other.md': '# Notes' });
  await f.deliver('two', 2, { 'shared.png': 'second image' });
  const { view, files, read } = await f.open('first-open', 'principal+revision');
  const full = runtime.decorate(view.ref, await runtime.viewSnapshotAsync(view), view);
  assert.deepEqual(files.filter(f => f.versionId), full.filter(f => f.versionId && f.relative === 'shared.png'));
  assert.equal(files.some(f => f.relative === 'missing.png' || f.relative === 'other.md'), false);
  assert.deepEqual(links.deliveryTurns(f.snapshot, files), links.deliveryTurns(f.snapshot, full));
  for (const [turn, bytes] of [['one', 'first image'], ['two', 'second image']]) {
    const select = index => links.filesForTurn(index, turn, turn === 'two').filter(file => file.relative === 'shared.png');
    assert.deepEqual(select(files).map(file => file.artifactId), select(full).map(file => file.artifactId));
    assert.equal(select(files).length, 1);
    assert.equal((await read(select(files)[0].artifactId)).data, Buffer.from(bytes).toString('base64'));
  }
});

test('a later unversioned original does not replace an earlier turn’s same-name screenshot', async t => {
  const f = await fixture(t);
  await f.deliver('one', 0, { 'shared.png': 'first version' });
  await f.deliver('scan', 2, { 'shared.png': 'newer original from an unversioned scan' }, false);
  await f.deliver('two', 2, { 'other.md': '# Document' });
  const { view, files, read } = await f.open('mixed-images', 'revision');
  const full = runtime.decorate(view.ref, await runtime.viewSnapshotAsync(view), view);
  for (const [index, current] of [[1, false], [3, true]]) {
    const select = entries => links.filesForTurn(entries, links.deliveryTurns(f.snapshot, entries)[index], current)
      .filter(file => file.relative === 'shared.png').map(file => file.artifactId);
    assert.deepEqual(select(files), select(full));
    assert.equal(select(files).length, 1);
    assert.equal((await read(select(files)[0])).data,
      Buffer.from(current ? 'newer original from an unversioned scan' : 'first version').toString('base64'));
  }
});

test('an unrelated receipt claiming the same message boundary defers to the full index', async t => {
  const f = await fixture(t);
  await f.deliver('pi-history:image', 0, { 'shared.png': 'image' });
  await f.deliver('another-turn', 0, { 'unrelated.md': '# From another turn' });
  const { view, files } = await f.open('ambiguous', 'revision');
  assert.deepEqual(files, []);
  assert.ok((await runtime.viewSnapshotAsync(view)).items.some(item => item.relative === 'shared.png' && item.versionId));
});

test('a fresh view can reuse encoded bytes only after verifying its principal, revision and file', async t => {
  const f = await fixture(t);
  await f.deliver('one', 0, { 'shared.png': 'archived image' });
  const first = await f.open('first', 'owner-1-revision-1');
  const id = first.files.find(f => f.versionId).artifactId;
  const read = t.mock.method(fs, 'readSync');
  const original = await first.read(id);
  assert.ok(original.ok);
  assert.ok(read.mock.callCount() > 0);
  const reopen = await f.open('reopen', 'owner-1-revision-1');
  read.mock.resetCalls();
  assert.deepEqual(await reopen.read(id), original);
  assert.equal(read.mock.callCount(), 0);
  const changed = await f.open('changed', 'owner-2-revision-2');
  read.mock.resetCalls();
  assert.deepEqual(await changed.read(id), original);
  assert.ok(read.mock.callCount() > 0);
  fs.writeFileSync(original.path, 'changed image');
  assert.equal((await reopen.read(id)).ok, false);
  f.revoke();
  await assert.rejects(reopen.read(id), /view closed/);
  await assert.rejects(f.open('another', 'owner-1-revision-1'), /view closed/);
});
