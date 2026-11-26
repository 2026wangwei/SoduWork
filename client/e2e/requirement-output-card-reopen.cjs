'use strict';

// Real result card, delegated mouse handling and native Chromium file preview with isolated task bytes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, WebContentsView } = electron;
  const client = path.resolve(__dirname, '..'), ref = 'accepted-task-session';
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'requirement-output-card-')));
  const cwd = path.join(root, 'work'), file = path.join(cwd, 'index.html');
  fs.mkdirSync(cwd);
  fs.writeFileSync(file, '<!doctype html><title>Requirement output</title><h1>Accepted website</h1>');
  const page = { id: 'page', taskId: 'task', filename: 'index.html', role: 'output', size: fs.statSync(file).size };
  const handle = { cwd, ref, sessionId: ref, snapshot: () => ({ status: 'idle' }) };
  app.setPath('userData', path.join(root, 'profile'));
  app.on('window-all-closed', () => {});
  async function until(fn, label) {
    for (let i = 0; i < 150; i++) {
      if (await fn()) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error('Timed out: ' + label);
  }
  async function check() {
    require('../main/agent-runtime/pi-session-bridge').get = id => id === ref ? handle : null;
    require('../main/work-preview').install({ app, ipcMain, BrowserWindow, WebContentsView });

    const fixture = path.join(root, 'requirement-preview.html');
    const scripts = ['chat-output-links', 'chat-dom-patch', 'panels-chat-tools', 'chat-workspace-info',
      'chat-workspace-split', 'chat-workspace-controls', 'panels-chat-workspace', 'library-transfer', 'chat-composer-bindings'];
    fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8"><base href="${pathToFileURL(client + path.sep).href}">
      <link rel="stylesheet" href="theme/variables.css"><link rel="stylesheet" href="components/panels/panels-chat.css">
      <link rel="stylesheet" href="components/panels/library-transfer.css">
      <style>body{margin:0}#chat,.nchat-stage{height:100vh}.nchat-stage{display:flex}.nchat-main{flex:1;min-width:0;padding:22px}</style>
      <main class="nchat" id="chat"><div class="nchat-stage"><section class="nchat-main">
      <div id="nchatList"><div class="nmsg user">制作网页</div><div class="nmsg ai" data-output-task="task"><div class="nmd">index.html</div></div></div>
      <div hidden><textarea id="nchatInput"></textarea><button id="nchatSend"></button><div id="nchatQueue"></div><div id="nchatTaskSuggest"></div></div>
      </section></div></main>${scripts.map(name => '<script src="components/panels/' + name + '.js"></script>').join('')}`);
    const win = new BrowserWindow({ show: false, width: 1100, height: 700, webPreferences: {
      preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const js = code => win.webContents.executeJavaScript(code, true);
    // Stub the Hub attachment transfer and saved-library receipt; the production
    // resolver, card, click bindings and native preview operate on a real HTML file.
    let preparations = 0;
    ipcMain.handle('attachment-materialize', (event, input) => {
      assert.equal(event.sender, win.webContents);
      assert.deepEqual([input.ref, input.taskId, input.attachmentId], [ref, page.taskId, page.id]);
      preparations++;
      return { ok: true, artifacts: [{ attachmentId: page.id, path: file, name: page.filename, size: page.size }] };
    });
    async function click(selector) {
      const point = await js(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const rect = el.getBoundingClientRect();
        const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        if (!el.contains(document.elementFromPoint(point.x, point.y))) throw Error('Click target is covered: ' + el.className);
        return point;})()`);
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    }
    const visiblePage = () => win.contentView.children.find(view => view.getVisible() && view.webContents?.getTitle() === 'Requirement output');
    async function verifyOpened(label) {
      await until(visiblePage, label);
      assert.equal(await visiblePage().webContents.executeJavaScript('document.querySelector("h1").textContent'), 'Accepted website');
    }
    try {
      await win.loadFile(fixture);
      await js(`(async()=>{
        const root = document.querySelector('#chat'), list = root.querySelector('#nchatList');
        const page = ${JSON.stringify(page)}, ref = ${JSON.stringify(ref)};
        const api = { outputs: async () => ({ ok: true, files: [] }) };
        window.SoduWorkAPI = { listAttachments: async () => [page], taskStorageKey: () => 'isolated-owner',
          libraryOutputKey: () => 'saved-page', getLibraryOutputStatus: async () => ({ item: { id: 'saved-page' } }) };
        const snapshot = { status: 'idle', messages: [{ role: 'user', text: '制作网页' },
          { role: 'assistant', taskId: page.taskId, done: true, text: 'index.html' }] };
        const files = await ChatOutputLinks.load(api, ref, [page.taskId], [], SoduWorkAPI);
        ChatComposerBindings.create({ _ref: ref, _api: () => api, _wd: { dir: ${JSON.stringify(cwd)} }, _paintBar() {} })._bind(root);
        LibraryTransfer.decorateOutputs(list, files, ref, snapshot);
        ChatWorkbench.render(root, snapshot, files);
      })()`);
      const row = '.noutput-library-row';
      await until(() => js(`!!document.querySelector('${row} .library-save-action.is-saved')`), 'saved requirement output card');
      await verifyOpened('automatically opened task attachment');
      for (const target of ['.noutput-library-name', '.noutput-library-file-icon']) {
        await click('[data-wb-close]');
        await until(async () => !await js('ChatWorkbench.state().open') && !visiblePage(), 'manual preview close');
        await click(row + ' ' + target);
        await verifyOpened('reopen original task card from ' + target);
      }
      assert.equal(preparations, 1, 'reopening reuses the authorized local file');
    } catch (error) {
      console.error('Task preview diagnostics', { preparations, state: await js('ChatWorkbench.state()'),
        views: win.contentView.children.map(view => ({ visible: view.getVisible(), title: view.webContents.getTitle() })) });
      throw error;
    } finally {
      ipcMain.removeHandler('attachment-materialize');
      win.destroy();
    }
  }
  app.whenReady().then(check).then(() => {
    console.log('Passed: closing the task preview and clicking the original saved card reopens its HTML.');
  }).catch(error => {
    console.error(error); process.exitCode = 1;
  }).finally(async () => {
    require('../main/conversation/artifact-runtime').closeRef(ref);
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    app.exit(process.exitCode || 0);
  });
}
