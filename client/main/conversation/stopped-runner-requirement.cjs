'use strict';

const access = require('./history-access');
const segments = require('./runtime-segments');
const cards = require('./work-conversation-cards');
const { scopeMatches } = require('../platform-connections/runtime.cjs');
const { mergeNativeEvidence } = require('./history-evidence.cjs');
const changed = () => Error('会话归属或历史已变化，请重新打开');

function create({ app, session, store, actor, currentActor, read }) {
  return async function stoppedRunnerRequirement(id, { open = false } = {}) {
    const runner = require('../runner-runtime');
    if (runner.hasLocalTransport()) return null;
    const captured = actor(), row = await store.get(id);
    if (!row || row.id !== id || !row.deviceHistory || row.deleted || row.workOnly || row.cached || row.source ||
        row.importedHistory || row.importDigest || row.deviceTransferId || row.sourceSessionId || row.sourceClientId ||
        row.sourceLocalId || row.cloud || row.accountProjection || row.accountConversation || row.remoteProjection ||
        row.location && row.location !== 'local' || row.locationMode && row.locationMode !== 'local') return null;
    const manifest = segments.read(app, id);
    const active = manifest?.active || { adapterId: row.adapterId, sessionId: id };
    if (require('../agent-runtime/runtime-catalog').runtime(active.adapterId)?.transport !== 'runner' ||
        !cards.protection(app, id)?.hasRequirement) return null;
    // A missing runtime, corrupt inventory and failed permission check are different.
    // Only the process manager can confirm that the local transport is down.
    try { await runner.rpc('runtime.sessions', {}, 1000); return null; }
    catch (error) { if (error.code !== 'RUNNER_NOT_RUNNING') return null; }
    let evidence = row;
    function guard(fresh) {
      const current = currentActor(captured);
      evidence = mergeNativeEvidence(evidence, fresh);
      access.assertReadable(app, id, current, evidence);
      const local = access.classifyLocal(app, id, evidence);
      if (local.invalid || local.kind !== 'protected' ||
          !local.ownership(id).records.some(record => scopeMatches(record.owner, current.identity, current.candidates)) ||
          !cards.protection(app, id)?.hasRequirement || segments.read(app, id) !== manifest) throw changed();
    }
    guard();
    const parts = [...(manifest?.segments || []), active];
    // Query Pi separately. A stopped Runner must not mask a competing Pi archive
    // or an unreadable index, including a retired local Pi segment.
    for (const sourceId of new Set([id, ...parts.filter(part => part.adapterId === 'pi').map(part => part.sessionId)])) {
      const pi = await session.historyEntry(app, sourceId, { strict: true });
      if (pi?.ok ? pi.entry?.id !== sourceId || !parts.some(part => part.adapterId === 'pi' && part.sessionId === sourceId)
        : pi?.notFound !== true) throw changed();
      guard(pi?.entry);
    }
    const data = await store.deviceHistory(id);
    if (!data?.digest || !data.coverage?.complete || data.imported || data.nativeConflict ||
        !Array.isArray(data.snapshot?.messages) || !data.snapshot.messages.length ||
        !data.coverage.sources?.some(source => source.id === active.sessionId && source.adapterId === active.adapterId) ||
        !data.coverage.sources.every(source => parts.some(part => part.sessionId === source.id && part.adapterId === source.adapterId))) return null;
    const record = await cards.diskRecord(app, id);
    if (!record?.cards.some(card => card?.actionId === 'work.requirement.create') ||
        !scopeMatches(record.owner, captured.identity, captured.candidates)) throw changed();
    async function current() {
      const latest = await store.get(id);
      if (!latest || latest.deleted || latest.revision !== row.revision || await store.deviceHistoryVersion(id) !== data.digest) throw changed();
      guard(latest);
    }
    await current();
    if (!open) return { row, record };
    const view = await require('./local-history-view.cjs').create({ row, historyPreview: true, allowContinuation: false,
      previewReason: '本机 Runner 未运行，可查看已保存的需求会话。恢复 Runner 后可继续。',
      read: async (sourceId, options) => {
        await current();
        const page = await read(sourceId, options, captured, data);
        await current();
        return page;
      } });
    await current();
    for (const name of ['snapshot', 'uiSnapshot', 'historyRow']) {
      const original = view[name];
      view[name] = (...args) => { guard(); return original(...args); };
    }
    return view;
  };
}
module.exports = { create };
