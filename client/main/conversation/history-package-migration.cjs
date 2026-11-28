'use strict';

// Keep a package confirmed in the native picker in the same immutable archive
// that ordinary 1.13.x reads. Never claim a user-confirmed file for a chat turn.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const archive = require('./device-artifact-archive.cjs');
const contract = require('./delivery-contract');
const { same } = require('./runtime-artifacts.cjs');
const { portablePath } = require('./portable-workspace');
const changed = () => Error('会话或成果已变化，请重新打开成果');

async function preserve({ app, store, row, expectedDigest, manifest, files, guard }) {
  guard();
  // Opening an old chat can register its recovered body after the view captured
  // its row. Fence the catalog generation at selection, then check it again in SQLite.
  const [catalog, saved] = await Promise.all([store.get(row.id), store.deviceHistory(row.id)]);
  guard();
  if (!catalog || catalog.id !== row.id || catalog.deleted || catalog.cwd !== row.cwd || catalog.adapterId !== row.adapterId ||
      catalog.replicaRevision !== row.replicaRevision || catalog.creator?.hub !== row.creator?.hub ||
      catalog.creator?.account !== row.creator?.account ||
      !require('./history-access').usesDeviceChatContext(app, { chatId: row.id }, catalog, row)) throw changed();
  if (!saved || saved.digest !== expectedDigest || saved.imported || saved.historyProtection || saved.nativeConflict ||
      row.deleted || row.cached || row.deviceTransferId || !saved.coverage?.complete) throw changed();
  const previous = saved.localArtifactHistory, root = fs.realpathSync.native(row.cwd);
  if (previous && previous.root !== root) throw changed();
  const entries = [...(previous?.items || []), ...(previous?.resources || [])];
  const recorded = new Map(entries.map(item => [item.metadata.relative, item]));
  const names = new Map(entries.map(item => [item.metadata.relative.normalize('NFC').toLowerCase(), item.metadata.relative]));
  const source = { sessionId: row.id, adapterId: row.adapterId }, originals = new Map(), proofs = new Map();
  const priorFiles = new Map((previous?.archive?.files || []).map(file => [file.relative, file]));
  const profile = app.getPath('userData'), priorRoot = archive.location(profile, row.id, previous?.archive);
  const items = [...(previous?.items || [])], resources = [...(previous?.resources || [])];
  for (const file of files) {
    guard();
    const selected = portablePath(file.relative);
    const bytes = await archive.readVersion(root, selected, file.stamp);
    if (!bytes || hash(bytes) !== file.sha256) throw changed();
    // The released reader recognizes exported ZIPs by their .soduwork-plugin
    // extension. Only the archive copy gets a canonical, content-addressed name.
    const relative = manifest === selected && /\.zip$/i.test(selected)
      ? 'recovered-packages/' + file.sha256 + '.soduwork-plugin' : selected;
    const old = recorded.get(relative), key = relative.normalize('NFC').toLowerCase();
    const committed = priorFiles.get(relative);
    if (names.has(key) && names.get(key) !== relative || old && !same(old.stamp, file.stamp) && committed?.sha256 !== file.sha256) throw changed();
    proofs.set(relative, file.sha256);
    if (old && priorRoot && committed?.sha256 === file.sha256 && same(committed.sourceStamp, old.stamp)) {
      const existing = await archive.readVersion(priorRoot, relative, committed.stamp).catch(() => null);
      if (existing && hash(existing) === file.sha256) continue;
    }
    if (old && !same(old.stamp, file.stamp)) throw changed();
    const kind = contract._kindOf(relative) || (/\.soduwork-plugin$/i.test(relative) ? 'archive' : 'file');
    const name = path.posix.basename(relative);
    const entry = old || { metadata: { name, title: name, relative, size: bytes.length, at: Math.round(Number(file.stamp[3]) / 1e6),
      primary: false, kind, artifactId: contract._artifactId(kind, relative) }, source, stamp: file.stamp };
    if (!old) {
      (manifest === selected ? items : resources).push(entry);
      names.set(key, relative); recorded.set(relative, entry);
    }
    originals.set(entry, bytes);
  }
  if (!proofs.size || !files.some(file => file.relative === manifest)) throw changed();
  guard();
  if (!originals.size) return saved.digest;
  const history = { version: 1, ...previous, root, items, resources };
  const updated = await archive.preserve(profile, row.id, history, previous, guard, { readWorkspace: false, originals });
  let result;
  try {
    for (const [name, digest] of proofs) if (!updated.archive?.files.some(file => file.relative === name && file.sha256 === digest)) throw changed();
    const { digest, savedAt, ...body } = saved;
    guard();
    result = await store.saveDeviceHistory(row.id, { ...body, localArtifactHistory: updated }, {
      expectedRevision: row.replicaRevision, expectedCatalogRevision: catalog.revision, requireCatalogRevision: true,
      expectedTransferId: '', expectedHistoryDigest: digest });
    if (!result?.ok) throw changed();
    return result.digest;
  } finally {
    await archive.retire(profile, row.id, previous?.archive, updated.archive, !!result?.ok);
  }
}

// Report only what an unpatched client can recover from the durable generation.
// A transcript mention or a working copy does not complete package migration.
async function inspect({ app, row, data, assertCurrent }) {
  assertCurrent();
  const kind = require('./history-package-picker.cjs').authoredKind(data?.snapshot);
  const candidates = data?.localArtifactHistory?.items?.some(item =>
    require('./device-history-plugins.cjs').candidate(item.metadata?.relative || ''));
  const missing = new Set(kind === 'both' ? ['app', 'plugin'] : kind ? [kind] : []);
  const keys = new Set();
  const result = () => ({ complete: !missing.size, packages: keys.size, needsSelection: missing.size });
  if (!candidates || !data.digest || data.historyProtection || data.imported || data.nativeConflict ||
      row.deleted || row.cached || row.deviceTransferId || row.cloud) return result();
  const projected = archive.projection(app.getPath('userData'), row.id, data.localArtifactHistory);
  if (!projected) return result();
  const reader = require('./device-history-artifacts.cjs').view(projected.root, projected, assertCurrent);
  const listing = await reader.snapshotAsync();
  for (const file of listing.items) {
    assertCurrent();
    if (!file.pluginDraft || file.skillPackage || file.pluginSuperseded || file.pluginValidation?.state !== 'ready') continue;
    const checked = await reader.readPlugin(file);
    if (!checked.body?.key || checked.revision !== file.pluginRevision) continue;
    const type = checked.body.template === 'app' ? 'app' : 'plugin';
    keys.add(checked.body.key); missing.delete(type);
  }
  assertCurrent();
  return result();
}
module.exports = { preserve, inspect };
