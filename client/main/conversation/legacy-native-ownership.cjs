'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { accountId } = require('../device-auth-request');
const runtime = require('../platform-connections/runtime.cjs');
const { assertNoLinks } = require('../plugin-resources');
const access = require('./history-access');
const snapshots = require('./metadata-snapshot.cjs');
const manifests = require('./runtime-segments');
const receipts = require('./legacy-history-receipts.cjs');

const validId = id => typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 512 && !/[\x00-\x1f]/.test(id);
function native(row) {
  return row && validId(row.id) && !row.deleted && !row.cached && !row.source && !row.accountConversation &&
    !row.accountProjection && !row.remoteProjection && !row.cloud && row.adapterId !== 'account-sync' &&
    !row.importedHistory && !row.importDigest && !row.deviceTransferId && !row.sourceClientId && !row.sourceSessionId &&
    !row.sourceLocalId && (!row.location || row.location === 'local') && (!row.locationMode || row.locationMode === 'local');
}
const unverified = reason => ({ status: 'unverified', reason, ids: [] });
const sameHub = (value, hub) => { try { return new URL(value).origin === hub; } catch (_) { return false; } };

function group(app, id) {
  const owners = manifests.identities(app);
  const parts = row => [row.id, ...row.segments.map(part => part.sessionId), row.active.sessionId];
  const matching = owners.filter(row => parts(row).includes(id));
  if (matching.length > 1) return null;
  if (!matching.length) return { id, ids: [id], manifest: null };
  const manifest = manifests.read(app, matching[0].id);
  if (!manifest || manifest.deviceShared || manifest.deviceTransferId) return null;
  const ids = [...new Set(parts(manifest))];
  if (!ids.every(validId) || ids.length > 1001) return null;
  const members = new Set(ids);
  if (owners.some(row => row.id !== manifest.id && parts(row).some(part => members.has(part)))) return null;
  return { id: manifest.id, ids, manifest };
}

