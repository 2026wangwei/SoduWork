'use strict';

// This table belongs to the one-time upgrade client. Normal clients use only
// replicas, device_history and the native ownership files that the upgrade writes.
function timestamp(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  const millis = Number.isFinite(number) ? number : Date.parse(value);
  return Number.isFinite(millis) && millis > 0 ? millis : null;
}

// Called inside the transaction that writes the body. The first verified
// checkpoint binds the permanent owner; an unsuccessful claim never does.
function checkpoint(db, id, { worker, owner }, digest) {
  if (typeof digest !== 'string' || !digest.trim() || typeof owner !== 'string' || !owner)
    throw Error('Invalid history upgrade checkpoint');
  const changed = db.prepare(`UPDATE upgrade_11321_native SET owner=?,body=?
    WHERE id=? AND done=0 AND body IS NULL AND lease=? AND lease_owner=? AND expires>? AND (owner IS NULL OR owner=?)`)
    .run(owner, digest, id, worker, owner, Date.now(), owner);
  if (changed.changes !== 1) throw Error('History upgrade checkpoint is already committed or the lease changed');
}

function create(db, transaction, projectPage) {
  const readyKey = 'upgrade_1_13_21_native_inventory';
  const startKey = 'upgrade_1_13_21_native_start';
  let initialized = false;
  function initialize() {
    if (initialized) return;
    db.function('upgrade_11321_timestamp', { deterministic: true }, timestamp);
    transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS upgrade_11321_native (
        id TEXT PRIMARY KEY REFERENCES replicas(id), owner TEXT, body TEXT, done INTEGER NOT NULL DEFAULT 0,
        needs_selection INTEGER NOT NULL DEFAULT 0, unavailable INTEGER NOT NULL DEFAULT 0,
        lease TEXT, lease_owner TEXT, expires INTEGER NOT NULL DEFAULT 0
      )`);
      if (!db.prepare('PRAGMA table_info(upgrade_11321_native)').all().some(column => column.name === 'lease_owner'))
        db.exec('ALTER TABLE upgrade_11321_native ADD COLUMN lease_owner TEXT');
      db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run(startKey, String(Date.now()));
      // An abrupt desktop exit cannot release its lease. On the next launch
      // reclaim only processes the OS confirms are gone. Live or reused PIDs
      // stay fenced by the lease timeout and checkpoint comparisons.
      for (const { lease } of db.prepare('SELECT DISTINCT lease FROM upgrade_11321_native WHERE done=0 AND lease IS NOT NULL').all()) {
        const pid = Number(lease.split('/')[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
        try { process.kill(pid, 0); }
        catch (error) {
          if (error.code === 'ESRCH') db.prepare('UPDATE upgrade_11321_native SET lease=NULL,lease_owner=NULL,expires=0 WHERE lease=? AND done=0').run(lease);
        }
      }
    });
    initialized = true;
  }
  function sealed() { return !!db.prepare('SELECT 1 FROM metadata WHERE key=?').get(readyKey); }
  function leaseFor(id, worker) {
    return db.prepare('SELECT body FROM upgrade_11321_native WHERE id=? AND done=0 AND lease=?').get(id, worker);
  }
  return {
    legacyUpgradeSealed() { initialize(); return sealed(); },
    legacyUpgradeInventory(complete) {
      initialize();
      return transaction(() => {
        if (sealed()) return;
        db.prepare(`INSERT OR IGNORE INTO upgrade_11321_native(id)
          SELECT r.id FROM replicas r JOIN aliases a ON a.alias=r.id AND a.replica=r.id
          WHERE r.deleted=0 AND coalesce(json_extract(r.data,'$.cached'),0)=0
          AND coalesce(json_extract(r.data,'$.cloud'),0)=0 AND coalesce(json_extract(r.data,'$.workOnly'),0)=0
          AND coalesce(json_extract(r.data,'$.accountProjection'),0)=0 AND coalesce(json_extract(r.data,'$.remoteProjection'),0)=0
          AND coalesce(json_extract(r.data,'$.accountConversation'),0)=0 AND json_extract(r.data,'$.source') IS NULL
          AND coalesce(json_extract(r.data,'$.deviceTransferId'),'')='' AND coalesce(json_extract(r.data,'$.importDigest'),'')=''
          AND coalesce(upgrade_11321_timestamp(json_extract(r.data,'$.createdAt')),
            upgrade_11321_timestamp(json_extract(r.data,'$.at')),r.updated)
            <= (SELECT CAST(value AS INTEGER) FROM metadata WHERE key=?)`).run(startKey);
        if (complete === true) db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(readyKey, String(Date.now()));
      });
    },
    legacyUpgradePage(after, owner) {
      initialize();
      return projectPage(db.prepare(`SELECT r.* FROM upgrade_11321_native m JOIN replicas r ON r.id=m.id
        JOIN aliases a ON a.alias=r.id AND a.replica=r.id WHERE m.done=0 AND r.deleted=0 AND m.id>?
        AND (m.owner IS NULL OR m.owner=?) AND m.expires<=? ORDER BY m.id LIMIT 16`).all(after, owner, Date.now()));
    },
    legacyUpgradeClaim(id, worker, owner) {
      initialize();
      return transaction(() => {
        const changed = db.prepare(`UPDATE upgrade_11321_native SET lease=?,lease_owner=?,expires=? WHERE id=? AND done=0
          AND expires<=? AND (owner IS NULL OR owner=?)`).run(worker, owner, Date.now()+120000, id, Date.now(), owner);
        return changed.changes ? leaseFor(id, worker) : null;
      });
    },
    legacyUpgradeRenew(id, worker) {
      return db.prepare('UPDATE upgrade_11321_native SET expires=? WHERE id=? AND done=0 AND lease=?')
        .run(Date.now()+120000, id, worker).changes === 1;
    },
    legacyUpgradeComplete(id, worker, owner, digest, needsSelection = 0, unavailable = 0) {
      return db.prepare(`UPDATE upgrade_11321_native SET done=1,needs_selection=?,unavailable=?
        WHERE id=? AND lease=? AND lease_owner=? AND owner=? AND expires>? AND done=0 AND length(body)>0
        AND EXISTS(SELECT 1 FROM device_history h JOIN replicas r ON r.id=h.replica
          JOIN aliases a ON a.alias=r.id AND a.replica=r.id WHERE r.id=? AND r.deleted=0 AND h.digest=?)`)
        .run(needsSelection, unavailable, id, worker, owner, owner, Date.now(), id, digest).changes === 1;
    },
    legacyUpgradeUpdatePackages(id, digest, needsSelection) {
      initialize();
      if (!Number.isInteger(needsSelection) || needsSelection < 0 || needsSelection > 2) throw Error('Invalid package count');
      return db.prepare(`UPDATE upgrade_11321_native SET needs_selection=? WHERE id=? AND done=1
        AND EXISTS(SELECT 1 FROM device_history WHERE replica=? AND digest=?)`).run(needsSelection, id, id, digest).changes === 1;
    },
    legacyUpgradeRelease(id, worker) {
      db.prepare('UPDATE upgrade_11321_native SET lease=NULL,lease_owner=NULL,expires=0 WHERE id=? AND lease=?').run(id, worker);
    },
  };
}
module.exports = { create, checkpoint, methods: ['legacyUpgradeSealed', 'legacyUpgradeInventory', 'legacyUpgradePage', 'legacyUpgradeClaim',
  'legacyUpgradeRenew', 'legacyUpgradeComplete', 'legacyUpgradeUpdatePackages', 'legacyUpgradeRelease'] };
