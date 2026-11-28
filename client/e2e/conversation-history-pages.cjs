'use strict';

const electron = require('electron');
const { isolateProfile, withTemporaryRoot } = require('./lib/isolated-profile.cjs');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = withTemporaryRoot('soduwork-history-pages-', temp => require('node:child_process').spawnSync(electron, [__filename], {
    env: { ...env, TEMP: temp, TMP: temp, TMPDIR: temp }, stdio: 'inherit', windowsHide: true, timeout: 180000 }));
  if (run.error) console.error(run.error.message);
  process.exit(run.status ?? 1);
}

const { app, BrowserWindow, ipcMain } = electron;
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto'), { pathToFileURL } = require('node:url');
const { userData: profile } = isolateProfile(app, 'history-pages');
const client = path.resolve(__dirname, '..');
app.disableHardwareAcceleration();
let win, history;
const js = expression => win.webContents.executeJavaScript(expression, true);
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const marker = (id, index) => id + ' message ' + index + '.';
const list = '#nchatList';
const node = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
const contains = (selector, text) => node(selector) + '?.textContent.includes(' + JSON.stringify(text) + ')';
async function until(condition, description) {
  for (const deadline = Date.now() + 12000; Date.now() < deadline; ) {
    if (await js(condition)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const status = await js("JSON.stringify({older:document.querySelector('[data-load-older]')?.textContent,page:document.querySelector('[data-history-status]')?.textContent,notices,errors})");
  throw Error(description + ' · ' + status);
}
async function scrollEarlier(anchorSelector) {
  return js(`(async () => {
    const scroll = document.querySelector('#nchatScroll');
    scroll.focus(); scroll.scrollTop = 0;
    const selector = ${JSON.stringify(anchorSelector || '')};
    const offset = selector ? document.querySelector(selector).getBoundingClientRect().top : null;
    scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
    await new Promise(resolve => requestAnimationFrame(resolve));
    return offset;
  })()`);
}
const enter = id => js("NativeChat.enter(''," + JSON.stringify(id) + ")");

app.whenReady().then(async () => {
  const actor = require('../tests/helpers/platform-session-fixture.cjs').identity();
  const owner = require('../main/platform-connections/runtime.cjs').scope(actor);
  const directory = path.join(profile, 'pi-agent', 'sessions', 'fixture');
  fs.mkdirSync(directory, { recursive: true });
  const rows = [['history-short', 106], ['history-medium', 302], ['history-long', 2184]].map(([id, count]) => {
    const entries = [{ type: 'session', id }];
    for (let index = 0; index < count; index++) {
      // The initial window starts inside the last turn of the medium archive.
      // Its user's saved timestamp is needed to display the final reply duration.
      const longTurn = id === 'history-medium' && index >= 200;
      const question = longTurn ? index === 200 : index % 2 === 0;
      const turn = longTurn ? 100 : Math.floor(index / 2);
      const elapsedMs = longTurn ? Math.round(23000 * (index - 200) / (count - 201)) : question ? 0 : 23000;
      const timestamp = Date.UTC(2026, 0, 1) + turn * 60000 + elapsedMs;
      let content = [{ type: 'text', text: marker(id, index) }];
      if (id === 'history-long' && index === 131) content[0].text += '\n\nsoduwork-media```json\n' +
        '{"type":"gallery","items":[{"url":"shots/hero.png"},{"url":"shots/missing.png"}]}\n```\n\n**Gallery verified**';
      if (id === 'history-long' && index === 135) content = [{ type: 'thinking', thinking: 'Saved early reasoning' }];
      if (id === 'history-long' && index === 137)
        content.push({ type: 'toolCall', id: 'cancelled-edit', name: 'edit', arguments: { path: 'fixture.txt' } });
      entries.push({ type: 'message', id: 'm' + index, parentId: index ? entries.at(-1).id : null,
        timestamp: new Date(timestamp).toISOString(), message: { role: question ? 'user' : 'assistant', timestamp,
          content, ...(question ? {} : { completedAt: timestamp, stopReason: 'stop' }) } });
      if (id === 'history-long' && index === 137) entries.push({ type: 'message', id: 'edit-result', parentId: 'm137',
        message: { role: 'toolResult', toolName: 'edit', toolCallId: 'cancelled-edit', timestamp, content: [], isError: false,
          details: { soduWorkAccessChange: { state: 'cancelled', cancelReason: 'access-change' } } } });
    }
    const archive = path.join(directory, id + '.jsonl');
    fs.writeFileSync(archive, entries.map(item => JSON.stringify(item)).join('\n') + '\n');
    return { id, path: archive, adapterId: 'pi', title: id, count, cwd: profile, workOwner: owner,
      creator: { account: 'one', hub: actor.hub } };
  });
  const initialDigests = rows.map(row => digest(row.path));
  const session = { findBySessionId: () => null, historyEntry: require('../main/pi-session/session').historyEntry,
    archivedConversation: async (_app, id) => rows.find(row => row.id === id) };
  require('../main/conversation/requirement-context').cachedIdentity = () => actor;
  const store = require('../main/conversation/replica-store.cjs').create(path.join(profile, 'history.sqlite'));
  history = require('../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => actor });
  await history.register(rows);
  const views = new Map(), reads = [];
  let intercept, galleryRef;
  function holdNextRead() {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    intercept = async payload => {
      started.resolve(payload);
      return { ok: true, snapshot: await release.promise || payload.snapshot };
    };
    return { started: started.promise, release: release.resolve };
  }
  ipcMain.handle('pi-session-open', async (_event, options) => {
    assert.equal(options.historyIntent, 'view');
    const view = await history.open(options.chatId, { historyPreview: true, allowContinuation: true });
    if (options.chatId === 'history-long') galleryRef = view.ref;
    views.set(view.ref, view);
    return require('../main/pi-session/open-reply').openReply(app, view);
  });
  ipcMain.handle('pi-session-release', async (_event, ref) => { await views.get(ref)?.close(); views.delete(ref); return { ok: true }; });
  ipcMain.handle('pi-session-snapshot', async (_event, ref, options = {}) => {
    const view = views.get(ref), snapshot = await view.loadHistory(options) || view.snapshot();
    if (options.messageLimit) reads.push({ options, start: snapshot.history.messageStart, end: snapshot.history.messageEnd });
    if (options.messageLimit && intercept) {
      const reply = intercept; intercept = null; return reply({ ref, snapshot });
    }
    return { ok: true, snapshot };
  });
  const galleryFiles = Promise.withResolvers();
  ipcMain.handle('pi-session-outputs', async (_event, ref) => ({
    ok: true, artifacts: ref === galleryRef ? await galleryFiles.promise : [],
  }));
  ipcMain.handle('pi-session-artifact-action', (_event, ref, id, action) => {
    assert.equal(ref, galleryRef);
    assert.equal(id, 'hero-130');
    assert.equal(action, 'image-full');
    const image = electron.nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1 });
    return { ok: true, mimeType: 'image/png', data: image.toPNG().toString('base64') };
  });
  for (const [channel, reply] of Object.entries({ 'pi-session-open-application': { ok: true, handled: false },
    'pi-session-history': { ok: true, chats: rows },
    'pi-session-runtimes': { ok: true, runtimes: [{ id: 'pi' }], availableRuntimes: [{ id: 'pi' }] },
    'access-preferences-get': { ok: true, mode: 'standard' }, 'work-preview-hide': { ok: true },
    'work-preview-destroy': { ok: true }, 'work-preview-reset-embedded': { ok: true } })) ipcMain.handle(channel, () => reply);

  const fixture = path.join(__dirname, 'fixtures/workbench-annotations.html');
  const html = fs.readFileSync(fixture, 'utf8')
    .replace('<script src="../../vendor/markdown/purify.min.js">', '<script src="../../core/markdown.js"></script>' +
      '<script src="../../components/panels/chat-media.js"></script><script src="../../vendor/markdown/purify.min.js">')
    .replace('<title>', '<link rel="stylesheet" href="../../components/panels/chat-collaboration.css"><title>')
    .replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' +
    pathToFileURL(path.dirname(fixture) + path.sep).href + '">').replace('<script src="../../components/panels/chat-message-renderer.js">', tag =>
    ['compose-candidate-navigation', 'chat-plugin-mention-model', 'chat-plugin-mention', 'chat-turn-summary', 'chat-reading-position']
      .map(name => '<script src="../../components/panels/' + name + '.js"></script>').join('') + tag);
  const file = path.join(profile, 'long-history.html');
  fs.writeFileSync(file, html);
  win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(client, 'preload.js'),
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  await win.loadFile(file);
  await js("SoduWorkAPI.taskStorageKey=()=> 'fixture'; SoduWorkAPI.myModels=async()=>({usable:[{name:'fixture-model'}]}); void 0");

  for (const row of rows) {
    assert.equal(await enter(row.id), true);
    await until(contains(list, marker(row.id, row.count - 1)), 'Latest message visible');
    if (row.id === 'history-short') {
      const firstMessage = node('[data-message-owner="0"]'), scroll = node('#nchatScroll');
      assert.equal(await js(contains(list, marker(row.id, 0))), false);
      assert.equal(await js(node('[data-history-load]') + '.checkVisibility()'), true);
      assert.equal(await js(node('[data-history-load]') + '.textContent'), '加载更早记录（26 条更早消息）');
      await js(node('[data-history-load]') + '.click()');
      await until(contains(list, marker(row.id, 0)), 'First click recovers all 26 earlier messages inline');
      await until(firstMessage + '.getBoundingClientRect().top < ' + scroll + '.getBoundingClientRect().bottom && ' +
        firstMessage + '.getBoundingClientRect().bottom > ' + scroll + '.getBoundingClientRect().top', 'First recovered message in view');
      assert.equal(await js(node('[data-history-load]') + '.checkVisibility()'), false);
      assert.equal(await js('document.querySelector("dialog[open]") === null'), true);
      continue;
    }
    if (row.id === 'history-medium')
      assert.equal(await js(contains(list, marker(row.id, 200))), false, 'The first screen omits the beginning of this turn');
    await until(contains('.nturn-summary', '23s'), 'Completed turn has its archived elapsed time');
    const region = '.nchat-archive', status = '[data-history-status]';
    const first = region + ' [data-history-index]';
    const delayed = row.id === 'history-medium' ? holdNextRead() : null;
    if (delayed) {
      const button = node('[data-history-load]');
      assert.equal(await js(button + '.checkVisibility()'), true);
      const previousReads = reads.length;
      await js(button + '.click(); ' + button + '.click()');
      await delayed.started;
      assert.equal(reads.length, previousReads + 1, 'Two clicks share the pending read');
      assert.equal(await js('document.querySelector("dialog[open]") === null'), true);
    } else await scrollEarlier();
    if (delayed) {
      // Deliver a newer same-ref publication while the one live expansion is held.
      const { ref, snapshot } = await delayed.started;
      const final = { ...snapshot.messages.at(-1), text: 'Newly settled reply',
        blocks: [{ kind: 'text', text: 'Newly settled reply', done: true }] };
      win.webContents.send('pi-session-event', { ref, kind: 'settled', snapshot: { ...snapshot, status: 'idle',
        messages: [...snapshot.messages.slice(0, -1), final] } });
      await until(contains(list, final.text), 'Settled publication reaches the selected chat');
      delayed.release({ ...snapshot, status: 'streaming' });
      await until(node(status) + '.textContent === ""', 'Older request completes');
      assert.equal(await js(contains(list, final.text)), true);
      assert.equal(await js('NativeChat.isBusy()'), false);
    }
    const liveStart = row.count - 160;
    await until(contains(list, marker(row.id, liveStart)), 'One expanded live window');
    await until(node(status) + '.textContent === ""', 'Anchor has settled');
    assert.equal(reads.at(-1).options.messageLimit, 160);
    if (delayed) {
      // A byte-limited page may be shorter than requested: resume at the
      // boundary actually returned, including when it cuts through a turn.
      intercept = ({ snapshot }) => ({ ok: true, snapshot: { ...snapshot,
        messages: snapshot.messages.slice(40), history: { ...snapshot.history,
          messageStart: snapshot.history.messageIndices[40], messageIndices: snapshot.history.messageIndices.slice(40) } } });
      for (const start of [102, 22, 0]) {
        await scrollEarlier(); await until(contains(first, marker(row.id, start)), 'Byte-limited page boundary');
        if (start > 0) assert.equal(await js(node('[data-history-load]') + '.textContent'), '加载更早记录（' + start + ' 条更早消息）');
      }
      assert.equal(await js('document.querySelectorAll("[data-history-index]").length'), liveStart);
      assert.equal(await js(node('[data-history-load]') + '.checkVisibility()'), false);
      continue;
    }
    for (let end = liveStart; end > 184; end -= 80) {
      const owner = '[data-message-owner="' + liveStart + '"]';
      const before = await scrollEarlier(end === liveStart ? owner : '');
      await until(contains(first, marker(row.id, end - 80)), 'Cursor page above live window');
      assert.deepEqual(reads.at(-1).options, { messageEnd: end, messageLimit: 80, toolLimit: 160 });
      if (end === liveStart) {
        const after = await js(node(owner) + '.getBoundingClientRect().top');
        assert.ok(Math.abs(after - before) <= 2, 'First prepend retains the live anchor: ' + JSON.stringify({ before, after }));
      }
    }
    intercept = () => ({ ok: false, reason: 'Page read interrupted' });
    await scrollEarlier();
    await until(contains(status, '加载失败'), 'Inline failure, retry by scrolling up again');
    await scrollEarlier();
    await until(contains(first, marker(row.id, 104)), 'Nearest prior page is above the live transcript');
    const saved = '[data-history-index="131"]';
    assert.equal(await js(contains(saved + ' strong', 'Gallery verified')), true);
    assert.equal(await js(contains(saved, 'soduwork-media')), false);
    galleryFiles.resolve([130, 200].map(userMessageIndex => ({
      artifactId: 'hero-' + userMessageIndex, originalArtifactId: 'hero', versionId: 'v' + userMessageIndex,
      turnId: 'pi-history:' + userMessageIndex, userMessageIndex, name: 'hero.png', relative: 'shots/hero.png',
    })));
    await until(node(saved + ' .noutput-gallery [data-output-image="hero-130"]') + ' !== null',
      'Late artifact index restores the archived gallery with the version from the saved turn');
    await js(node(saved + ' .noutput-gallery') + '.scrollIntoView({block:"center"})');
    await until(node(saved + ' .noutput-gallery img') + '?.naturalWidth === 1', 'Chromium decodes the archived screenshot');
    assert.equal(await js(contains(saved + ' .noutput-image-missing', 'shots/missing.png')), true);
    assert.equal(await js(node(saved + ' [data-output-image="hero-200"]') + ' === null'), true);
    assert.equal(await js(contains(region + ' > :last-child', '用时 23s')), true);
    assert.equal(await js(contains(region, 'Saved early reasoning')), true);
    await js('[...' + node(region) + '.querySelectorAll("summary")].find(item => item.textContent.includes("权限已调整，未执行")).click()');
    await until(contains(region + ' details[open] pre', '此操作在执行前因权限调整而取消'), 'Read the archived tool receipt inline');
    const anchorSelector = '[data-history-index="104"]';
    const anchorTop = await scrollEarlier(anchorSelector);
    await until(contains(first, marker(row.id, 24)), 'Previous page');
    const geometry = await js(`(()=>{const scroll=document.querySelector('#nchatScroll');return {
      anchor:document.querySelector('${anchorSelector}').getBoundingClientRect().top, top:scroll.scrollTop,
      viewport:scroll.clientHeight, height:scroll.scrollHeight, follow:scroll.__soduworkScrollFollow?.follow
    }})()`);
    assert.ok(Math.abs(geometry.anchor - anchorTop) <= 2,
      'Prepending a page retains the viewport offset: ' + JSON.stringify({ anchorTop, ...geometry }));
    await scrollEarlier(); await until(contains(first, marker(row.id, 0)), 'First message');
    const indices = await js('Array.from(document.querySelectorAll("[data-history-index]"), row => Number(row.dataset.historyIndex))');
    assert.deepEqual(indices, Array.from({ length: liveStart }, (_, index) => index), 'Every older message appears once in order');
    assert.equal(await js(node(first) + '.querySelector("[data-copy-message]").getAttribute("data-copy-message")'), marker(row.id, 0));
    await js(`Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async text => { window.copiedHistoryText = text; } } });
      document.querySelector('.nchat-archive [data-copy-message]').click()`);
    await until('window.copiedHistoryText === ' + JSON.stringify(marker(row.id, 0)), 'Archived copy uses the message text');
    assert.equal(await js(contains(list, marker(row.id, liveStart - 1))), false, 'The live window remains bounded');
    assert.equal(await js('document.querySelector("dialog[open]") === null'), true);
    const readCount = reads.length;
    await scrollEarlier(); assert.equal(reads.length, readCount, 'Stop when all messages are visible');
    // The live projection skips internal messages; raw owners need not be consecutive.
    const live = views.get(await js('NativeChat.sessionInfo().ref'));
    const snapshot = await live.loadHistory({ messageLimit: 160, toolLimit: 320 }) || live.snapshot();
    assert.equal(snapshot.history.messageStart, liveStart);
    const readingIndex = await js('NativeChat.readingPosition().anchor.index');
    const owners = snapshot.history.messageIndices.map((owner, i) => i ? owner + 1 : owner);
    const publishTail = offset => win.webContents.send('pi-session-event', { ref: live.ref, kind: 'settled',
      snapshot: { ...snapshot, messages: snapshot.messages.slice(offset), history: { ...snapshot.history,
        totalMessages: owners.at(-1) + 1, messageEnd: owners.at(-1) + 1,
        messageStart: owners[offset], messageIndices: owners.slice(offset) } } });
    publishTail(0);
    await until(node('[data-message-owner="' + owners.at(-1) + '"]') + ' !== null', 'Sparse projection rendered');
    publishTail(1);
    await until(node('[data-message-owner="' + owners[0] + '"]') + ' === null', 'Live tail advances across the hidden message');
    assert.equal(await js(contains(region, marker(row.id, liveStart))), true, 'Displaced visible message joins the archive');
    assert.equal(await js('NativeChat.readingPosition().anchor.index'), readingIndex, 'Sparse live updates preserve earlier pages');
    win.webContents.send('pi-session-event', { ref: live.ref, kind: 'settled', snapshot });
    await until(node('[data-message-owner="' + liveStart + '"]') + ' !== null', 'Original live tail restored');
    await js("document.querySelector('.nchat-jump-latest').click()");
    await until("document.querySelector('#nchatScroll').__soduworkScrollFollow.follow", 'Return to latest');
    await js("window.dispatchEvent(new Event('soduwork-data-scope-changed'))");
    const abandoned = holdNextRead();
    await scrollEarlier(); await abandoned.started;
    await js("document.querySelector('.nchat-jump-latest').click()");
    abandoned.release();
    await until(node(status) + '.textContent === ""', 'Abandoned page request finishes');
    assert.equal(await js(node(region) + ' === null'), true, 'A late page cannot displace the jump to latest');
    const pending = holdNextRead();
    await scrollEarlier(); await pending.started;
    await js("window.dispatchEvent(new Event('soduwork-data-scope-changed'))");
    pending.release();
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await js(node(region) + ' === null'), true, 'Discard a page returned after an account switch');

    const beforeRestore = reads.length;
    assert.equal(await js('NativeChat.restoreReadingPosition({follow:false,messageStart:184,messageLimit:2000,anchor:{index:104,offset:0}})'), true);
    const restoreReads = reads.slice(beforeRestore);
    assert.ok(restoreReads.length > 1 && restoreReads.every(read => read.options.messageLimit <= 160),
      'Recover old bookmarks without restoring the entire 2,000-message live window');
    assert.equal(await js('NativeChat.readingPosition().anchor.index'), 104);
  }
  assert.deepEqual(rows.map(row => digest(row.path)), initialDigests);
  assert.deepEqual(await js('errors'), []);
  console.log('PASS historical paging, elapsed time, reasoning, cancelled tools, retry, account switch and late snapshot handling.');
}).catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await history?.close(); win?.destroy(); app.exit(process.exitCode || 0); });
