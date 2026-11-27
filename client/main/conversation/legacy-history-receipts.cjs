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
    if (route !== item.route || conversationId !== item.conversationId) item.invalid = true;
    rows.set(id, item);
    return item;
  }
  try {
    db.exec('PRAGMA trusted_schema=OFF; BEGIN');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('checkpoints','directory')").all();
    if (tables.length !== 2) return rows;
    for (const r of fields(db, 'checkpoints', 'key', 'sourceSessionId hub ownerKey clientId conversationId legacy deleted sourceEpoch sourceRevision ackedRevision contentDigest ackedDigest')) {
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
      if (r.legacy !== 0 || r.deleted ||
          r.sourceEpoch !== (r.sourceSessionId + ':desktop').slice(0, 180) || !Number.isSafeInteger(r.ackedRevision) ||
          r.ackedRevision <= 0 || r.sourceRevision !== r.ackedRevision || !/^[a-f0-9]{64}$/.test(r.ackedDigest) ||
          r.ackedDigest !== r.contentDigest || !r.conversationId?.startsWith('acct-')) item.invalid = true;
      item.ack = r.ackedRevision;
    }
    for (const r of fields(db, 'directory', 'scope, id AS directoryId', 'id sourceSessionId sourceClientId canView deleted sourceRevision')) {
      const [hub, account, viewer] = JSON.parse(r.scope);
      const item = record(r.sourceSessionId, JSON.stringify([hub, account, r.sourceClientId]), r.id);
      if (r.directoryId !== r.id || r.deleted !== 0) item.invalid = true;
      if (viewer === r.sourceClientId) {
        if (r.canView !== 1) item.invalid = true;
        item.confirmed = Number.isSafeInteger(r.sourceRevision) && r.sourceRevision >= item.ack;
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
  function getHub(id, owner, identity, aliases = []) {
    try {
      if (runtime.scope(identity) !== owner) return '';
      const hub = new URL(identity.hub).origin;
      const route = JSON.stringify([hub, accountScopeKey(identity), identity.clientId]);
      const state = databaseState(root, file);
      if (!state) return '';
      if (!rows || stamp !== state.stamp) {
        const next = load(file, state.wal);
        if (revision() !== state.stamp) return '';
        rows = next;
        stamp = state.stamp;
      }
      const source = rows.get(id);
      if (!source?.confirmed || source.invalid || source.route !== route) return '';
      for (const alias of aliases) {
        const entry = rows.get(alias);
        if (entry && (entry.invalid || entry.route !== route)) return '';
      }
      return hub;
    } catch (_) { return ''; }
  }
  return { revision, getHub };
}

const instances = new WeakMap();
function forApp(app) {
  if (!instances.has(app)) instances.set(app, create(app));
  return instances.get(app);
}

module.exports = { create, forApp };
