'use strict';

const SETTLED_TOOLS = new Set(['done', 'completed', 'error', 'failed', 'cancelled', 'canceled']);
const missingReceipt = tool => tool.phase !== 'preparing' && !SETTLED_TOOLS.has(tool.state);
const unresolvedTools = snapshot => (snapshot?.tools || []).filter(missingReceipt)
  .map(tool => ({ id: tool.id, callId: tool.callId || tool.id, name: tool.name || '', reason: 'missing-terminal-receipt' }));

function hasUnresolvedTools(history) {
  return Boolean(history?.coverage?.unresolvedTools?.length || history?.snapshot?.tools?.some(missingReceipt));
}

module.exports = { unresolvedTools, hasUnresolvedTools };