function readBinding(root, id) {
  const file = path.join(root, 'session-memory-bindings', crypto.createHash('sha256').update(id).digest('hex') + '.json');
  let snap;
  try { snap = snapshots.read(root, file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!snap) return { id, file, revision: null, value: null };
  if (snap.stat.nlink !== 1n) {
    // A crash between publishing a new binding with link() and unlinking its
    // temporary name can leave both names. Recover only this exact hard link.
    const dir = path.dirname(file), prefix = '.' + path.basename(file) + '.';
    const temp = snap.stat.nlink === 2n && fs.readdirSync(dir).find(name => {
      if (!name.startsWith(prefix) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(name.slice(prefix.length))) return false;
      const stat = fs.lstatSync(path.join(dir, name), { bigint: true });
      return stat.isFile() && stat.dev === snap.stat.dev && stat.ino === snap.stat.ino;
    });
    if (!temp) throw Error('会话归属文件存在其他硬链接，已保留原文件');
    fs.unlinkSync(path.join(dir, temp));
  }
  return { id, file, revision: snap.revision, value: JSON.parse(snap.bytes.toString('utf8')) };
}

function publish(root, binding, owner, hub) {
  const dir = path.dirname(binding.file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertNoLinks(root, dir);
  const temp = path.join(dir, '.' + path.basename(binding.file) + '.' + crypto.randomUUID() + '.tmp');
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify({ ...(binding.value || { ids: [] }), owner, hub }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (readBinding(root, binding.id).revision !== binding.revision) throw Error('会话归属已变化，请重试升级');
    if (binding.revision === null) fs.linkSync(temp, binding.file);
    else fs.renameSync(temp, binding.file);
  } finally { fs.rmSync(temp, { force: true }); }
}

async function migrate({ app, store, identity, row, assertCurrent }) {
  if (!native(row)) return unverified('not-native');
  const captured = access.actor(app, identity);
  let owner;
  try { owner = runtime.scope(identity); } catch (_) { return unverified('login-required'); }
  const hub = new URL(identity.hub).origin;
  const guard = assertCurrent || (() => access.assertCurrent(app, captured));
  guard();
  const archive = group(app, row.id);
  if (!archive) return unverified('ambiguous-segments');
  const indexed = new Map();
  for (let offset = 0; offset < archive.ids.length; offset += 32) {
    const batch = archive.ids.slice(offset, offset + 32);
    const found = await Promise.all(batch.map(id => store.get(id)));
    guard();
    for (let i = 0; i < batch.length; i++) {
      const entry = found[i];
      // get() can resolve a remote source locator. Only native IDs or their
      // persisted aliases can be repaired, never an independent cached copy.
      if (!entry || entry.id !== batch[i] && !entry.historyAliasIds?.includes(batch[i])) continue;
      if (!native(entry) || !archive.ids.includes(entry.id)) return unverified('conflicting-replica');
      indexed.set(entry.id, entry);
    }
  }
  const unchanged = group(app, row.id);
  if (!unchanged || unchanged.manifest !== archive.manifest) throw Error('会话分段已变化，请重试升级');
  const aliases = new Set(archive.ids);
  for (const item of [row, ...indexed.values()]) for (const id of item.historyAliasIds || []) aliases.add(id);
  const evidence = receipts.forApp(app).evidence(aliases, owner, identity);
  if (evidence.status === 'conflict') return unverified('conflicting-receipt');
  const root = app.getPath('userData');
  const bindings = archive.ids.map(id => readBinding(root, id));
  const rootBinding = bindings.find(item => item.id === archive.id)?.value;
  function originalOwner(value) {
    if (value === owner) return true;
    return captured.candidates.some(candidate => sameHub(candidate.hub, hub) &&
      runtime.legacyScope(hub, candidate.clientId, identity) === value);
  }
  const manifest = archive.manifest;
  if (manifest && (!originalOwner(manifest.owner) || manifest.hub && !sameHub(manifest.hub, hub) ||
      [...manifest.segments, manifest.active].some(part => part.executionOwner && !originalOwner(part.executionOwner))))
    return unverified('conflicting-manifest');
  for (const { value } of bindings) {
    if (value && (!Array.isArray(value.ids) || !originalOwner(value.owner) || value.hub && !sameHub(value.hub, hub)))
      return unverified('conflicting-binding');
  }
  const indexedRoot = indexed.get(archive.id);
  const durable = access.classifyLocal(app, archive.id, { id: archive.id, nativeHistory: true }).ownership(archive.id);
  const originalRecord = [...durable.records, durable.legacy].find(record => record && originalOwner(record.owner) &&
    (sameHub(record.hub, hub) || !record.hub && record.owner !== owner));
  if (!rootBinding && !originalRecord) {
    // A current read-only replica already has its own stable provenance. It
    // must not acquire new native execution ownership merely by being listed.
    const creator = indexedRoot?.creator;
    const stockCreator = creator?.account === accountId(identity) && sameHub(creator.hub, hub);
    const stockDraft = indexedRoot?.workOnly === true && row.workOnly === true &&
      indexedRoot.workOwner === row.workOwner && row.workOwner !== owner && originalOwner(row.workOwner);
    if (!stockCreator && !stockDraft) return unverified('missing-original-owner');
    if (row.creator && (row.creator.account !== accountId(identity) || !sameHub(row.creator.hub, hub)))
      return unverified('conflicting-history');
    try {
      for (const entry of indexed.values()) access.assertReadable(app, entry.id, captured, entry);
      if (row.id !== archive.id || indexedRoot.id !== row.id) return unverified('missing-original-owner');
      const merged = require('./history-evidence.cjs').mergeNativeEvidence(indexedRoot, row);
      access.assertReadable(app, archive.id, captured, merged);
    } catch (_) { return unverified('conflicting-history'); }
    guard();
    return { status: 'current', ids: archive.ids, provenance: 'existing-replica' };
  }
  if (evidence.status === 'unverified') return unverified('unverified-receipt');
  if (!originalRecord && !evidence.confirmed?.includes(archive.id)) return unverified('missing-original-hub');
  // Scrutinize every read boundary, including restricted work cards, existing
  // immutable creators and all persisted segment owners, before mutating any ID.
  for (const candidate of [row, ...indexed.values()]) {
    try {
      access.assertReadable(app, candidate.id, captured, { ...candidate, nativeHistory: true,
        historyAliasIds: [...aliases].filter(id => id !== candidate.id) });
    } catch (_) { return unverified('conflicting-history'); }
  }
  guard();
  let changed = false;
  for (const binding of bindings) {
    if (binding.value?.hub === hub && binding.value.owner === owner) continue;
    publish(root, binding, owner, hub);
    changed = true;
  }
  for (const entry of indexed.values()) {
    if (entry.creator?.account !== '' || Object.keys(entry.creator).length !== 1) continue;
    guard();
    if (!await store.repairLegacyCreator(entry.id, entry.revision, { account: accountId(identity), hub }))
      throw Error('会话索引已变化，请重试升级');
    changed = true;
  }
  guard();
  return { status: changed ? 'migrated' : 'current', ids: archive.ids };
}

module.exports = { migrate };
