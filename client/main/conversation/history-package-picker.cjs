'use strict';

const fs = require('node:fs');
const path = require('node:path');
const resources = require('../plugin-resources');
const packageName = /(?:\bsoduwork-plugin-draft\.json\b|\.soduwork-plugin\b)/i;

// An authoring receipt can offer a file picker. It never grants access to a
// path supplied by a message or tool, even when the tool completed successfully.
function authoredKind(snapshot) {
  const attempts = new Set((snapshot?.tools || []).filter(tool => tool.state === 'done' &&
    (['write', 'edit', 'write_file', 'edit_file'].includes(String(tool.name).toLowerCase()) && packageName.test(tool.args?.path || tool.args?.file_path || '') ||
      ['bash', 'shell', 'exec_command'].includes(String(tool.name).toLowerCase()) && packageName.test(tool.args?.command || tool.args?.cmd || ''))).map(tool => tool.after));
  let selection, kind;
  for (const [index, message] of (snapshot?.messages || []).entries()) {
    if (message.role === 'user') {
      const ids = (message.plugins || []).map(plugin => plugin.pluginId);
      selection = ids.includes('local:app-developer') ? 'app' : ids.includes('local:plugin-builder') ? 'plugin' : null;
    }
    if (selection && (attempts.has(index) || message.role === 'assistant' && packageName.test(message.text || '') ||
        message.role === 'assistant' && message.blocks?.some(block => block.kind === 'text' && packageName.test(block.text || ''))))
      kind = kind && kind !== selection ? 'both' : selection;
  }
  return kind;
}

async function choose({ app, dialog, cwd, kind, authorize, preserve }) {
  await authorize();
  const result = await dialog.showOpenDialog(require('../native-locale.cjs').dialogOptions({
    title: '选择会话生成的草稿或安装包', defaultPath: cwd, properties: ['openFile'],
    filters: [{ name: 'SoduWork', extensions: ['json', 'soduwork-plugin', 'zip'] }],
  }));
  if (result.canceled || !result.filePaths?.length) return { ok: true, canceled: true };
  await authorize();
  const file = result.filePaths[0];
  resources.assertNoLinks(cwd, file);
  if (path.relative(fs.realpathSync(file), path.join(fs.realpathSync(cwd), path.relative(cwd, file)))) throw Error('所选文件已移动，请重新选择');
  const archive = /\.(?:soduwork-plugin|zip)$/i.test(file);
  if (!archive && !/^(?:soduwork-plugin-draft|plugin)\.json$/i.test(path.basename(file)))
    throw Error('请选择 soduwork-plugin-draft.json、plugin.json 或已导出的插件包');
  const checked = await require('../app-resource-cache.cjs').request({ action: 'selected-history-package',
    root: cwd, relative: path.relative(cwd, file).split(path.sep).join('/'),
    skillRuntimeEntry: require('./skill-frontmatter').runtimeEntry(app, true) });
  await authorize();
  const body = checked?.body;
  if (!body || !['app', 'method', 'connector', 'workflow'].includes(body.template) ||
      kind === 'app' && body.template !== 'app' || kind === 'plugin' && body.template === 'app')
    throw Error('所选文件与本会话制作的类型不一致');
  const personal = require('../personal-plugins');
  const { body: normalized } = personal.build(body);
  if (personal._read(app).plugins.some(plugin => plugin.key === normalized.key))
    return { ok: true, installed: true };
  const access = require('../plugin-source-access').authorizer({ app,
    identityOf: async () => require('./requirement-context').cachedIdentity(app),
    read: personal._read, normalizeBody: value => value });
  const allowed = await access.body(body);
  await authorize();
  if (preserve) {
    await preserve(path.relative(cwd, file).split(path.sep).join('/'), checked.selectedFiles);
    await authorize();
  }
  return { ok: true, body: require('../jiyong-edit-source.cjs').historicalBody(app, allowed, checked.editBaseline, archive) };
}

module.exports = { authoredKind, choose };
