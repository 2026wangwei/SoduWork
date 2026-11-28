'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const journal = require('../main/conversation/file-change-journal');
const archive = require('../main/conversation/device-artifact-archive.cjs');
const { capture } = require('../main/conversation/device-history-artifacts.cjs');
const { migrate } = require('../main/conversation/legacy-upgrade-artifacts.cjs');

async function fixture(t) {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-upgrade-media-')));
  let store;
  t.after(() => {
    store?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  });
  const cwd = path.join(profile, 'workspace');
  fs.mkdirSync(cwd);
  const app = { getPath: () => profile }, id = 'existing-session';
  const file = path.join(profile, 'conversation-replicas', 'history.sqlite');
  store = require('../main/conversation/replica-store.cjs').create(file);
  const [row] = store.register([{ id, cwd, adapterId: 'pi' }]);
  const before = await journal.snapshot(cwd);
  const bytes = new Map([
    ['report.pdf', Buffer.from('%PDF-1.7\noriginal')],
    ['screen.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZsAAAAASUVORK5CYII=', 'base64')],
  ]);
  for (const [name, content] of bytes) fs.writeFileSync(path.join(cwd, name), content);
  const changes = journal.compare(before, await journal.snapshot(cwd), { turnId: 'old-untimed-directory-scan' });
  const collected = await capture({ row, journal: changes });
  const assertCurrent = () => {};
  const receipts = await archive.preserve(profile, id, collected, null, assertCurrent);
  assert.equal(receipts.archive.versions?.length || 0, 0);
  const snapshot = { messages: [{ role: 'user', text: 'report', id: 'original-message-1' },
    { role: 'assistant', text: 'report.pdf', id: 'original-message-2' }], tools: [] };
  const body = { coverage: { complete: true, sources: [{ id, adapterId: 'pi' }] }, snapshot, localArtifactHistory: receipts };
  assert.ok(store.saveDeviceHistory(id, body, { expectedRevision: row.replicaRevision }).ok);
  assert.ok(store.saveConversationTranscript(id, snapshot.messages, {
    expectedRevision: row.replicaRevision, expectedCatalogRevision: row.revision, expectedTransferId: '',
  }).ok);
  return { profile, app, row, store, file, snapshot, assertCurrent, bytes, data: store.deviceHistory(id) };
}

test('legacy PNG and PDF originals survive a cold release reader, same-name replacements and repeated upgrade', async t => {
  const f = await fixture(t), id = f.row.id;
  const transcript = f.store.conversationTranscriptDigest(id);
  for (const name of f.bytes.keys()) fs.writeFileSync(path.join(f.row.cwd, name), 'replacement');
  const migrated = await migrate(f);
  const data = f.store.deviceHistory(id);
  assert.deepEqual(migrated, { complete: true, digest: data.digest, versionsAdded: 2, unavailable: 0 });
  assert.deepEqual(await migrate({ ...f, data }), { ...migrated, versionsAdded: 0 });
  assert.equal(f.store.deviceHistoryVersion(id), data.digest);
  const released = process.env.SODUWORK_STOCK_CLIENT || path.join(__dirname, '..');
  const cold = require(path.join(released, 'main/conversation/replica-store.cjs')).create(f.file);
  try {
    const saved = cold.deviceHistory(id);
    assert.deepEqual(saved.snapshot, f.snapshot);
    assert.equal(cold.conversationTranscriptDigest(id), transcript);
    const versions = require(path.join(released, 'main/conversation/artifact-versions.cjs'));
    const groups = await versions.readers(f.profile, id, saved.localArtifactHistory.archive, f.assertCurrent);
    assert.equal(groups.length, 2);
    for (const group of groups) {
      assert.match(group.turnId, /^pi-archive:[a-f0-9]{64}$/);
      assert.equal(group.userMessageIndex, undefined);
      const [item] = group.reader.snapshot().items;
      assert.ok(group.reader.verify(item.path));
      assert.deepEqual(fs.readFileSync(item.path), f.bytes.get(item.relative));
    }
  } finally { cold.close(); }
});

test('unsigned, foreign or damaged media do not acquire retrievable versions', async t => {
  const f = await fixture(t);
  const history = f.data.localArtifactHistory;
  fs.writeFileSync(path.join(archive.location(f.profile, f.row.id, history.archive), 'screen.png'), 'damaged');
  const pdf = history.items.find(item => item.metadata.relative === 'report.pdf');
  pdf.source.sessionId = 'not-this-session';
  const { digest: previous, savedAt, ...body } = f.data;
  assert.ok(f.store.saveDeviceHistory(f.row.id, body, { expectedHistoryDigest: previous, expectedRevision: f.row.replicaRevision }).ok);
  f.data = f.store.deviceHistory(f.row.id);
  const digest = f.store.deviceHistoryVersion(f.row.id);
  assert.deepEqual(await migrate(f), { complete: true, digest, versionsAdded: 0, unavailable: 2 });
  assert.equal(f.store.deviceHistoryVersion(f.row.id), digest);
  assert.equal((await migrate({ ...f, row: { ...f.row, taskId: 'protected' } })).unavailable, 2);
});

test('a concurrent source update or principal change leaves the original archive intact', async t => {
  const f = await fixture(t);
  const args = { ...f, data: { ...f.data, digest: 'stale-replica-digest' } };
  await assert.rejects(migrate(args), { code: 'HISTORY_CONCURRENT_UPDATE' });
  let checks = 0;
  await assert.rejects(migrate({ ...f, assertCurrent() { if (++checks === 3) throw Error('account changed'); } }), /account changed/);
  assert.equal(f.store.deviceHistoryVersion(f.row.id), f.data.digest);
});

test('a missing gallery image is counted once without opening a path or enrolling the conversation again', async () => {
  const fence = String.fromCharCode(96).repeat(3);
  const text = 'soduwork-media' + fence + 'json\n{"type":"image","items":[{"url":"shots/missing.png"}]}\n' + fence;
  const data = { digest: 'same', snapshot: { messages: [
    { role: 'user', text }, { role: 'assistant', text }, { role: 'assistant', blocks: [{ kind: 'text', text }] },
  ] } };
  assert.deepEqual(await migrate({ data, assertCurrent() {} }), { complete: true, digest: 'same', versionsAdded: 0, unavailable: 1 });
});
