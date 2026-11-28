'use strict';

// Older desktop builds kept the account owner in memory bindings and the Hub
// in the outbound sync receipt. Read that evidence without starting sync.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { assertNoLinks } = require('../plugin-resources');
const snapshots = require('./metadata-snapshot.cjs');
const { accountScopeKey } = require('../device-auth-request');
const runtime = require('../platform-connections/runtime.cjs');

function fileHeader(root, file, bytes) {
  try {
    const { stat, revision } = snapshots.read(root, file, {
      prefix: true, maxBytes: bytes, maxFileBytes: Number.MAX_SAFE_INTEGER,
    });
    if (stat.nlink !== 1n) throw Error('Linked history receipt database');
    return [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs, revision].join(':');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function databaseState(root, file) {
  // The header contains SQLite's change counter; the first 96 bytes of -shm
  // are the two WAL-index headers, including the latest committed frame.
  const main = fileHeader(root, file, 100);
  if (!main) return null;
  const wal = fileHeader(root, file + '-wal', 32);
  const shm = fileHeader(root, file + '-shm', 96);
  assertNoLinks(root, file + '-journal');
  if (fs.existsSync(file + '-journal') || Boolean(wal) !== Boolean(shm)) return null;
  return { stamp: [main, wal, shm].join('|'), wal: Boolean(wal) };
}

function fields(db, table, key, names) {
  const columns = names.split(' ').map(name => `json_extract(value, '$.${name}') AS ${name}`);
  return db.prepare(`SELECT ${key}, ${columns.join(', ')} FROM ${table}`).iterate();
}

function load(file, wal) {
  // An ordinary SQLite read-only connection can still create sidecars on a
  // checkpointed WAL database. Use immutable mode only when no WAL exists.
  const { DatabaseSync } = require('node:sqlite');
  const url = pathToFileURL(file).href + (wal ? '?mode=ro' : '?mode=ro&immutable=1');
  const db = new DatabaseSync(url, { readOnly: true });
  const rows = new Map();
  function record(id, route, conversationId) {
    const item = rows.get(id) || { route, conversationId };
    // The oldest writer dropped the previous conversationId while enqueueing a
    // newer revision. Its confirmed directory entry supplies the immutable ID.
    if (item.awaitDirectoryId && conversationId) {
      item.conversationId = conversationId;
      item.awaitDirectoryId = false;
    }
    if (route !== item.route || conversationId !== item.conversationId) item.invalid = true;
    rows.set(id, item);
    return item;
  }
  try {
    db.exec('PRAGMA trusted_schema=OFF; BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
    if (!tables.has('directory') || !tables.has('checkpoints')) return rows;
    const queued = tables.has('jobs') && db.prepare(`SELECT 1 FROM jobs WHERE id=? AND scope=? AND source=? AND revision=?
      AND json_extract(value,'$.sessionKey')=? AND json_extract(value,'$.body.deleted')=0
      AND json_extract(value,'$.body.sourceSessionId')=? AND json_extract(value,'$.body.sourceEpoch')=?
      AND json_extract(value,'$.body.sourceRevision')=?`);
    for (const r of fields(db, 'checkpoints', 'key', 'sourceSessionId hub ownerKey clientId conversationId legacy deleted sourceEpoch sourceRevision ackedRevision contentDigest ackedDigest digest')) {
      const route = [r.hub, r.ownerKey, r.clientId];
      const item = record(r.sourceSessionId, JSON.stringify(route), r.conversationId);
      if (r.key !== JSON.stringify([...route, r.sourceSessionId])) {
        // A mismatched key cannot prove either identifier, even if another
        // Hub has a well-formed receipt for one of them.
        item.invalid = true;
        if (r.key.startsWith('[')) {
          const keyedId = JSON.parse(r.key)[3];
          if (typeof keyedId === 'string') record(keyedId, '', '').invalid = true;
        }
      }
      if (r.legacy !== 0 || r.deleted || r.sourceEpoch !== (r.sourceSessionId + ':desktop').slice(0, 180) ||
          !Number.isSafeInteger(r.ackedRevision) || r.ackedRevision <= 0 || !Number.isSafeInteger(r.sourceRevision) ||
          r.sourceRevision < r.ackedRevision || !/^[a-f0-9]{64}$/.test(r.contentDigest)) item.invalid = true;
      if (r.sourceRevision === r.ackedRevision) {
        if (r.ackedDigest !== r.contentDigest || !r.conversationId?.startsWith('acct-')) item.invalid = true;
      } else {
        // A pending write alone never proves ownership. Require the actual
        // queued update as well as the old ACK and its exact directory entry.
        const jobId = r.key + ':' + r.sourceRevision + ':' + String(r.digest).slice(0, 12);
        if (!/^[a-f0-9]{64}$/.test(r.digest) || !queued || !queued.get(jobId, JSON.stringify(route),
            JSON.stringify([...route, r.sourceSessionId, r.sourceEpoch]), r.sourceRevision, r.key,
            r.sourceSessionId, r.sourceEpoch, r.sourceRevision)) item.invalid = true;
        item.pending = true;
        item.awaitDirectoryId = !r.conversationId;
      }
      item.ack = r.ackedRevision;
    }
    for (const r of fields(db, 'directory', 'scope, id AS directoryId', 'id sourceSessionId sourceClientId canView deleted sourceRevision')) {
      const [hub, account, viewer] = JSON.parse(r.scope);
      const item = record(r.sourceSessionId, JSON.stringify([hub, account, r.sourceClientId]), r.id);
      if (r.directoryId !== r.id || !r.id?.startsWith('acct-') || r.deleted !== 0) item.invalid = true;
      if (viewer === r.sourceClientId) {
        if (r.canView !== 1) item.invalid = true;
        // The Hub keeps one row per account, source device and native session.
        // Its directory may still describe an earlier confirmed turn when the
        // writer gets another ACK and queues its next update.
        item.confirmed = item.ack > 0 && Number.isSafeInteger(r.sourceRevision) &&
          r.sourceRevision > 0 && (!item.pending || r.sourceRevision <= item.ack);
      }
    }
    return rows;
  } finally { db.close(); }
}

function create(app) {
  const root = app.getPath('userData');
  const file = path.join(root, 'account-conversations-sync', 'outbox.json.sqlite');
  let stamp = '', rows;
  function revision() {
    try { return databaseState(root, file)?.stamp || ''; } catch (_) { return ''; }
  }
  function evidence(ids, owner, identity) {
    try {
      if (runtime.scope(identity) !== owner) return { status: 'unverified' };
      const hub = new URL(identity.hub).origin;
      const route = JSON.stringify([hub, accountScopeKey(identity), identity.clientId]);
      const state = databaseState(root, file);
      if (!state) return { status: fs.existsSync(file) ? 'unverified' : 'absent', confirmed: [] };
      if (!rows || stamp !== state.stamp) {
        const next = load(file, state.wal);
        if (revision() !== state.stamp) return { status: 'unverified' };
        rows = next;
        stamp = state.stamp;
      }
      const confirmed = [];
      let found = false;
      for (const id of ids) {
        const entry = rows.get(id);
        if (!entry) continue;
        found = true;
        if (entry.invalid || entry.route !== route) return { status: 'conflict' };
        if (entry.confirmed) confirmed.push(id);
      }
      return { status: confirmed.length ? 'verified' : found ? 'unverified' : 'absent', confirmed, hub };
    } catch (_) { return { status: 'unverified' }; }
  }
  function getHub(id, owner, identity, aliases = []) {
    const result = evidence(new Set([id, ...aliases]), owner, identity);
    return result.confirmed?.includes(id) ? result.hub : '';
  }
  return { revision, getHub, evidence };
}

const instances = new WeakMap();
function forApp(app) {
  if (!instances.has(app)) instances.set(app, create(app));
  return instances.get(app);
}

module.exports = { create, forApp };
