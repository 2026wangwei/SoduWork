'use strict';

const { randomUUID } = require('node:crypto');
const ownership = require('./legacy-native-ownership.cjs');

function create({ app, session, store, actor, guard, backfill, migrateOwner = ownership.migrate,
  migrateArtifacts = options => require('./legacy-upgrade-artifacts.cjs').migrate(options),
  inspectPackages = options => require('./history-package-migration.cjs').inspect(options),
  interval = 60000, firstDelay = 2000 }) {
  let closed = false, timer, pending;
  function run() {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending = scan().finally(() => { pending = null; });
    return pending;
  }
  async function scan() {
    const captured = actor();
    const result = { completed: 0, deferred: 0 };
    if (!captured?.owner || !captured.identity?.hub || !captured.readScope) return result;
    const owner = JSON.stringify([new URL(captured.identity.hub).origin, captured.owner]);
    const assertScope = () => {
      if (closed) throw Error('Local history upgrade stopped');
      guard(captured);
    };
    if (!await store.legacyUpgradeSealed()) {
      assertScope();
      let complete = false;
      try { await session.refreshUpgradeInventory(app); complete = true; }
      catch (_) { /* Available archives were indexed. Retry the missing inventories later. */ }
      assertScope(); await store.legacyUpgradeInventory(complete);
    }
    let after = '';
    while (!closed) {
      assertScope();
      const rows = await store.legacyUpgradePage(after, owner);
      if (!rows.length) break;
      for (const row of rows) {
        after = row.id;
        assertScope();
        if (session.findBySessionId?.(row.id)?.inFlight?.()) { result.deferred++; continue; }
        const worker = process.pid + '/' + randomUUID(), claim = await store.legacyUpgradeClaim(row.id, worker, owner);
        if (!claim) continue;
        let valid = true;
        const assertCurrent = () => {
          assertScope();
          if (!valid) throw Error('Local history upgrade lease changed');
        };
        const heartbeat = setInterval(() => {
          store.legacyUpgradeRenew(row.id, worker).then(ok => { if (!ok) valid = false; }, () => { valid = false; });
        }, 30000);
        heartbeat.unref?.();
        try {
          assertCurrent();
          const status = await migrateOwner({ app, store, row, identity: captured.identity, assertCurrent });
          if (status.status !== 'current' && status.status !== 'migrated') { result.deferred++; continue; }
          assertCurrent();
          // A restarted client can resume at the committed body. Further turns
          // update that same standard row and never enroll a completed ID again.
          const data = claim.body ? await store.deviceHistory(row.id) :
            await backfill(row.id, { verify: assertCurrent, legacyUpgrade: { worker, owner } });
          assertCurrent();
          if (!data?.coverage?.complete || data.nativeConflict || data.imported || !data.digest) {
            result.deferred++; continue;
          }
          const latest = await store.get(row.id);
          if (!latest || latest.id !== row.id || latest.deleted || latest.cached || latest.deviceTransferId) {
            result.deferred++; continue;
          }
          const assets = await migrateArtifacts({ app, session, store, data, row: latest, identity: captured.identity, assertCurrent });
          assertCurrent();
          if (!assets.complete) { result.deferred++; continue; }
          const digest = assets.digest || data.digest;
          const updated = digest === data.digest ? data : await store.deviceHistory(row.id);
          if (updated?.digest !== digest) { result.deferred++; continue; }
          const packages = await inspectPackages({ app, row: latest, data: updated, assertCurrent });
          assertCurrent();
          if (await store.legacyUpgradeComplete(row.id, worker, owner, digest, packages.needsSelection, assets.unavailable || 0))
            result.completed++;
          else result.deferred++;
        } catch (_) { assertScope(); result.deferred++; }
        finally {
          clearInterval(heartbeat);
          await store.legacyUpgradeRelease(row.id, worker);
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    return result;
  }
  function start(delay = firstDelay) {
    if (closed || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      try { await run(); } catch (_) { /* Login changes and a busy database retry on the next pass. */ }
      finally { start(interval); }
    }, delay);
    timer.unref?.();
  }
  return { run, start, async close() { closed = true; clearTimeout(timer); await pending?.catch(() => {}); } };
}

module.exports = { create };
