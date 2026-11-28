'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const picker = require('../main/conversation/history-package-picker.cjs');
const personal = require('../main/personal-plugins');
const sample = require('../e2e/fixtures/created-plugin-history.cjs');

async function fixture(t, kind, { nativeWrites = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'old-generated-package-')));
  const app = { getPath: () => root };
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const id = kind === 'app' ? 'history-app' : 'history-method';
  const { identity } = require('./helpers/platform-session-fixture.cjs');
  let current = identity();
  const dir = path.join(root, 'pi-agent', 'sessions'), archive = path.join(dir, id + '.jsonl');
  const created = await sample.write(root, { id, cwd });
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(cwd, created.find(name => name.endsWith('soduwork-plugin-draft.json')));
  const entries = [{ type: 'session', id, cwd },
    { type: 'message', message: { role: 'user', content: 'Create a package',
      plugins: [{ pluginId: kind === 'app' ? 'local:app-developer' : 'local:plugin-builder' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Created delivery/soduwork-plugin-draft.json' }], stopReason: 'stop' } }];
  if (nativeWrites) {
    const writes = created.flatMap((name, i) => [
      { type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'write-' + i, name: 'write', arguments: { path: name, content: fs.readFileSync(path.join(cwd, name), 'utf8') } }] } },
      { type: 'message', message: { role: 'toolResult', toolName: 'write', toolCallId: 'write-' + i, isError: false, content: [] } }]);
    entries.splice(2, 0, ...writes);
  }
  fs.writeFileSync(archive, entries.map(entry => JSON.stringify(entry)).join('\n'));
  const row = { id, cwd, path: archive, adapterId: 'pi', creator: { account: 'one', hub: current.hub } };
  const session = { historyEntry: async () => ({ ok: true, entry: row }), findBySessionId: () => null, archivedConversation: async () => null };
  const history = require('../main/conversation/shared-history.cjs').create({ app, session, identityOf: () => current,
    store: require('../main/conversation/replica-store.cjs').create(path.join(root, 'replica.db')) });
  t.after(async () => { await history.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await history.register([row]);
  const handle = await history.open(id, { historyPreview: true });
  assert.equal(handle.snapshot().historicalPackageKind, kind);
  assert.equal(handle.readOnly, true);
  if (!nativeWrites) assert.equal(handle.historyArtifacts, undefined, 'the old transcript grants no automatic access to nearby drafts');
  const pick = (file, action) => handle.chooseHistoryPackage({ showOpenDialog: async options => {
    assert.equal(options.defaultPath, cwd); action?.(); return { canceled: !file, filePaths: file ? [file] : [] };
  } });
  return { root, app, cwd, manifest, handle, pick, history, id, session, row, current, select: value => { current = value; } };
}

for (const kind of ['app', 'plugin']) test('authorized legacy ' + kind + ' can review a chosen package from read-only history', async t => {
  const f = await fixture(t, kind);
  assert.deepEqual(await f.pick(), { ok: true, canceled: true });
  const candidate = await f.pick(f.manifest);
  assert.equal(candidate.ok, true);
  assert.equal(candidate.body.template, kind === 'app' ? 'app' : 'method');
  assert.ok(candidate.body.resources.every(resource => resource.content && resource.sha256));
  assert.equal(personal._read(f.app).plugins.length, 0);
  assert.equal(personal.preflight(candidate.body).ok, true);
  personal.create(f.app, candidate.body);
  assert.deepEqual(await f.pick(f.manifest), { ok: true, installed: true });
  await f.handle.close();
  await assert.rejects(f.pick(f.manifest), /关闭/);
});

test('chooser enforces scope, containment, resource hashes and the current account', async t => {
  const f = await fixture(t, 'plugin'), { identity } = require('./helpers/platform-session-fixture.cjs');
  const other = path.join(f.root, 'soduwork-plugin-draft.json');
  fs.copyFileSync(f.manifest, other);
  await assert.rejects(f.pick(other), /越界/);
  const resource = path.join(path.dirname(f.manifest), 'templates', 'review.md');
  fs.unlinkSync(resource); fs.symlinkSync(other, resource);
  await assert.rejects(f.pick(f.manifest), /链接|改变/);
  fs.unlinkSync(resource); fs.linkSync(other, resource);
  await assert.rejects(f.pick(f.manifest), /改变/);
  await assert.rejects(f.pick(f.manifest, () => f.select(identity('two'))), /切换|变化/);
  assert.equal(personal._read(f.app).plugins.length, 0);
});

test('only a selected authoring plugin and a package receipt in its own turn offer a chooser', () => {
  const task = { role: 'user', plugins: [{ pluginId: 'local:app-developer' }] };
  const other = { role: 'user', plugins: [] };
  const answer = { role: 'assistant', text: 'soduwork-plugin-draft.json' };
  assert.equal(picker.authoredKind({ messages: [other, answer] }), undefined);
  assert.equal(picker.authoredKind({ messages: [task, other, answer] }), undefined);
  assert.equal(picker.authoredKind({ messages: [task], tools: [{ name: 'Bash', state: 'error', after: 0, args: { command: 'soduwork-plugin-draft.json' } }] }), undefined);
  assert.equal(picker.authoredKind({ messages: [task], tools: [{ name: 'Bash', state: 'done', after: 0, args: { command: 'soduwork-plugin-draft.json' } }] }), 'app');
});

test('Runner history keeps authoring badges and checks the legacy cursor before exposing its package picker', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-package-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = 'runner-pack', items = [
    { seq: 1, kind: 'user', text: 'Build a plugin', plugins: [{ pluginId: 'local:plugin-builder', name: 'Builder' }] },
    { seq: 2, kind: 'say', text: 'Created delivery/soduwork-plugin-draft.json', done: true }];
  const options = { app: { getPath: () => root }, session: {}, row: { id, adapterId: 'opencode', cwd: root }, guard() {},
    runtime: { rpc: async () => ({ ok: true, data: { ok: true, ref: id, seq: 2, items } }) } };
  const read = require('../main/conversation/device-history-native.cjs').read;
  const saved = await read(options);
  assert.equal(picker.authoredKind(saved.snapshot), 'plugin');
  const old = structuredClone(saved.snapshot); delete old.messages[0].plugins;
  const restored = await read({ ...options, previousSnapshot: old, previousSources: [{ id, adapterId: 'opencode', revision: '2' }] });
  assert.equal(picker.authoredKind(restored.snapshot), 'plugin');
  old.messages[0].text = 'other conversation';
  await assert.rejects(read({ ...options, previousSnapshot: old, previousSources: [{ id, adapterId: 'opencode', revision: '2' }] }), /不一致/);
});

for (const kind of ['app', 'plugin']) for (const nativeWrites of [false, true]) {
  test((nativeWrites ? 'native receipts' : 'confirmed package') + ' persist a standard ' + kind + ' installation card', async t => {
    const f = await fixture(t, kind, { nativeWrites });
    if (!nativeWrites) {
      const initial = await f.history.store.deviceHistoryVersion(f.id);
      const before = await require('../main/conversation/history-package-migration.cjs').inspect({ app: f.app, row: f.row,
        data: await f.history.store.deviceHistory(f.id), assertCurrent() {} });
      assert.deepEqual(before, { complete: false, packages: 0, needsSelection: 1 });
      const store = f.history.store, worker = 'fixture-upgrade';
      await store.legacyUpgradeInventory(true);
      assert.ok(await store.legacyUpgradeClaim(f.id, worker, 'owner'));
      const catalog = await store.get(f.id);
      const { digest, savedAt, ...body } = await store.deviceHistory(f.id);
      const checkpoint = await store.saveDeviceHistory(f.id, body, {
        expectedRevision: catalog.replicaRevision, expectedHistoryDigest: digest,
        expectedCatalogRevision: catalog.revision, requireCatalogRevision: true, expectedTransferId: '',
        legacyUpgrade: { worker, owner: 'owner', registration: { deviceHistory: true, historyContentState: 'available' } },
      });
      assert.equal(checkpoint.ok, true);
      assert.equal(checkpoint.digest, initial);
      assert.ok(await store.legacyUpgradeComplete(f.id, worker, 'owner', checkpoint.digest, before.needsSelection, 0));
      await store.legacyUpgradeRelease(f.id, worker);
      assert.ok((await f.pick(f.manifest)).body);
      const db = new (require('node:sqlite').DatabaseSync)(path.join(f.root, 'replica.db'), { readOnly: true });
      try {
        const ledger = db.prepare('SELECT body, done, needs_selection FROM upgrade_11321_native WHERE id=?').get(f.id);
        assert.equal(ledger.done, 1);
        assert.equal(ledger.body, initial, 'resolving the missing package retains the original migration receipt');
        assert.equal(ledger.needs_selection, 0);
      } finally { db.close(); }
      const recorded = await f.history.store.deviceHistoryVersion(f.id);
      assert.notEqual(recorded, initial);
      assert.ok((await f.pick(f.manifest)).body);
      assert.equal(await f.history.store.deviceHistoryVersion(f.id), recorded, 'a repeated selection keeps the generation');
    }
    const stored = await f.history.store.deviceHistory(f.id);
    assert.ok(stored.localArtifactHistory?.archive.files.length, 'the package bytes were committed before reopening');
    const after = await require('../main/conversation/history-package-migration.cjs').inspect({ app: f.app, row: f.row,
      data: stored, assertCurrent() {} });
    assert.deepEqual(after, { complete: true, packages: 1, needsSelection: 0 });
    await f.handle.close();
    fs.rmSync(f.cwd, { recursive: true });
    // CI uses the current standard reader. An explicitly supplied clean release
    // runs its independent SQLite worker, archive reader, and installation code.
    const published = process.env.SODUWORK_STOCK_CLIENT || path.resolve(__dirname, '..');
    const child = require('node:child_process').spawnSync(process.execPath, ['-e', `
      const path = require('path'), assert = require('node:assert/strict');
      const [client, profile, id, kind] = process.argv.slice(1);
      const from = file => require(path.join(client, file));
      const app = { getPath: () => profile }, current = JSON.parse(process.env.TEST_ACCOUNT);
      const row = JSON.parse(process.env.TEST_ROW), identityOf = () => current;
      const session = { historyEntry: async () => ({ ok: true, entry: row }), findBySessionId: () => null, archivedConversation: async () => null };
      const store = from('main/conversation/replica-store.cjs').create(path.join(profile, 'replica.db'));
      (async () => {
        const history = from('main/conversation/shared-history.cjs').create({ app, session, store, identityOf });
        try {
          const handle = await history.open(id, { historyPreview: true });
          const outputs = await handle.historyArtifacts.snapshotAsync();
          const cards = outputs.items.filter(file => file.pluginDraft && !file.pluginSuperseded && file.pluginValidation?.state === 'ready');
          assert.equal(cards.length, 1);
          const reply = await from('main/pi-session/plugin-draft').readSessionAsync(handle, cards[0].artifactId, app, identityOf);
          assert.equal(reply.ok, true, reply.reason);
          assert.equal(reply.body.template, kind === 'app' ? 'app' : 'method');
          assert.ok(reply.body.resources.every(row => row.content && row.sha256));
          const personal = from('main/personal-plugins');
          assert.equal(personal._read(app).plugins.length, 0);
          assert.equal(personal.preflight(reply.body).ok, true);
          assert.equal(personal.create(app, reply.body).plugin.key, reply.body.key);
          await handle.close();
        } finally { await history.close(); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, published, f.root, f.id, kind], { encoding: 'utf8', timeout: 15000,
      env: { ...process.env, TEST_ACCOUNT: JSON.stringify(f.current), TEST_ROW: JSON.stringify(f.row) } });
    assert.equal(child.status, 0, String(child.error || child.stderr));
  });
}

test('historical ZIP is retained with a stock package extension and a different same-name draft cannot replace a receipt', async t => {
  const f = await fixture(t, 'plugin');
  const exported = path.join(f.cwd, 'review.zip');
  const author = { getPath: () => path.join(f.root, 'test-export') };
  const chosen = await f.pick(f.manifest);
  const plugin = personal.create(author, chosen.body).plugin;
  await personal.exportToFile(author, { showSaveDialog: async () => ({ canceled: false, filePath: exported }) }, plugin.pluginId);
  assert.ok((await f.pick(exported)).body);
  const record = await f.history.store.deviceHistory(f.id);
  assert.ok(record.localArtifactHistory.archive.files.some(row => /recovered-packages\/[a-f0-9]{64}\.soduwork-plugin$/.test(row.relative)));
  const changed = JSON.parse(fs.readFileSync(f.manifest));
  changed.key += '-other';
  fs.writeFileSync(f.manifest, JSON.stringify(changed));
  await assert.rejects(f.pick(f.manifest), /变化/);
  assert.equal(await f.history.store.deviceHistoryVersion(f.id), record.digest);
});

test('a catalog change while archiving a selected package aborts the SQLite commit', async t => {
  const f = await fixture(t, 'plugin'), store = f.history.store;
  const original = await store.deviceHistoryVersion(f.id);
  const save = store.saveDeviceHistory.bind(store);
  t.mock.method(store, 'saveDeviceHistory', async (id, value, expectations) => {
    assert.equal(expectations.requireCatalogRevision, true);
    const previous = await store.get(id);
    assert.equal(expectations.expectedCatalogRevision, previous.revision);
    await store.register([{ ...previous, title: 'Changed elsewhere' }]);
    return save(id, value, expectations);
  });
  await assert.rejects(f.pick(f.manifest), /变化/);
  assert.equal(await store.deviceHistoryVersion(f.id), original);
  assert.equal((await store.deviceHistory(f.id)).localArtifactHistory, undefined);
  assert.equal(personal._read(f.app).plugins.length, 0);
});
