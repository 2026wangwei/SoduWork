'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const { accountScopeKey } = require('../main/device-auth-request');
const { scope } = require('../main/platform-connections/runtime.cjs');
const outboxStore = require('../main/conversation/account-sync-store');
const sharedHistory = require('../main/conversation/shared-history.cjs');

function fixture(t, { persistent = false, createSession } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-legacy-receipt-'));
  let app, session, history;
  const actor = identity(), otherHub = { ...actor, hub: 'https://old-hub.invalid' };
  const file = path.join(root, 'account-conversations-sync', 'outbox.json');
  const outbox = outboxStore.create(file, { persistent });
  let current = actor;
  const archives = new Map();
  function start() {
    app = { getPath: () => root };
    session = createSession ? createSession(app) : {
      historyEntry: async (_app, id) => archives.has(id) ? { ok: true, entry: archives.get(id) } : { ok: false, notFound: true },
      archivedConversation: async () => null, findBySessionId: () => null,
    };
    history = sharedHistory.create({ app, session, identityOf: () => current });
    session.setReplicaHistory?.(history);
  }
  start();
  t.after(async () => {
    await history.close();
    await session.dispose?.();
    outbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function bind(id, owner, ids) {
    const hash = crypto.createHash('sha256').update(id).digest('hex');
    const folder = path.join(root, 'session-memory-bindings');
    fs.mkdirSync(folder, { recursive: true });
    // The 1.13.13 internal client saved an account fingerprint without a Hub.
    fs.writeFileSync(path.join(folder, hash + '.json'), JSON.stringify({ owner: scope(owner), ids }));
  }

  async function native(id, owner = actor, ids = [], historyAliasIds = []) {
    bind(id, owner, ids);
    const sessions = path.join(root, 'pi-agent', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const archive = path.join(sessions, id + '.jsonl');
    const records = [{ type: 'session', version: 3, id, cwd: root, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'message', id: 'turn', message: { role: 'user', content: 'Fixture' } }];
    fs.writeFileSync(archive, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const row = { id, adapterId: 'pi', count: 1, at: 100, cwd: root, path: archive, historyAliasIds };
    archives.set(id, row);
    await history.register([row]);
  }

  function receipt(id, owner = actor, { acknowledged = true, deleted = false, sourceDevice = owner.clientId } = {}) {
    const ownerKey = accountScopeKey(owner), clientId = owner.clientId;
    const route = [owner.hub, ownerKey, clientId];
    const conversationId = 'acct-' + crypto.createHash('sha256').update(JSON.stringify([...route, id])).digest('hex').slice(0, 32);
    const digest = crypto.createHash('sha256').update(id).digest('hex');
    outbox.setSession(JSON.stringify([...route, id]), {
      sourceEpoch: id + ':desktop', sourceRevision: 2, sourceSessionId: id, hub: owner.hub, clientId, ownerKey,
      contentDigest: digest, digest, legacy: false, ackedRevision: acknowledged ? 2 : 0,
      ...(acknowledged ? { ackedDigest: digest, conversationId } : {}),
    });
    const directoryItem = {
      id: conversationId, sourceSessionId: id, sourceClientId: sourceDevice, sourceRevision: 2,
      contentLocation: 'source', canView: true, canContinue: true, canSend: true,
      deleted, lifecycleRevision: 1, revision: 2,
    };
    const directoryScope = JSON.stringify(route);
    outbox.saveDirectory(directoryScope, [directoryItem], 2);
    return {
      queueUpdate({ attachJob = true, removed = false, previousAck } = {}) {
        const key = JSON.stringify([...route, id]), prior = outbox.session(key);
        const revision = prior.sourceRevision + 1;
        const content = { sourceEpoch: id + ':desktop', sourceSessionId: id, sourceClientId: clientId,
          deleted: removed, snapshotComplete: true, messages: [{ role: 'user', text: 'New turn at ' + revision }] };
        const body = { ...content, sourceRevision: revision };
        const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
        // 1.13.13 discarded the previous ackedDigest and conversationId here.
        const state = { sourceEpoch: body.sourceEpoch, sourceSessionId: id, sourceRevision: revision,
          hub: owner.hub, clientId, ownerKey, ackedRevision: previousAck ?? prior.ackedRevision, digest: hash,
          contentDigest: crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex') };
        const job = { id: key + ':' + revision + ':' + hash.slice(0, 12), hub: owner.hub, ownerKey, clientId, body };
        if (attachJob) outbox.checkpointAndEnqueue(key, state, job);
        else outbox.setSession(key, { ...state, legacy: false });
        return {
          ack: () => outbox.ack(job.id, { conversationId }),
          updateDirectory: () => outbox.saveDirectory(directoryScope, [{ ...directoryItem, sourceRevision: revision, revision }], revision),
        };
      },
      deleteDirectoryItem() {
        outbox.saveDirectory(directoryScope, [{ ...directoryItem, deleted: true, lifecycleRevision: 2, revision: 3 }], 3);
      },
    };
  }

  function outboxSnapshot() {
    const sqlite = file + '.sqlite';
    return { digest: crypto.createHash('sha256').update(fs.readFileSync(sqlite)).digest('hex'),
      mtime: fs.statSync(sqlite, { bigint: true }).mtimeNs };
  }
  return { get app() { return app; }, get history() { return history; }, get session() { return session; },
    actor, otherHub, bind, native, receipt, outboxSnapshot, select: value => { current = value; },
    async restart() { await history.close(); await session.dispose?.(); start(); } };
}

test('desktop history opens the original account’s legacy native rows from confirmed outbound receipts', async t => {
  const f = fixture(t);
  await f.native('ordinary');
  await f.native('private-memory', f.actor, ['selected-memory']);
  for (const id of ['ordinary', 'private-memory']) f.receipt(id);
  const before = f.outboxSnapshot();

  async function expectHistory(visible) {
    const ids = ['ordinary', 'private-memory'];
    const page = await f.history.page({ limit: 10 });
    assert.deepEqual(page.chats.map(row => row.id).sort(), visible ? ids : []);
    for (const id of ids) assert.equal((await f.history.resolve(id))?.id, visible ? id : undefined);
  }
  await expectHistory(true);
  f.select(f.otherHub);
  await expectHistory(false);
  f.select(identity('two'));
  await expectHistory(false);
  f.select(f.actor);
  await expectHistory(true);
  assert.deepEqual(f.outboxSnapshot(), before, 'reading history must preserve the legacy outbox');
});

test('unconfirmed, deleted, conflicting or unrelated source evidence does not grant legacy native access', async t => {
  const f = fixture(t);
  const ids = ['unconfirmed', 'deleted', 'two-hubs', 'foreign-memory', 'foreign-device', 'no-receipt'];
  for (const id of ids) await f.native(id, id === 'foreign-memory' ? identity('two') : f.actor);
  f.receipt('unconfirmed', f.actor, { acknowledged: false });
  f.receipt('deleted', f.actor, { deleted: true });
  f.receipt('two-hubs');
  f.receipt('two-hubs', f.otherHub);
  f.receipt('foreign-memory');
  f.receipt('foreign-device', f.actor, { sourceDevice: 'different-device' });
  const before = f.outboxSnapshot();
  assert.deepEqual((await f.history.page({ limit: 10 })).chats, []);
  for (const id of ids) assert.equal(await f.history.resolve(id), null, id);
  assert.deepEqual(f.outboxSnapshot(), before);
});

test('an open history catalog immediately revokes rows after route conflicts and directory tombstones', async t => {
  // Keep the old writer open so subsequent committed evidence can still be in the WAL.
  const f = fixture(t, { persistent: true });
  const ids = ['conflict', 'tombstone', 'unchanged'];
  for (const id of ids) await f.native(id);
  f.receipt('conflict');
  const receipt = f.receipt('tombstone');
  f.receipt('unchanged');
  const before = await f.history.page({ limit: 10 });
  assert.deepEqual(before.chats.map(row => row.id).sort(), ids);
  assert.deepEqual(before.localCatalog.items.map(row => row.id).sort(), ids);

  f.receipt('conflict', f.otherHub);
  receipt.deleteDirectoryItem();
  const after = await f.history.page({
    limit: 10, workspace: before.localCatalog.workspace, catalogRevision: before.localCatalog.revision,
  });
  assert.deepEqual(after.chats.map(row => row.id), ['unchanged']);
  assert.deepEqual(after.localCatalog.items.map(row => row.id), ['unchanged']);
  assert.equal(await f.history.resolve('conflict'), null);
  assert.equal(await f.history.resolve('tombstone'), null);
  assert.equal((await f.history.resolve('unchanged')).id, 'unchanged');
});

test('a runtime alias with another Hub receipt blocks access through both native identifiers', async t => {
  const f = fixture(t);
  const id = 'conversation', alias = 'later-segment';
  await f.native(id, f.actor, [], [alias]);
  f.receipt(id);
  assert.equal((await f.history.resolve(id)).id, id);
  assert.equal((await f.history.resolve(alias)).id, id);

  f.receipt(alias, f.otherHub);
  assert.deepEqual((await f.history.page({ limit: 10 })).chats, []);
  assert.equal(await f.history.resolve(id), null);
  assert.equal(await f.history.resolve(alias), null);
});

test('opening an upgraded Pi conversation renders the native transcript only on its verified Hub', async t => {
  const f = fixture(t);
  await f.native('legacy-chat');
  f.receipt('legacy-chat');

  const view = await f.history.open('legacy-chat', { historyPreview: true });
  try {
    assert.ok(view);
    assert.ok(view.snapshot().messages.some(row => row.role === 'user' && row.text === 'Fixture'));
    f.select(f.otherHub);
    assert.equal(await f.history.open('legacy-chat', { historyPreview: true }), null);
    assert.throws(() => view.snapshot(), /账号|服务/);
  } finally {
    await view?.close();
  }
});

test('a pure Runner requirement keeps consecutive turns and its work card across reopen, overlapping sync and restart', async t => {
  const id = 'legacy-qwen-ref';
  const runtime = require('../main/runner-runtime');
  const { runtime: spec } = require('../main/agent-runtime/runtime-catalog');
  const { createRunnerRuntimeAdapter } = require('../main/agent-runtime/runner-adapter');
  const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
  const { conversationTranscriptMessages } = require('../main/conversation/conversation-transcript.cjs');
  const events = [{ seq: 1, kind: 'user', text: 'Original requirement' },
    { seq: 2, kind: 'say', streamId: 'answer', text: 'Original answer', done: true }];
  t.mock.method(runtime, 'rpc', async (op, params) => {
    if (op === 'runtime.sessions') return { ok: true, data: { runs: [{ ref: id, cli: 'qwen', taskId: 'chat-' + id,
      state: 'done', seq: events.length, workDir: 'fixture' }] } };
    if (op === 'runtime.detect') return { ok: true, data: { installed: true, state: 'ready' } };
    assert.equal(params.ref, id);
    if (op === 'job.comment') {
      const next = events.length + 1;
      events.push({ seq: next, kind: 'user', text: params.text },
        { seq: next + 1, kind: 'say', streamId: 'answer-' + next, text: 'Reply to ' + params.text, done: true });
      return { ok: true, data: { ok: true, ref: id } };
    }
    assert.equal(op, 'job.session');
    return { ok: true, data: { ref: id, status: 'done', seq: events.length, items: events.filter(item => item.seq > params.since) } };
  });
  const f = fixture(t, { createSession(app) {
    const runner = createRunnerRuntimeAdapter({ app, runtimeSpec: spec('qwen'), runnerRuntime: runtime,
      modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'qwen', name: 'Qwen', key: '', baseUrl: '' } }) },
    });
    return createPiSessionBridge({ app, runnerAdapters: [runner], sessionModule: {
      open() { throw Error('Unexpected Pi session'); }, probe: async () => ({ available: false }),
      history: async () => ({ ok: true, chats: [] }), historyEntry: async () => ({ ok: false, notFound: true }),
    } });
  } });
  f.bind(id, f.actor, []);
  const receipt = f.receipt(id);
  const folder = path.join(f.app.getPath('userData'), 'conversation-work-cards');
  fs.mkdirSync(folder);
  const card = { id: 'requirement-card', actionId: 'work.requirement.create', prompt: 'Original requirement', state: {}, files: [] };
  const file = path.join(folder, crypto.createHash('sha256').update(id).digest('hex') + '.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessionId: id, owner: scope(f.actor), cards: [card] }));
  const readCards = () => require('../main/conversation/work-conversation-cards').create({
    app: f.app, identityOf: async () => f.actor, session: f.session, sharedHistory: f.history,
  }).read(id);
  const { chats } = await f.session.history(f.app, 50);
  assert.deepEqual(chats.map(row => row.id), [id]);
  assert.deepEqual((await f.history.page({ limit: 10 })).chats.map(row => row.id), [id]);
  const read = await readCards();
  assert.equal(read.ok, true, read.reason);
  assert.deepEqual(read.cards, [card]);
  const expected = [{ role: 'user', text: 'Original requirement' }, { role: 'assistant', text: 'Original answer' }];
  const open = () => f.session.open({ adapterId: 'qwen', identity: f.actor, app: f.app, cwd: f.app.getPath('userData'),
    resumePath: id, resumedConversation: true });
  async function continueRequirement(question) {
    const opened = await open();
    assert.equal(opened.ok, true, opened.reason);
    try {
      // The desktop's cached device session can be unavailable when it subscribes to the runtime.
      f.history.observe(opened.session, null);
      await t.waitFor(() => assert.deepEqual(conversationTranscriptMessages(opened.session.uiSnapshot().messages), expected));
      const sent = await opened.session.send(question, []);
      assert.equal(sent.ok, true, sent.reason);
      expected.push({ role: 'user', text: question }, { role: 'assistant', text: 'Reply to ' + question });
      await t.waitFor(() => assert.deepEqual(conversationTranscriptMessages(opened.session.uiSnapshot().messages), expected));
    } finally { await opened.session.close(); }
  }
  async function expectReopen() {
    assert.deepEqual((await f.history.page({ limit: 10 })).chats.map(row => row.id), [id]);
    const restored = await readCards();
    assert.equal(restored.ok, true, restored.reason);
    assert.deepEqual(restored.cards, [card]);
    const reopened = await open();
    assert.equal(reopened.ok, true, reopened.reason);
    try { await t.waitFor(() => assert.deepEqual(conversationTranscriptMessages(reopened.session.uiSnapshot().messages), expected)); }
    finally { await reopened.session.close(); }
    const view = await f.history.open(id, { historyPreview: true });
    try { assert.deepEqual(conversationTranscriptMessages(view.snapshot().messages), expected); }
    finally { await view?.close(); }
  }
  await continueRequirement('Continue the requirement');
  assert.equal((await f.history.store.get(id)).creator, null);
  await expectReopen();
  const pending = receipt.queueUpdate();
  await expectReopen();
  await f.restart();
  await expectReopen();
  pending.ack();
  await expectReopen();
  // The old directory still identifies revision 2 when revision 4 is queued.
  await continueRequirement('Review the completed change');
  const overlapping = receipt.queueUpdate();
  await f.restart();
  await expectReopen();
  pending.updateDirectory();
  await expectReopen();
  overlapping.ack();
  overlapping.updateDirectory();
  await f.restart();
  await expectReopen();
  f.receipt(id, f.otherHub);
  assert.equal((await readCards()).ok, false);
});

test('a switched native Runner segment uses only its persisted logical parent for legacy Hub evidence', async t => {
  const f = fixture(t);
  const access = require('../main/conversation/history-access');
  const segments = require('../main/conversation/runtime-segments');
  const parent = 'old-logical-session', id = 'old-runner-segment';
  await f.native(parent);
  f.receipt(parent);
  const row = { id, path: id, adapterId: 'codex', nativeHistory: true, historyAliasIds: [parent] };
  const check = value => access.assertReadable(f.app, id, access.actor(f.app, f.actor), value);
  assert.throws(() => check(row), /归属/);
  await segments.save(f.app, { version: 1, id: parent, owner: scope(f.actor), originAdapter: 'pi',
    segments: [{ sessionId: parent, adapterId: 'pi' }], active: { sessionId: id, adapterId: 'codex' } });
  assert.doesNotThrow(() => check({ ...row, historyAliasIds: [] }));
  assert.doesNotThrow(() => check({ ...row, historyAliasIds: [], taskIds: ['requirement-task'] }));
  assert.throws(() => access.assertOwner(f.app, id, access.actor(f.app, f.actor), row), /当前账号/);
  assert.throws(() => access.assertReadable(f.app, id, access.actor(f.app, f.otherHub), row), /归属|账号/);
  const secondParent = 'unrelated-logical-session';
  await segments.save(f.app, { version: 1, id: secondParent, owner: scope(f.actor), originAdapter: 'qwen',
    segments: [{ sessionId: secondParent, adapterId: 'qwen' }], active: { sessionId: id, adapterId: 'codex' } });
  assert.throws(() => check(row), /归属/);
  await segments.remove(f.app, secondParent);
  f.receipt(id, f.otherHub);
  assert.throws(() => check(row), /归属|账号/);
});

test('an upgrade accepts only a queued update with a previously confirmed, current source directory entry', async t => {
  const f = fixture(t);
  const ids = ['pending-only', 'unrelated-device', 'absent-job', 'deleting', 'wrong-ack', 'revoked', 'two-routes'];
  for (const id of ids) await f.native(id);
  f.receipt('pending-only', f.actor, { acknowledged: false }).queueUpdate();
  f.receipt('unrelated-device', f.actor, { sourceDevice: 'unrelated-device' }).queueUpdate();
  f.receipt('absent-job').queueUpdate({ attachJob: false });
  f.receipt('deleting').queueUpdate({ removed: true });
  f.receipt('wrong-ack').queueUpdate({ previousAck: 1 });
  const revoked = f.receipt('revoked');
  revoked.queueUpdate(); revoked.deleteDirectoryItem();
  f.receipt('two-routes').queueUpdate();
  f.receipt('two-routes', f.otherHub);
  for (const id of ids) assert.equal(await f.history.resolve(id), null, id);
});

test('an ownerless creator placeholder saved by an old native capture still requires independent original ownership', async t => {
  const f = fixture(t), access = require('../main/conversation/history-access');
  const id = 'legacy-placeholder';
  await f.native(id);
  const row = { id, adapterId: 'qwen', creator: { account: '' }, localReplica: true };
  const verify = (value = row, actor = f.actor) => access.assertDeviceReadable(f.app, id, access.actor(f.app, actor), value);
  await f.history.store.register([row]);
  assert.equal(await f.history.resolve(id), null);
  assert.throws(() => verify(), /归属/);
  f.receipt(id);
  assert.equal((await f.history.resolve(id)).id, id);
  assert.doesNotThrow(() => verify());
  assert.throws(() => verify(row, identity('two')), /归属|账号/);
  assert.throws(() => verify(row, f.otherHub), /归属|账号/);
  for (const changes of [{ cached: true }, { importedHistory: true }, { deviceTransferId: 'transfer' },
    { creator: { account: '', hub: f.otherHub.hub } }, { creator: { account: 'other-user', hub: f.actor.hub } }])
    assert.throws(() => verify({ ...row, ...changes }), /归属|账号/);
  f.receipt(id, f.otherHub);
  assert.throws(() => verify(), /归属|账号/);
});

test('the upgrade commits original native ownership for stock 1.13 readers without creating sessions', async t => {
  const f = fixture(t);
  const { migrate } = require('../main/conversation/legacy-native-ownership.cjs');
  const main = process.env.SODUWORK_STOCK_CLIENT || path.join(__dirname, '..');
  const stockAccess = require(path.join(main, 'main/conversation/history-access'));
  const stockShared = require(path.join(main, 'main/conversation/shared-history.cjs'));
  const rows = [], publicActor = () => stockAccess.actor(f.app, f.actor);
  const file = (folder, id) => path.join(f.app.getPath('userData'), folder, crypto.createHash('sha256').update(id).digest('hex') + '.json');
  await f.native('pi-old', f.actor, ['private-memory']);
  rows.push((await f.session.historyEntry(f.app, 'pi-old')).entry);
  const nativeBytes = fs.readFileSync(rows[0].path);

  for (const adapterId of ['codex', 'dsh', 'qwen', 'kimi', 'opencode', 'claude', 'harness2']) {
    const id = 'old-' + adapterId;
    f.bind(id, f.actor, []);
    rows.push({ id, path: id, adapterId, count: 2 });
  }
  for (const row of rows) {
    f.receipt(row.id);
    const original = JSON.parse(fs.readFileSync(file('session-memory-bindings', row.id)));
    original.settingsFromPriorRelease = { retained: true };
    fs.writeFileSync(file('session-memory-bindings', row.id), JSON.stringify(original));
    await f.history.store.register([{ ...row, creator: { account: '' } }]);
    const run = () => migrate({ app: f.app, store: f.history.store, identity: f.actor, row, assertCurrent() {} });
    assert.equal((await run()).status, 'migrated', row.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(file('session-memory-bindings', row.id))), { ...original, hub: f.actor.hub });
    const indexed = await f.history.store.get(row.id);
    assert.deepEqual(indexed.creator, { account: 'one', hub: f.actor.hub });
    const revision = indexed.revision;
    assert.equal((await run()).status, 'current');
    assert.equal((await f.history.store.get(row.id)).revision, revision);
    assert.doesNotThrow(() => stockAccess.assertReadable(f.app, row.id, publicActor(), row));
    assert.doesNotThrow(() => stockAccess.assertOwner(f.app, row.id, publicActor(), row));
  }
  assert.deepEqual(fs.readFileSync(rows[0].path), nativeBytes);
  // Remove the obsolete receipt store from this temporary profile, so the
  // normal reader cannot benefit from the bridge when reopening the result.
  fs.renameSync(path.join(f.app.getPath('userData'), 'account-conversations-sync'),
    path.join(f.app.getPath('userData'), 'saved-original-receipts'));
  t.mock.method(require(path.join(main, 'main/runner-runtime')), 'rpc', async (op, { ref, since }) => {
    assert.equal(op, 'job.session');
    const items = [{ seq: 1, kind: 'user', text: 'Original request for ' + ref },
      { seq: 2, kind: 'say', streamId: 'answer', text: 'Original answer for ' + ref, done: true }];
    return { ok: true, data: { ref, seq: 2, status: 'done', items: items.filter(it => it.seq > since) } };
  });
  const stock = stockShared.create({ app: f.app, session: { ...f.session,
    archivedConversation: async (_app, id) => rows.find(row => row.id === id) }, identityOf: () => f.actor });
  try {
    assert.deepEqual((await stock.page({ limit: 20 })).chats.map(row => row.id).sort(), rows.map(row => row.id).sort());
    for (const row of rows) {
      const view = await stock.open(row.id, { historyPreview: true });
      try {
        const text = require(path.join(main, 'main/conversation/conversation-transcript.cjs')).conversationTranscriptMessages(view.snapshot().messages);
        if (row.adapterId === 'pi') assert.equal(text[0].text, 'Fixture');
        else assert.deepEqual(text.map(item => item.text), ['Original request for ' + row.id, 'Original answer for ' + row.id]);
      } finally { await view?.close(); }
    }
  } finally { await stock.close(); }
});

test('interrupted ownership migration retries the original parent and segments and rejects conflicts before publication', async t => {
  const f = fixture(t);
  const { migrate } = require('../main/conversation/legacy-native-ownership.cjs');
  const segments = require('../main/conversation/runtime-segments');
  const [id, child] = ['original-logical', 'original-segment'];
  const row = { id, adapterId: 'qwen', path: child, historyAliasIds: [child] };
  const binder = key => path.join(f.app.getPath('userData'), 'session-memory-bindings', crypto.createHash('sha256').update(key).digest('hex') + '.json');
  f.bind(id, f.actor, []);
  f.receipt(id);
  await segments.save(f.app, { version: 1, id, owner: scope(f.actor), originAdapter: 'codex',
    segments: [{ sessionId: id, adapterId: 'codex' }], active: { sessionId: child, adapterId: 'qwen' } });
  await f.history.store.register([{ ...row, creator: { account: '' } }]);
  const run = (identity = f.actor) => migrate({ app: f.app, store: f.history.store, identity, row, assertCurrent() {} });
  const originalBytes = fs.readFileSync(binder(id));
  f.bind(child, identity('two'), []);
  assert.equal((await run()).status, 'unverified');
  assert.deepEqual(fs.readFileSync(binder(id)), originalBytes);
  fs.unlinkSync(binder(child));
  assert.equal((await run(f.otherHub)).status, 'unverified');
  assert.deepEqual(fs.readFileSync(binder(id)), originalBytes);
  const blocked = t.mock.method(fs, 'linkSync', () => { throw Error('Interrupted before publishing child'); });
  await assert.rejects(run(), /Interrupted/);
  blocked.mock.restore();
  assert.equal(JSON.parse(fs.readFileSync(binder(id))).hub, f.actor.hub);
  assert.equal(fs.existsSync(binder(child)), false);
  await f.restart();
  const interrupted = t.mock.method(f.history.store, 'repairLegacyCreator', async () => false);
  await assert.rejects(run(), /重试/);
  interrupted.mock.restore();
  assert.deepEqual(JSON.parse(fs.readFileSync(binder(child))), { owner: scope(f.actor), hub: f.actor.hub, ids: [] });
  assert.equal((await run()).status, 'migrated');
  // A power loss can leave the newly published binding's temporary hard link.
  const residue = path.join(path.dirname(binder(child)), '.' + path.basename(binder(child)) + '.' + crypto.randomUUID() + '.tmp');
  fs.linkSync(binder(child), residue);
  await f.restart();
  assert.equal((await run()).status, 'current');
  assert.equal(fs.existsSync(residue), false);
  assert.deepEqual((await f.history.page({ limit: 10 })).chats.map(item => item.id), [id]);
  assert.equal((await f.history.store.get(child)).id, id);
  const main = process.env.SODUWORK_STOCK_CLIENT || path.join(__dirname, '..');
  const stock = require(path.join(main, 'main/conversation/history-access'));
  for (const key of [id, child])
    assert.doesNotThrow(() => stock.assertReadable(f.app, key, stock.actor(f.app, f.actor), { id: key, path: key, adapterId: 'qwen' }));
});


test('a migration never creates native ownership from names, pending-only evidence, foreign sources or cache locators', async t => {
  const f = fixture(t);
  const { migrate } = require('../main/conversation/legacy-native-ownership.cjs');
  const files = new Map();
  for (const id of ['no-ack', 'foreign', 'tombstone', 'fake-alias', 'cached', 'real-source']) {
    f.bind(id, f.actor, []);
    const file = path.join(f.app.getPath('userData'), 'session-memory-bindings', crypto.createHash('sha256').update(id).digest('hex') + '.json');
    files.set(id, { file, original: fs.readFileSync(file) });
  }
  f.receipt('no-ack', f.actor, { acknowledged: false }).queueUpdate();
  f.receipt('foreign', f.otherHub);
  f.receipt('tombstone').deleteDirectoryItem();
  f.receipt('cached');
  f.receipt('real-source');
  for (const [id, record] of files) {
    if (id === 'real-source') continue;
    const row = { id, path: id, adapterId: 'qwen', ...(id === 'cached' ? { cached: true } : {}),
      ...(id === 'fake-alias' ? { historyAliasIds: ['real-source'] } : {}) };
    const result = await migrate({ app: f.app, store: f.history.store, row, identity: f.actor, assertCurrent() {} });
    assert.equal(result.status, 'unverified', id);
    assert.deepEqual(fs.readFileSync(record.file), record.original);
    assert.equal(await f.history.store.get(id), null);
  }
});

test('a stock-readable native replica with a verified creator keeps its read-only provenance without acquiring a memory binding', async t => {
  const f = fixture(t), id = 'creator-only';
  const row = { id, adapterId: 'qwen', path: id, count: 2 };
  const { migrate } = require('../main/conversation/legacy-native-ownership.cjs');
  const run = (row, actor = f.actor) => migrate({ app: f.app, store: f.history.store, identity: actor, row, assertCurrent() {} });
  // An arbitrary claim without the existing native replica is not evidence.
  const creator = { account: 'one', hub: f.actor.hub };
  assert.equal((await run({ ...row, creator })).status, 'unverified');
  await f.history.store.register([{ ...row, creator }]);
  const saved = await f.history.store.get(id);
  const result = await run(row);
  assert.equal(result.status, 'current');
  assert.equal(result.provenance, 'existing-replica');
  assert.equal((await run(row, identity('two'))).status, 'unverified');
  assert.equal((await run(row, f.otherHub)).status, 'unverified');
  assert.equal(fs.existsSync(path.join(f.app.getPath('userData'), 'session-memory-bindings')), false);
  assert.deepEqual(await f.history.store.get(id), saved);
  const main = process.env.SODUWORK_STOCK_CLIENT || path.join(__dirname, '..');
  const stock = require(path.join(main, 'main/conversation/history-access'));
  assert.doesNotThrow(() => stock.assertReadable(f.app, id, stock.actor(f.app, f.actor), saved));
  assert.throws(() => stock.assertOwner(f.app, id, stock.actor(f.app, f.actor), row));
  const draft = { id: 'existing-native-draft', workOnly: true, adapterId: 'pi',
    workOwner: require('../main/platform-connections/runtime.cjs').legacyScope(f.actor.hub, f.actor.clientId, f.actor) };
  await f.history.store.register([draft]);
  assert.equal((await run(draft)).provenance, 'existing-replica');
  assert.equal((await run({ ...draft, workOwner: scope(f.actor) })).status, 'unverified');
  assert.doesNotThrow(() => stock.assertReadable(f.app, draft.id, stock.actor(f.app, f.actor), draft));
  assert.equal(fs.existsSync(path.join(f.app.getPath('userData'), 'session-memory-bindings')), false);
});
