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

function fixture(t, { persistent = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-legacy-receipt-'));
  const app = { getPath: () => root };
  const actor = identity(), otherHub = { ...actor, hub: 'https://old-hub.invalid' };
  const file = path.join(root, 'account-conversations-sync', 'outbox.json');
  const outbox = outboxStore.create(file, { persistent });
  let current = actor;
  const archives = new Map();
  const session = {
    historyEntry: async (_app, id) => archives.has(id) ? { ok: true, entry: archives.get(id) } : { ok: false, notFound: true },
    archivedConversation: async () => null, findBySessionId: () => null,
  };
  const history = sharedHistory.create({ app, session, identityOf: () => current });
  t.after(async () => {
    await history.close();
    outbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function native(id, owner = actor, ids = [], historyAliasIds = []) {
    const hash = crypto.createHash('sha256').update(id).digest('hex');
    const folder = path.join(root, 'session-memory-bindings');
    fs.mkdirSync(folder, { recursive: true });
    // The 1.13.13 internal client saved an account fingerprint without a Hub.
    fs.writeFileSync(path.join(folder, hash + '.json'), JSON.stringify({ owner: scope(owner), ids }));
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
  return { actor, otherHub, history, native, receipt, outboxSnapshot, select: value => { current = value; } };
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
