'use strict';

const { declaredImages } = require('./kimi-history-images.cjs');
const versions = require('./artifact-versions.cjs');
const runtime = require('./artifact-runtime');

// Prepare the visible gallery independently of the full output index (which
// also opens package workers). A declaration can only filter existing receipts.
async function initial({ profile, row, history, view, guards, scope }) {
  const names = new Set();
  for (const message of view.snapshot().messages || []) {
    if (message.role !== 'assistant') continue;
    const blocks = message.blocks?.length ? message.blocks.filter(block => block.kind === 'text') : [message];
    for (const block of blocks) for (const name of declaredImages(block.text)) names.add(name);
  }
  if (!names.size || names.size > 100) return [];
  const matching = meta => meta?.kind === 'image' && (names.has(meta.relative) || names.has(meta.previewOf));
  const versionsInHistory = history.archive?.versions || [];
  const archived = versionsInHistory.filter(entry => !entry.resource && matching(entry.metadata));
  const items = (history.items || []).filter(entry => matching(entry.metadata));
  if ((!archived.length && !items.length) || archived.length + items.length > 256) return [];
  // The full index derives each turn's boundary from its first verified
  // receipt. Skip the shortcut if another receipt could change that boundary.
  const turns = new Map(archived.map(entry => [entry.turnId, entry.source?.userMessageIndex]));
  const owners = new Map(archived.filter(entry => Number.isSafeInteger(entry.source?.userMessageIndex))
    .map(entry => [entry.source.userMessageIndex, entry.turnId]));
  if (versionsInHistory.some(entry => {
    const index = entry.source?.userMessageIndex;
    return turns.has(entry.turnId) && turns.get(entry.turnId) !== index ||
      owners.has(index) && owners.get(index) !== entry.turnId;
  })) return [];
  // Version readers authorize both before and after asynchronous disk proofs.
  // Direct-only receipts need the same check before the synchronous snapshot.
  if (!archived.length) await guards.authorize();
  const groups = archived.length ? await versions.readers(profile, row.id, { versions: archived }, guards.guard, guards.authorize) : [];
  const originals = items.length ? require('./device-history-artifacts.cjs').archivedView(profile, row.id, row.cwd,
    { ...history, items, resources: [] }, guards.guard, guards.authorize) : null;
  guards.guard();
  return runtime.prepareHistoryGallery(view, groups, originals, scope);
}

module.exports = { initial };
