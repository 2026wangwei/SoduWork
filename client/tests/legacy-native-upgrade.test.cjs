'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { create } = require('../main/conversation/legacy-native-upgrade.cjs');
const { scope } = require('../main/platform-connections/runtime.cjs');
const { accountScopeKey } = require('../main/device-auth-request');
const { identity } = require('./helpers/platform-session-fixture.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-upgrade-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, user = identity(), id = 'original';
  const archive = path.join(root, 'pi-agent', 'sessions', id + '.jsonl');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const write = value => fs.appendFileSync(archive, JSON.stringify(value) + '\n');
  write({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00Z', cwd: root });
  const add = (id, parentId, role, text) => write({ type: 'message', id, parentId, message: {
    role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { stopReason: 'stop' } : {}) } });
  add('u1', null, 'user', 'First question'); add('a1', 'u1', 'assistant', 'First answer');
  const binding = path.join(root, 'session-memory-bindings', crypto.createHash('sha256').update(id).digest('hex') + '.json');
  fs.mkdirSync(path.dirname(binding));
  fs.writeFileSync(binding, JSON.stringify({ owner: scope(user), ids: [], preserved: 17 }));
  const outbox = require('../main/conversation/account-sync-store').create(path.join(root, 'account-conversations-sync', 'outbox.json'));
  const route = [user.hub, accountScopeKey(user), user.clientId], hash = 'a'.repeat(64);
  outbox.setSession(JSON.stringify([...route, id]), { hub: user.hub, ownerKey: route[1], clientId: user.clientId,
    sourceEpoch: id + ':desktop', sourceSessionId: id, sourceRevision: 2, ackedRevision: 2, contentDigest: hash,
    ackedDigest: hash, conversationId: 'acct-original', legacy: false });
  outbox.saveDirectory(JSON.stringify(route), [{ id: 'acct-original', sourceSessionId: id, sourceClientId: user.clientId,
    canView: true, deleted: false, sourceRevision: 2, revision: 2 }], 2);
  outbox.close();
  const row = { id, cwd: root, path: archive, adapterId: 'pi', title: 'Requirement', at: 100, count: 2 };
  let discoveries = 0, replays = 0;
  function launch(base = path.resolve(__dirname, '..')) {
    const session = {
      findBySessionId: () => null,
      historyEntry: async (_app, wanted) => wanted === id ? { ok: true, entry: row } : { ok: false, notFound: true },
      archivedConversation: async (_app, wanted) => wanted === id ? row : null,
      refreshUpgradeInventory: async () => { discoveries++; await history.register([row]); },
    };
    const history = require(path.join(base, 'main/conversation/shared-history.cjs')).create({ app, session, identityOf: () => user });
    return { history, worker: options => create({ app, session, store: history.store, actor: history.captureScope,
      guard: history.guardScope, backfill: async (...args) => { replays++; return history.backfill(...args); }, ...options }) };
  }
  return { app, user, id, root, archive, binding, add, launch, counts: () => [discoveries, replays] };
}

test('one cohort and one durable conversation survive interruption, concurrent runners, a later turn and a stock restart', async t => {
  const f = fixture(t), initialBytes = fs.readFileSync(f.archive);
  let first = f.launch();
  const interrupted = first.worker({ migrateArtifacts: async () => { throw Error('upgrade interrupted after the body transaction'); } });
  try {
    assert.deepEqual(await interrupted.run(), { completed: 0, deferred: 1 });
    assert.equal((await first.history.store.deviceHistory(f.id)).snapshot.messages.length, 2);
  } finally { await interrupted.close(); await first.history.close(); }

  const a = f.launch(), b = f.launch(), workers = [a.worker(), b.worker()];
  try {
    const passes = await Promise.all(workers.map(worker => worker.run()));
    assert.equal(passes.reduce((sum, state) => sum + state.completed, 0), 1);
    assert.deepEqual(f.counts(), [1, 1], 'a committed body is not converted again after restart');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.binding)), { owner: scope(f.user), ids: [], preserved: 17, hub: f.user.hub });
    assert.deepEqual(fs.readFileSync(f.archive), initialBytes);
    await a.history.store.register([{ id: 'created-after-upgrade', nativeHistory: true, adapterId: 'pi' }]);
    f.add('u2', 'a1', 'user', 'Next question'); f.add('a2', 'u2', 'assistant', 'Next answer');
  } finally {
    await Promise.all(workers.map(worker => worker.close()));
    await Promise.all([a.history.close(), b.history.close()]);
  }
  const reopened = f.launch(), worker = reopened.worker();
  try {
    assert.deepEqual(await worker.run(), { completed: 0, deferred: 0 });
    assert.deepEqual(f.counts(), [1, 1]);
  } finally { await worker.close(); await reopened.history.close(); }

  fs.renameSync(path.join(f.root, 'account-conversations-sync'), path.join(f.root, 'old-sync-backup'));
  const normal = f.launch(process.env.SODUWORK_STOCK_CLIENT || path.resolve(__dirname, '..'));
  try {
    const records = (await normal.history.store.list({ limit: 8 })).items.map(row => row.id).sort();
    assert.deepEqual(records, ['created-after-upgrade', f.id]);
    assert.equal((await normal.history.page({ limit: 8 })).chats.filter(row => row.id === f.id).length, 1);
    const view = await normal.history.open(f.id, { historyPreview: true });
    try {
      const { conversationTranscriptMessages } = require('../main/conversation/conversation-transcript.cjs');
      assert.deepEqual(conversationTranscriptMessages(view.snapshot().messages).map(m => m.text),
        ['First question', 'First answer', 'Next question', 'Next answer']);
    } finally { await view?.close(); }
  } finally { await normal.history.close(); }
});

