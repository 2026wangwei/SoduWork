'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(status, result = {}, clientId) {
  const values = new Map();
  const window = { soduWorkAPI: { runnerStatus: async () => status }, dispatchEvent() {} };
  const context = { window, User: { id: clientId }, URL, AbortController, setTimeout, clearTimeout,
    CustomEvent: class {}, console,
    localStorage: { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(result) }) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../api.js'), 'utf8'), context);
  return window.SoduWorkAPI;
}

test('all three empty surfaces report the actual local Runner error', async () => {
  const reason = '本机 Runner 已启动，但后台尚未确认上线，正在自动重连。';
  const api = fixture({ running: true, connected: false, error: reason });
  assert.equal((await api.listAIAgents()).reason, reason);
  assert.equal((await api.agentSetup()).env.why, reason);
  assert.equal((await api.runners()).localRunnerReason, reason);
});

test('ready Runner preserves authoritative model and permission errors', async () => {
  const api = fixture({ running: true, connected: true, error: '' }, { agents: [], reason: '尚未配置可用模型' });
  assert.equal((await api.listAIAgents()).reason, '尚未配置可用模型');
});

test('an older Hub cannot make a sibling work computer a requirement or automation option', async () => {
  const seat = (runner, kind, clientId, mode) => ({ id: 'runner:' + runner + ':pi',
    assigneeId: 'runner:' + runner + ':pi', runnerId: runner, runnerKind: kind, clientId, mode,
    label: runner, host: runner, version: '1' });
  const sibling = seat('first','work-computer','device-1','remote');
  const local = seat('second','work-computer','device-2','local');
  const cloud = seat('standalone','cloud','','remote');
  const unbound = seat('unbound','work-computer','','remote');
  const all = [sibling, local, cloud, unbound];
  const group = { key:'local:pi', name:'Pi', available:true, locations:all, requiredCapabilities:['browser'],
    capabilitySets:[['browser'],[],[],[]], defaultAssigneeId:sibling.id, busySeats:2, onlineSeats:4 };
  const contract = { substrates:[group, {...group,key:'local:codex',locations:[sibling]}, {key:'local:qwen'}],
    executionTargets:all, agents:all, default:{ id:sibling.id } };
  const api = fixture({connected:true}, contract, 'device-2');
  const options = await api.taskExecutionOptions({});
  assert.deepEqual(Array.from(options.substrates, row => row.key), ['local:pi','local:qwen']);
  const pi = options.substrates[0];
  assert.equal(pi.defaultAssigneeId, local.id);
  assert.deepEqual(Array.from(pi.locations, row => row.id), [local.id, cloud.id]);
  assert.equal(pi.onlineSeats, 2);
  assert.equal(pi.available, false, 'a filtered computer must not meet required capabilities for this device');
  assert.deepEqual(Array.from(options.executionTargets, row => row.id), [local.id, cloud.id]);
  const roster = await api.listAIAgents();
  assert.deepEqual(Array.from(roster.agents, row => row.id), [local.id, cloud.id]);
  assert.equal(roster.default, null);
});
