'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const { scope } = require('../main/platform-connections/runtime.cjs');
const workCards = require('../main/conversation/work-conversation-cards');

async function fixture(t, switched = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stopped-runner-work-')));
  const app = { getPath: () => root }, account = identity(), id = 'logical', nativeId = switched ? 'qwen-segment' : id;
  let current = account, piError = false, running = false;
  t.mock.method(require('../main/conversation/requirement-context'), 'cachedIdentity', () => current);
  const runtime = require('../main/runner-runtime');
  t.mock.method(runtime, 'hasLocalTransport', () => false);
  t.mock.method(runtime, 'rpc', async op => {
    assert.equal(op, 'runtime.sessions');
    if (!running) throw Object.assign(Error('Runner is not running'), { code: 'RUNNER_NOT_RUNNING' });
    return { ok: true, data: { runs: [] } };
  });
  const historyEntry = async (_app, wanted) => piError ? { ok: false, reason: 'Pi index failure' } :
    switched && wanted === id ? { ok: true, entry: { id, adapterId: 'pi', workOwner: scope(account) } } :
      { ok: false, notFound: true };
  const session = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({ app, sessionModule: {
    historyEntry, probe: async () => ({ available: false }), open() { throw Error('Unexpected execution'); } }, runnerAdapters: [], historyAdapters: [{
    id: 'qwen',
    historyEntry: async () => ({ ok: false, reason: 'Runner unavailable', chats: [] }) }] });
  const history = require('../main/conversation/shared-history.cjs').create({ app, session, identityOf: () => current });
  t.after(async () => { session.closeAll(); await history.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const row = { id, nativeHistory: true, adapterId: 'qwen', deviceHistory: true, historyContentState: 'available',
    creator: { account: 'one', hub: current.hub }, workOwner: scope(account), cwd: root };
  const [saved] = await history.register([row]);
  if (switched) await require('../main/conversation/runtime-segments').save(app, {
    version: 1, id, originAdapter: 'pi', owner: scope(account), hub: account.hub, segments: [{ sessionId: id, adapterId: 'pi' }],
    active: { sessionId: nativeId, adapterId: 'qwen' } });
  const sources = [...(switched ? [{ id, adapterId: 'pi', revision: 'a'.repeat(64) }] : []),
    { id: nativeId, adapterId: 'qwen', revision: '4' }];
  const messages = ['Original requirement', 'Original answer', 'Second question', 'Second answer']
    .map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text }));
  const body = { snapshot: { messages, tools: [] }, coverage: { complete: true, sources }, historyProtection: 'account' };
  assert.ok((await history.store.saveDeviceHistory(id, body, { expectedRevision: saved.replicaRevision })).ok);
  const card = { id: 'private', actionId: 'work.requirement.create', prompt: 'Private requirement', state: {}, seed: {}, files: [] };
  const file = workCards.location(app, id), mem = path.join(root, 'session-memory-bindings', path.basename(file));
  fs.mkdirSync(path.dirname(mem)); fs.writeFileSync(mem, JSON.stringify({ owner: scope(account), hub: account.hub, ids: [] }));
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, JSON.stringify({ version: 1, sessionId: id, owner: scope(account), cards: [card] }));
  const cards = workCards.create({ app, identityOf: async () => current, sharedHistory: history, session });
  const source = fs.readFileSync(require.resolve('../main/pi-session/ipc'), 'utf8');
  const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false,
    getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href } };
  const ctx = vm.createContext({ app, session, _sharedHistory: history, _cloudHandoff: {}, _sessionOwners: null,
    require: name => require(path.join(__dirname, '../main/pi-session', name)), BrowserWindow: { fromWebContents: () => ({}) },
    _attach() {}, _wire() {}, _openReply: handle => ({ ok: true, handle }) });
  vm.runInContext(source.slice(source.indexOf('  async function openConversation('), source.indexOf("  ipcMain.handle('pi-session-open',")), ctx);
  return { id, history, cards, card, file, mem, messages, account,
    open: (options = {}) => ctx.openConversation(event, { chatId: id, historyIntent: 'view', ...options }),
    select: value => { current = value; }, piFailure: () => { piError = true; }, online: () => { running = true; } };
}

for (const switched of [false, true]) test('stopped Runner opens retained private requirement read-only after ' +
    (switched ? 'a Pi-to-Runner switch' : 'a native Runner reopen'), async t => {
  const f = await fixture(t, switched);
  const original = [f.file, f.mem].map(file => fs.readFileSync(file, 'utf8'));
  const digest = await f.history.store.deviceHistoryVersion(f.id);
  const read = await f.cards.read(f.id);
  assert.equal(read.ok, true, read.reason); assert.equal(read.readOnly, true);
  assert.deepEqual(read.cards, [f.card]);
  const opened = await f.open();
  assert.equal(opened.ok, true, opened.reason);
  const view = opened.handle;
  assert.deepEqual(view.snapshot().messages.map(message => message.text), f.messages.map(message => message.text));
  assert.equal(view.snapshot().execution.canContinueOnDevice, false);
  assert.equal((await view.send('Unexpected mutation')).accepted, false);
  assert.equal((await f.open({ historyIntent: 'continue' })).ok, false);
  assert.equal((await f.cards.save(f.id, { ...f.card, prompt: 'Changed' })).ok, false);
  assert.equal(await f.history.store.deviceHistoryVersion(f.id), digest);
  assert.deepEqual([f.file, f.mem].map(file => fs.readFileSync(file, 'utf8')), original);
  f.select(identity('two'));
  assert.throws(() => view.snapshot(), /账号|会话/);
  assert.equal((await f.cards.read(f.id)).ok, false); assert.equal((await f.open()).ok, false);
  f.select({ ...f.account, hub: 'https://other.invalid' });
  assert.equal((await f.cards.read(f.id)).ok, false); assert.equal((await f.open()).ok, false);
  f.select(f.account); await view.close();
  f.online(); assert.equal(await f.history.stoppedRunnerRequirement(f.id), null);
});

test('stopped Runner cannot mask a failed Pi index or restore a deleted private card', async t => {
  const f = await fixture(t);
  f.piFailure();
  assert.equal((await f.cards.read(f.id)).ok, false); assert.equal((await f.open()).ok, false);
  await f.history.store.lifecycle(f.id, 'delete');
  assert.equal((await f.cards.read(f.id)).ok, false); assert.equal((await f.open()).ok, false);
});