test('an abrupt process exit releases the original ID for recovery at the next startup', async t => {
  const f = fixture(t), initial = f.launch();
  try {
    await initial.history.store.register([{ id: f.id, cwd: f.root, path: f.archive, adapterId: 'pi', count: 2 }]);
    await initial.history.store.legacyUpgradeInventory(true);
  } finally { await initial.history.close(); }
  const { spawnSync } = require('node:child_process');
  const child = spawnSync(process.execPath, ['-e', `
    const store = require(process.argv[1]).create(process.argv[2]);
    const token = process.pid + '/' + require('node:crypto').randomUUID();
    if (!store.legacyUpgradeClaim('original', token, 'fixture')) process.exit(2);
    process.exit(17);
  `, require.resolve('../main/conversation/replica-store.cjs'), path.join(f.root, 'conversation-replicas', 'history.sqlite')]);
  assert.equal(child.status, 17, child.stderr.toString());
  const next = f.launch(), worker = next.worker();
  try {
    assert.deepEqual(await worker.run(), { completed: 1, deferred: 0 });
    assert.deepEqual(await worker.run(), { completed: 0, deferred: 0 });
    assert.deepEqual((await next.history.store.list({ limit: 8 })).items.map(row => row.id), [f.id]);
    assert.deepEqual(f.counts(), [0, 1]);
  } finally { await worker.close(); await next.history.close(); }
});

test('a partially discovered inventory admits older archives when the Runner returns and excludes new chats', async t => {
  const f = fixture(t), current = f.launch(), store = current.history.store;
  try {
    assert.equal(await store.legacyUpgradeSealed(), false);
    await store.register([{ id: f.id, adapterId: 'pi', at: 100 }]);
    await store.legacyUpgradeInventory(false);
    await store.register([{ id: 'older-runner', adapterId: 'qwen', createdAt: 10, at: Date.now() },
      { id: 'new-chat', adapterId: 'qwen', createdAt: Date.now() + 1000 }]);
    await store.legacyUpgradeInventory(true);
    await store.legacyUpgradeInventory(true);
    assert.deepEqual((await store.legacyUpgradePage('', 'test')).map(row => row.id), ['older-runner', f.id]);
  } finally { await current.history.close(); }
});

test('an interruption after the body commit and before backfill returns does not replay native history twice', async t => {
  const f = fixture(t), first = f.launch();
  let digest;
  const interrupted = first.worker({ backfill: async (...args) => {
    const data = await first.history.backfill(...args);
    digest = data.digest;
    throw Error('desktop stopped before returning the body to the migration worker');
  } });
  try {
    assert.deepEqual(await interrupted.run(), { completed: 0, deferred: 1 });
    assert.ok(digest);
    assert.equal(await first.history.store.deviceHistoryVersion(f.id), digest);
  } finally { await interrupted.close(); await first.history.close(); }

  const next = f.launch(), resumed = next.worker();
  try {
    assert.deepEqual(await resumed.run(), { completed: 1, deferred: 0 });
    assert.deepEqual(f.counts(), [1, 0], 'the new process requires neither a fresh inventory nor another backfill');
    assert.equal(await next.history.store.deviceHistoryVersion(f.id), digest);
    assert.deepEqual(await resumed.run(), { completed: 0, deferred: 0 });
  } finally { await resumed.close(); await next.history.close(); }
});

