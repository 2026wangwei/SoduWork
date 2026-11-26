'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { create } = require('../e2e/fixtures/resumed-pi.cjs');
const policy = require('../main/access-control/policy');
const { answerHandler, changeHandler } = require('../main/access-control/ipc');
const { capture } = require('../main/pi-session/task-delivery.cjs');

for (const scenario of ['full', 'once', 'stop', 'plugin', 'during-repair']) {
  test('permission handling preserves the Pi requirement outcome: ' + scenario, { timeout: 30000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-requirement-access-'));
    const f = await create(root);
    t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const h = await f.open({ resumePath: '', accessPolicy: policy.create('standard', f.cwd) });
    const owner = { webContents: { id: 17 } };
    h.attachedWindow = owner;
    const sessions = new Map([[h.ref, h]]);
    const change = changeHandler({ session: sessions,
      BrowserWindow: { fromWebContents: () => owner }, confirmFullAccess: async () => true });
    const isDraft = scenario === 'plugin' || scenario === 'during-repair';
    const name = isDraft ? 'soduwork-plugin-draft.json' : '冬天.md';
    const content = isDraft ? '{invalid' : '# 冬天\n雪落在屋檐上。';
    const external = path.join(root, 'verification.txt');
    let modelRunning;
    const stoppingPoint = new Promise(resolve => { modelRunning = resolve; });
    f.reply((body, count) => {
      if (count === 1) return { tool: 'write', args: { path: name, content } };
      if (scenario === 'during-repair' && count === 2) return { text: '已生成插件草稿。' };
      if (count === (scenario === 'during-repair' ? 3 : 2)) {
        if (scenario === 'during-repair') {
          assert.match(JSON.stringify(body.messages.at(-1)), /soduwork-internal-plugin-repair/);
        }
        return { tool: 'write', args: { path: external, content: 'checked' } };
      }
      if (scenario === 'stop') return { respond(response) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        modelRunning();
      } };
      return { text: '文件已保存并核验。' };
    });

    let pending;
    const permission = new Promise(resolve => { pending = resolve; });
    const remove = h.on(() => {
      const snap = h.snapshot();
      if (snap.pendingPermissions?.length) pending(snap);
    });
    t.after(remove);
    const receipts = [];
    let delivery;
    const item = h.submit(isDraft ? 'Create the plugin draft and verify it.' : '保存冬天.md，并写入核验记录。', [], {
      taskId: 'requirement', submissionId: 'initial-turn',
      afterTurn: async state => {
        receipts.push(state);
        if (state === 'completed') delivery = await capture(h, 'completed');
      },
    });
    const before = await permission;
    const turnSince = h.outputSnapshot().turnSince;
    assert.equal(before.status, 'waiting-user');
    assert.equal(before.accessPolicy.mode, 'standard');
    assert.equal(fs.existsSync(external), false);
    const event = { sender: owner.webContents };
    const request = before.pendingPermissions[0];
    const ack = scenario === 'once'
      ? await answerHandler(sessions)(event, h.ref, { requestId: request.requestId, policyRevision: request.policyRevision, decision: 'once' })
      : await change(event, h.ref, 'full', before.accessPolicy.revision);
    assert.equal(ack.ok, true);
    if (scenario === 'stop') { await stoppingPoint; await h.cancel(); }
    const result = await item.completion;
    assert.equal(h.snapshot().accessPolicy.mode, scenario === 'once' ? 'standard' : 'full');
    assert.equal(fs.readFileSync(external, 'utf8'), 'checked');
    assert.equal(fs.readFileSync(path.join(f.cwd, name), 'utf8'), content);
    assert.equal(f.requests.length, scenario === 'during-repair' ? 4 : 3,
      'permission changes do not replay the request or launch additional plugin repairs');
    if (scenario === 'full' || scenario === 'once') {
      assert.equal(result.snapshot.status, 'idle');
      assert.deepEqual(receipts, ['completed']);
      const output = h.outputSnapshot();
      assert.equal(output.turnSince, turnSince, 'tool approval belongs to the same artifact journal');
      assert.equal(output.files.find(file => file.relative === name)?.changedInTurn, true);
      assert.deepEqual(delivery.files.map(file => [file.name, file.category, Buffer.from(file.data, 'base64').toString()]),
        [[name, 'primary', content]]);
    } else if (scenario === 'stop') {
      assert.deepEqual(receipts, ['stopped']);
      assert.equal(delivery, undefined);
    } else {
      // A stale authorization may not repair or deliver an invalid package.
      assert.deepEqual(receipts, ['failed']);
      assert.equal(result.failureKind, 'plugin-repair');
      assert.match(result.reason, /权限/);
      assert.notEqual(result.manualStop, true);
      assert.equal(delivery, undefined);
    }
  });
}
