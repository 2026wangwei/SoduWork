'use strict';
// Isolated Electron renderer + production artifact IPC. No real conversations,
// account, model calls or user working directories participate in this fixture.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-current-work-'));
  const out = path.resolve(__dirname, '../../outputs/current-work-output-scope-20261020');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(owned, 'profile'));
  const cwd = path.join(owned, 'project'); fs.mkdirSync(cwd);
  for (const directory of ['first', 'second']) {
    fs.mkdirSync(path.join(cwd, directory));
    fs.writeFileSync(path.join(cwd, directory, 'report.md'), '# ' + directory + '\n\n独立会话的交付正文。');
  }
  const outputs = require('../main/pi-session/outputs');
  const report = { ok: false, cases: [], errors: [], boundary: 'Real Electron and production artifact IPC; isolated shared project and synthetic session snapshots, no business data or model.' };
  const handles = new Map(['first', 'second'].map(id => [id, { cwd, sessionId: id,
    outputSnapshot: () => outputs.scan(cwd, 0, 1), snapshot: () => ({ tools: [] }) }]));
  let win, deviceHistory;
  const js = code => win.webContents.executeJavaScript(code, true);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded control: '+${JSON.stringify(selector)});return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await sleep(220);
  }
  const until = async (fn, label) => {
    for (let count = 0; count < 80; count++) { if (await fn()) return; await sleep(30); }
    throw Error('Timed out: ' + label);
  };
  app.whenReady().then(async () => {
    const bridge = require('../main/agent-runtime/pi-session-bridge');
    const nativeGet = bridge.get;
    bridge.get = ref => handles.get(ref) || nativeGet(ref);
    const identity = require('../tests/helpers/platform-session-fixture.cjs').identity();
    const handoff = require('../main/conversation/cloud-handoff').create({ app, identityOf: () => identity });
    require('../main/pi-session/artifact-ipc').install({ app, ipcMain, BrowserWindow, session: bridge,
      resolveSession: handle => handoff.artifactSession(handle), workDir: () => cwd });
    require('../main/work-preview').install({ app, ipcMain, BrowserWindow, WebContentsView: electron.WebContentsView,
      shell: { openExternal: async () => { throw Error('External navigation is outside this fixture'); } } });
    const client = path.resolve(__dirname, '..');
    const url = file => pathToFileURL(path.join(client, file)).href;
    const scripts = ['chat-dom-patch', 'panels-chat-tools', 'chat-output-links', 'chat-deliveries', 'chat-workspace-info',
      'chat-workspace-split', 'chat-workspace-controls', 'panels-chat-workspace', 'panels-chat-chrome'];
    const html = path.join(owned, 'fixture.html');
    fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>本次工作 · 隔离验证</title>' +
      '<link rel="stylesheet" href="' + url('theme/variables.css') + '">' +
      '<link rel="stylesheet" href="' + url('components/panels/panels-chat.css') + '">' +
      '<link rel="stylesheet" href="' + url('components/panels/code-workbench.css') + '">' +
      '<style>body{margin:0;font:14px system-ui;color:#26262a}#chat{height:100vh}</style>' +
      '<div id="chat" class="nchat"></div>' + scripts.map(file => '<script src="' + url('components/panels/' + file + '.js') + '"></script>').join('') +
      '<script>window.fixtureRoot=document.querySelector("#chat");window.fixtureContext={ref:"first",intent:{cwd:' + JSON.stringify(cwd) + '}};' +
      'fixtureRoot.innerHTML=\'<div class="nchat-stage"><section class="nchat-main">\'+ChatChrome.header()+\'<div class="nchat-content-area">Current conversation</div></section></div>\';' +
      'window.contextValue=()=>fixtureContext;ChatChrome.bind(fixtureRoot,contextValue);ChatWorkbench.bind(fixtureRoot,contextValue);</script>');
    win = new BrowserWindow({ show: false, width: 1280, height: 860,
      webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    await win.loadFile(html);
    await js('(async()=>{window.index=await soduWorkAPI.conversationSession.outputs("first");window.files=index.artifacts;})()');
    assert.equal(await js('files.length'), 2, 'actual shared-directory index retains both historical files');
    const snapshot = id => ({ messages: [{ role: 'user', sentAt: 1000, blocks: [{ kind: 'text', text: '当前工作' }] },
      { role: 'assistant', completedAt: 2000, blocks: [{ kind: 'text', text: '交付 ' + id + '/report.md' }] }], tools: [] });
    await js('ChatWorkbench.render(fixtureRoot,' + JSON.stringify(snapshot('first')) + ',files);ChatChrome.openSummary();void 0');
    assert.equal(await js('document.querySelectorAll("[data-chat-summary-body] button").length'), 1);
    const firstArtifact = await js('files.find(file=>file.relative==="first/report.md").artifactId');
    assert.equal(await js('document.querySelector("[data-chat-summary-body] button").dataset.wbFile'), firstArtifact);
    await until(() => js('document.querySelector(".ncw-body")?.textContent.includes("first")'), 'own auto-preview');
    assert.equal(await js('document.querySelector(".ncw-body").textContent.includes("second")'), false);
    await click('[data-wb-close]');
    assert.equal(await js('document.querySelector(".nchat-summary").hidden'), true, 'clicking the preview controls dismisses the summary');
    await click('[data-chat-summary]');
    await click('[data-chat-summary-body] [data-wb-file]');
    await until(() => js('document.querySelector(".ncw-body")?.textContent.includes("first")'), 'summary file click');
    assert.equal(await js('document.querySelector(".nchat-summary").hidden'), true, 'opening a file dismisses the compact summary');
    const previewBefore = await js('document.querySelector(".ncw").getBoundingClientRect().toJSON()');
    await click('[data-chat-summary]');
    assert.deepEqual(await js('document.querySelector(".ncw").getBoundingClientRect().toJSON()'), previewBefore, 'reopening summary never shrinks the preview');
    assert.equal(await js(`(()=>{const preview=document.querySelector('.ncw').getBoundingClientRect(),panel=document.querySelector('.nchat-summary').getBoundingClientRect(),header=document.querySelector('.nchat-head').getBoundingClientRect();
      return Math.abs(preview.right-innerWidth)<1&&Math.abs(panel.right-(header.right-8))<1;})()`), true, 'preview reaches the window edge and summary stays below chat controls');
    fs.writeFileSync(path.join(out, 'summary-file-preview.png'), (await win.webContents.capturePage()).toPNG());
    await click('[data-chat-summary-close]');
    assert.equal(await js('Math.round(document.querySelector(".ncw").getBoundingClientRect().right)===innerWidth'), true);
    report.cases.push('Native click opens the real file; preview fills the right edge and reopening the summary under chat controls never moves or shrinks either column.');
    report.cases.push('Shared-folder directory scan keeps both files; the current-work summary claims only the current reply result and no unrelated file auto-opens.');
    await js('ChatWorkbench.reset();ChatChrome.reset();fixtureContext.ref="second";' +
      'ChatChrome.bind(fixtureRoot,contextValue);ChatWorkbench.bind(fixtureRoot,contextValue);' +
      'ChatWorkbench.render(fixtureRoot,' + JSON.stringify(snapshot('second')) + ',files);ChatChrome.openSummary();void 0');
    assert.equal(await js('document.querySelector("[data-chat-summary-body] button").dataset.wbFile'),
      await js('files.find(file=>file.relative==="second/report.md").artifactId'));
    report.cases.push('Switching to the other session selects its exact same-name file in another directory.');
    await js('ChatWorkbench.render(fixtureRoot,{messages:[{role:"user",sentAt:3000,blocks:[{kind:"text",text:"开始新的工作"}]}],tools:[]},files);void 0');
    assert.equal(await js('document.querySelectorAll("[data-chat-summary-body] button").length'), 0);
    assert.equal(await js('ChatWorkbench.openOutput(' + JSON.stringify(firstArtifact) + ')'), true);
    await until(() => js('document.querySelector(".ncw-body")?.textContent.includes("first")'), 'historical file content');
    report.cases.push('The next instruction clears the summary while historical files still open through production artifact read IPC.');
    await sleep(180);
    assert.equal(await js('document.querySelectorAll("[data-chat-summary-body] button").length'), 0, 'opening history must not relabel it as current work');
    fs.writeFileSync(path.join(out, 'historical-preview.png'), (await win.webContents.capturePage()).toPNG());
    const journal = require('../main/conversation/file-change-journal');
    const workspaces = require('../main/conversation/delivery-workspace.cjs');
    const workspace = fs.realpathSync.native(cwd), deliveryWorkspace = workspaces.allocate(workspace);
    const draft = workspaces.ensure(workspace, deliveryWorkspace), before = await journal.snapshot(draft);
    const row = { cwd: workspace, id: 'website', adapterId: 'pi', count: 2, at: 1 };
    const session = { historyEntry: async () => ({ ok: false, notFound: true }), archivedConversation: async () => null };
    deviceHistory = require('../main/conversation/shared-history.cjs').create({ app, session, identityOf: () => identity });
    const messages = [{ role: 'user', submissionId: 'web-turn', text: 'Create a website' },
      { role: 'assistant', done: true, text: 'Created index.html' }];
    const handle = bridge.attachView({ ref: row.id, sessionId: row.id, cwd: workspace, deliveryWorkspace,
      historyRow: () => row, snapshot: () => ({ messages, tools: [] }),
      outputSnapshot: () => outputs.scan(draft, 0, 1), close: async () => true });
    deviceHistory.observe(handle, identity);
    fs.writeFileSync(path.join(draft, 'index.html'), '<title>Turn result</title><link rel="stylesheet" href="site.css"><h1>Frozen website</h1>');
    fs.writeFileSync(path.join(draft, 'site.css'), 'h1{color:rgb(111,22,33)}');
    const change = journal.compare(before, await journal.snapshot(draft), { turnId: 'web-turn' });
    await handle.captureArtifactTurn(change);
    fs.writeFileSync(path.join(draft, 'index.html'), '<h1>Later working copy</h1>');
    await js(`(async () => {
      ChatWorkbench.reset(); ChatChrome.reset(); fixtureContext.ref = 'website';
      ChatChrome.bind(fixtureRoot, contextValue); ChatWorkbench.bind(fixtureRoot, contextValue);
      window.webFiles = (await soduWorkAPI.conversationSession.outputs('website')).artifacts;
      window.webTurn = { messages: [{ role: 'user', submissionId: 'web-turn' }, { role: 'assistant', done: true }] };
      ChatWorkbench.render(fixtureRoot, { ...webTurn, status: 'streaming' }, webFiles);
    })()`);
    assert.equal(await js('webFiles.filter(file => file.versionId && file.turnId === "web-turn").length'), 1);
    assert.equal(await js('ChatWorkbench.state().open'), false);
    await js('ChatWorkbench.render(fixtureRoot, { ...webTurn, status: "idle" }, webFiles);');
    const rightWebsite = async () => {
      for (const view of win.contentView.children) {
        if (view.getVisible() && !view.webContents.isDestroyed() && await view.webContents.executeJavaScript(
          'document.querySelector("h1")?.textContent === "Frozen website" && getComputedStyle(document.querySelector("h1")).color === "rgb(111, 22, 33)"')) return true;
      }
      return false;
    };
    await until(rightWebsite, 'frozen HTML in the real right-hand WebContentsView');
    assert.equal(await js('ChatWorkbench.state().open'), true);
    await click('[data-wb-close]');
    await js('ChatWorkbench.render(fixtureRoot, webTurn, webFiles);');
    assert.equal(await js('ChatWorkbench.state().open'), false, 'a refresh respects the hidden pane');
    await handle.close();
    fs.rmSync(draft, { recursive: true });
    const historyView = bridge.attachView(await deviceHistory.open(row.id, { historyPreview: true }), { historyPreview: true });
    await js(`(async () => {
      ChatWorkbench.reset(); fixtureContext.ref = ${JSON.stringify(historyView.ref)}; ChatWorkbench.bind(fixtureRoot, contextValue);
      window.webFiles = (await soduWorkAPI.conversationSession.outputs(fixtureContext.ref)).artifacts;
      ChatWorkbench.render(fixtureRoot, { ...webTurn, localReplica: true, execution: { readOnly: true } }, webFiles);
    })()`);
    assert.equal(await js('ChatWorkbench.state().open'), false, 'returning to passive history must not reactivate a result');
    assert.equal(await js('ChatWorkbench.openOutput(webFiles.find(f => f.versionId).artifactId)'), true);
    await until(rightWebsite, 'explicit reopen of frozen HTML from history');
    await historyView.close();
    report.cases.push('A settled live turn opens the frozen HTML with its CSS. After the draft is deleted, the artifact IPC lists the version through the native history source and the right pane opens the same version through its registered facade. Manual close survives refresh.');

    const textName = '春天的短文.txt', originalText = '春水刚刚漫过青石，岸边的柳树冒出了新芽。';
    const textWorkspace = workspaces.allocate(workspace), textDir = workspaces.ensure(workspace, textWorkspace);
    const textBefore = await journal.snapshot(textDir);
    const textRow = { ...row, id: 'spring-essay' };
    const textPath = path.relative(workspace, path.join(textDir, textName)).split(path.sep).join('/');
    const textSnapshot = { status: 'idle', tools: [], messages: [
      { role: 'user', submissionId: 'spring-turn', text: '请写一篇春天的短文。' },
      { role: 'assistant', done: true, blocks: [{ index: 0, kind: 'text', text: '短文已完成，已保存为 txt 文件：' + textPath + '。' }] },
    ] };
    const textHandle = bridge.attachView({ ref: textRow.id, sessionId: textRow.id, cwd: workspace, deliveryWorkspace: textWorkspace,
      historyRow: () => textRow, snapshot: () => textSnapshot, outputSnapshot: () => outputs.scan(textDir, 0, 1), close: async () => true });
    deviceHistory.observe(textHandle, identity);
    fs.writeFileSync(path.join(textDir, textName), originalText);
    await textHandle.captureArtifactTurn(journal.compare(textBefore, await journal.snapshot(textDir), { turnId: 'spring-turn' }));

    // Mount the production message renderer, composer click delegate and workbench together.
    const transcriptFixture = path.join(client, 'e2e/fixtures/tool-details-lazy.html');
    async function openTranscript(ref, snap) {
      await win.loadFile(transcriptFixture);
      await js(`(async () => {
        ctx._ref = ${JSON.stringify(ref)};
        ctx._outs = (await soduWorkAPI.conversationSession.outputs(ctx._ref)).artifacts;
        showSnapshot(${JSON.stringify(snap)});
      })()`);
    }
    const textLink = '#nchatList .nmsg.ai .ntext .noutput-inline';
    async function clickEssay() {
      const version = await js('ctx._outs.find(file => file.versionId && file.turnId === "spring-turn")');
      assert.equal(version?.deliveryRelativePath, textPath, 'production IPC returns the verified draft reference for the frozen original');
      const message = await js('document.querySelector("#nchatList").textContent');
      assert.ok(message.includes(textName));
      assert.doesNotMatch(message, /\.soduwork-drafts|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      assert.deepEqual(await js(`[...document.querySelectorAll(${JSON.stringify(textLink)})].map(button => [button.textContent, button.dataset.openApp])`),
        [[textName, version.artifactId]], 'the visible filename in assistant prose targets the turn original');
      if (await js('ChatWorkbench.state().open')) await click('[data-wb-close]');
      await js(`document.querySelector(${JSON.stringify(textLink)}).scrollIntoView({ block: 'center' })`);
      await until(() => js(`(() => {
        const link = document.querySelector(${JSON.stringify(textLink)}), r = link.getBoundingClientRect();
        return link.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })()`), 'the scrolled transcript filename to become clickable');
      await click(textLink);
      await until(() => js(`ChatWorkbench.state().open && document.querySelector('.ncw-body')?.innerText.includes(${JSON.stringify(originalText)})`),
        'reading the original essay in the right pane after clicking its filename');
      return version.artifactId;
    }
    await openTranscript(textHandle.ref, textHandle.snapshot());
    const originalId = await clickEssay();
    await textHandle.close();
    fs.rmSync(textDir, { recursive: true });
    fs.writeFileSync(path.join(workspaces.ensure(workspace, workspaces.allocate(workspace)), textName), '另一个会话写入的同名文件。');
    await openTranscript('second', snapshot('second'));
    assert.equal(await js('document.querySelector("#nchatList").textContent.includes("春天的短文.txt")'), false);
    const textHistory = bridge.attachView(await deviceHistory.open(textRow.id, { historyPreview: true }), { historyPreview: true });
    await openTranscript(textHistory.ref, textHistory.snapshot());
    assert.equal(await clickEssay(), originalId, 'reopened replies still target the original version');
    await textHistory.close();
    report.cases.push('A native mouse click on 春天的短文.txt in the actual assistant reply opens its text on the right. The same visible filename reopens the frozen original from device history after switching sessions and replacing the draft workspace.');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
    await deviceHistory?.close();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
