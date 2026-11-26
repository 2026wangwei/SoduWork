'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assertNoLinks } = require('../plugin-resources');

const captureMessages = new Set([
  '会话成果保存时历史已变化',
  '已归档的原件可从历史成果卡另存。工作副本未能投递，请检查目录权限和可用空间。',
  '会话成果原件已保存。工作目录已有不同内容的同名副本，可从历史成果卡另存。',
  '部分会话成果未完成归档，请保留工作目录中的文件。',
]);

const validKey = key => typeof key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key);

function publishedDirectory(root, parent, name) {
  return validKey(name) && path.relative(root, parent) === '会话成果';
}

function resolve(projectRoot, key) {
  if (!path.isAbsolute(projectRoot) || !validKey(key)) throw Error('会话成果目录无效');
  const base = fs.realpathSync.native(projectRoot);
  const draftRoot = path.join(base, '.soduwork-drafts', key);
  assertNoLinks(base, draftRoot);
  return Object.freeze({ version: 1, projectRoot: base, key, draftRoot });
}

// Only the desktop assigns a namespace. A model, restored CLI or renderer
// cannot select a sibling conversation's folder by supplying a path.
function allocate(cwd, storedKey) {
  return resolve(cwd, storedKey === undefined ? crypto.randomUUID() : storedKey);
}

function root(cwd, workspace) {
  if (!workspace) return cwd;
  const verified = resolve(cwd, workspace.key);
  if (workspace.version !== 1 || workspace.projectRoot !== verified.projectRoot || workspace.draftRoot !== verified.draftRoot)
    throw Error('会话成果目录已变化');
  return verified.draftRoot;
}

function ensure(cwd, workspace) {
  const target = root(cwd, workspace);
  if (workspace) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    root(cwd, workspace);
  }
  return target;
}

// Recheck the whole existing chain at the point of use, including descendants
// selected later by an asynchronous downloader.
function fileGuard(cwd, workspace) {
  if (!workspace) return undefined;
  return target => {
    const base = root(cwd, workspace);
    const relative = path.relative(base, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('会话成果路径越界');
    assertNoLinks(workspace.projectRoot, path.resolve(target));
  };
}

function relativeLink(key, relative) {
  if (!validKey(key)) return;
  try { return '.soduwork-drafts/' + key + '/' + require('./portable-workspace').portablePath(relative); }
  catch (_) { return; }
}

function liveLinks(cwd, workspace) {
  if (!workspace) return;
  const verified = root(cwd, workspace);
  return (item, canonical) => {
    const link = relativeLink(workspace.key, item.relative);
    if (!link || !item.artifactId || !item.path || !canonical) return;
    const expected = path.join(verified, item.relative);
    if (path.relative(expected, item.path) === '' && path.relative(expected, canonical) === '') return link;
  };
}

function historyLinks(row, history) {
  const key = row.deliveryWorkspaceKey;
  if (!validKey(key)) return;
  // Before the receipt recorded its namespace, only the authenticated inventory
  // from that exact draft root can establish a legacy file's project-relative name.
  const sameRoot = row.cwd && history.root && path.relative(path.join(row.cwd, '.soduwork-drafts', key), history.root) === '';
  const originals = new Map((sameRoot ? history.items || [] : []).filter(item => !item.archiveOnly)
    .map(item => [item.metadata.relative, item]));
  const copies = new Map((history.archive?.files || []).map(file => [file.relative, file]));
  return item => {
    const source = item.historicalSource;
    if (source?.sessionId !== row.id) return;
    if (source.deliveryWorkspaceKey) return source.deliveryWorkspaceKey === key ? relativeLink(key, item.relative) : undefined;
    const original = originals.get(item.relative);
    if (!original || original.source?.sessionId !== row.id || original.source?.turnId !== source.turnId) return;
    if (item.versionId) {
      const copy = copies.get(item.relative);
      if (copy?.sha256 !== item.versionHash || !require('./runtime-artifacts.cjs').same(original.stamp, copy?.sourceStamp)) return;
    }
    return relativeLink(key, item.relative);
  };
}

function prompt(workspace) {
  const relative = '.soduwork-drafts/' + workspace.key + '/';
  return 'The selected project remains your working directory. For a request to edit the existing project, read and edit its actual files in place. ' +
    'For any new standalone deliverable (including reports, websites and installable packages), use this conversation’s private delivery directory: ' +
    relative + '. Keep the files needed to use each deliverable together. Save screenshots taken to show or verify the result in ' +
    relative + '.soduwork/evidence/ and link to them in the reply for preview. Only put a screenshot among the deliverables when the user asks for the image file itself. ' +
    'If the user explicitly requests a particular destination, honor it and stage a copy of the final deliverable here. ' +
    'In the final answer use Markdown links with only the filename as the visible label and the file path relative to the delivery directory as the target, e.g. [report.txt](docs/report.txt). Do not use another conversation’s staged files or overwrite published copies.';
}

// Keep a failed capture local to the completed turn. It must never retry an
// already executed model request or make an incomplete journal authoritative.
async function freezeTurn(handle, journal, messages, report) {
  if (!journal || journal.truncated) {
    if (handle.deliveryWorkspace) report('本轮成果未能完整核对，未自动归档。请在会话生成目录中查看原文件。');
    return;
  }
  if (!journal.files?.length) return;
  const unverified = journal.files.filter(row => row.after?.hash?.startsWith('meta:')).length;
  if (handle.deliveryWorkspace && unverified) {
    report(`本轮有 ${unverified} 个文件超过 32 MiB，未自动归档。请在会话生成目录中查看原文件。`);
  }
  if (typeof handle.captureArtifactTurn !== 'function') return;
  const userMessageIndex = messages.findLastIndex(row => row?.role === 'user');
  if (userMessageIndex < 0) return;
  journal.userMessageIndex = userMessageIndex;
  try {
    await handle.captureArtifactTurn(journal);
  } catch (error) {
    report(captureMessages.has(error?.message) ? error.message : '本轮成果归档失败。请在会话生成目录中查看原文件。');
  }
}

async function deliverySnapshot(cwd, workspace, snapshot) {
  if (!workspace) return null;
  try {
    const target = root(cwd, workspace);
    const result = await snapshot(target, { includeEvidence: true });
    root(cwd, workspace);
    if (result.cwd && result.cwd !== target) return null;
    // A new, still-absent directory is a valid empty baseline.
    if (!result.cwd && fs.existsSync(target)) return null;
    return { ...result, cwd: target };
  } catch (_) { return null; }
}

function changes(before, after, turnId) {
  if (!before || !after || before.cwd !== after.cwd) return null;
  return require('./file-change-journal').compare(before, after, { turnId });
}

module.exports = { allocate, changes, deliverySnapshot, ensure, fileGuard, freezeTurn, historyLinks, liveLinks, prompt, publishedDirectory, resolve, root, validKey };