test('an inventory admits old ISO and numeric-string timestamps and excludes later dates in both encodings', async t => {
  const f = fixture(t), current = f.launch(), store = current.history.store;
  try {
    assert.equal(await store.legacyUpgradeSealed(), false);
    const older = Date.now() - 86400000, later = Date.now() + 86400000;
    const shapes = [['iso', time => new Date(time).toISOString()], ['number-string', String]];
    const entries = shapes.flatMap(([name, timestamp]) => [
      { id: name + '-original', adapterId: 'pi', createdAt: timestamp(older), at: later },
      { id: name + '-last-updated', adapterId: 'pi', at: timestamp(older) },
      { id: name + '-new', adapterId: 'pi', createdAt: timestamp(later), at: older },
      { id: name + '-new-last-updated', adapterId: 'pi', at: timestamp(later) },
    ]);
    await store.register(entries);
    await store.legacyUpgradeInventory(true);
    const expected = shapes.flatMap(([name]) => [name + '-original', name + '-last-updated']).sort();
    assert.deepEqual((await store.legacyUpgradePage('', 'test')).map(row => row.id), expected);
  } finally { await current.history.close(); }
});

test('a stock client reopens the committed SQLite transcript after the original Pi archive is moved away', async t => {
  const f = fixture(t), upgrading = f.launch(), worker = upgrading.worker();
  const expected = [['user', 'First question'], ['assistant', 'First answer']];
  let digest;
  try {
    assert.deepEqual(await worker.run(), { completed: 1, deferred: 0 });
    digest = await upgrading.history.store.deviceHistoryVersion(f.id);
    assert.ok(digest);
  } finally { await worker.close(); await upgrading.history.close(); }
  // Both legacy sources are outside the profile when the independent stock
  // process starts. Keep the migrated owner binding and ordinary SQLite store.
  const offline = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-offline-native-')));
  t.after(() => fs.rmSync(offline, { recursive: true, force: true }));
  fs.renameSync(f.archive, path.join(offline, 'original.jsonl'));
  fs.renameSync(path.join(f.root, 'account-conversations-sync'), path.join(offline, 'old-sync'));

  const base = process.env.SODUWORK_STOCK_CLIENT || path.resolve(__dirname, '..');
  const stock = require('node:child_process').spawnSync(process.execPath, ['-e', `
    const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
    const [base, profile, id, digest] = process.argv.slice(1), user = JSON.parse(process.env.TEST_ACCOUNT);
    const from = file => require(path.join(base, file));
    const app = { getPath: () => profile }, pi = from('main/pi-session/session');
    const session = from('main/agent-runtime/pi-session-bridge').createPiSessionBridge({ app, sessionModule: pi, runnerAdapters: [] });
    const history = from('main/conversation/shared-history.cjs').create({ app, session, identityOf: () => user });
    session.setReplicaHistory(history);
    (async () => {
      let view;
      try {
        assert.equal((await pi.historyEntry(app, id, { strict: true })).notFound, true);
        assert.equal(await session.archivedConversation(app, id, { strict: true, nativeOnly: true }), null);
        assert.equal((await history.store.conversationTranscript(id)).length, 0);
        assert.equal((await history.store.deviceHistory(id)).digest, digest);
        const cards = from('main/conversation/work-conversation-cards').create({
          app, session, sharedHistory: history, identityOf: () => user });
        const loaded = await cards.read(id);
        assert.equal(loaded.ok, true, loaded.reason);
        const page = await history.page({ limit: 5 });
        assert.deepEqual(page.chats.map(row => row.id), [id]);
        view = await history.open(id, { historyPreview: true });
        assert.equal(view.sessionId, id);
        assert.equal(view.readOnly, true);
        assert.deepEqual(view.snapshot().messages.map(message => [message.role, message.text]),
          JSON.parse(process.env.TEST_MESSAGES));
        assert.equal(await history.store.deviceHistoryVersion(id), digest);
        assert.equal(fs.existsSync(path.join(profile, 'pi-agent', 'sessions', id + '.jsonl')), false);
      } finally { await view?.close(); session.closeAll(); await history.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, base, f.root, f.id, digest], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, TEST_ACCOUNT: JSON.stringify(f.user), TEST_MESSAGES: JSON.stringify(expected) } });
  assert.equal(stock.status, 0, String(stock.error || stock.stderr));
});
