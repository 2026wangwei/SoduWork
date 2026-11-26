/* A UI bookmark into the runtime transcript. Loading history never sends a turn. */
(function (global) {
  'use strict';
  function create(ctx) {
    let archive, tail, boundary;
    function closeEarlier() { archive?.remove(); archive = tail = null; }
    global.addEventListener?.('soduwork-data-scope-changed', closeEarlier);
    const tr = value => global.SoduWorkI18n?.translateText?.(value) || value;
    function pageMessages(snap, start, end) {
      const history = snap.history;
      const fragment = document.createDocumentFragment();
      const summaries = global.ChatTurnSummary;
      const tools = global.ChatTools?.displayTools?.(snap) || snap.tools || [];
      const last = history.messageIndices.at(-1);
      const endsTurn = history.nextIsUser || snap.turnMetrics?.some(turn => turn.toMessage === last);
      const finals = ctx._finalReplyIndexes(snap.messages, tools, endsTurn);
      const turns = new Map(summaries.project(snap, finals).filter(turn => !turn.outcome ||
        snap.turnMetrics.some(metric => metric.outcome === turn.outcome && metric.toMessage === history.messageIndices[turn.to]))
        .map(turn => [turn.outcome ? turn.to : turn.finalIndex, turn]));
      const byMessage = new Map();
      for (const tool of tools) {
        if (!byMessage.has(tool.after)) byMessage.set(tool.after, []);
        byMessage.get(tool.after).push(tool);
      }
      for (const [index, message] of snap.messages.entries()) {
        const absolute = history.messageIndices[index];
        if (absolute < start || absolute >= end) continue;
        const row = document.createElement('div');
        row.className = message.role === 'user' ? 'nmsg user' : 'nmsg ai';
        row.dataset.historyIndex = absolute;
        fragment.append(row);
        const add = (tag, content) => {
          const node = document.createElement(tag);
          node.textContent = content; row.append(node); return node;
        };
        const blocks = message.blocks || [];
        const user = message.role === 'user';
        if (user && message.text) {
          const bubble = add('div', message.text); bubble.className = 'nbubble'; bubble.dataset.userContent = '';
        }
        if (!user) for (const [index, block] of blocks.entries()) {
          if (!block.text) continue;
          if (block.kind === 'thinking') {
            const thought = document.createElement('details'), title = document.createElement('summary');
            title.textContent = tr('思考过程'); thought.append(title, document.createTextNode(block.text)); row.append(thought);
          } else if (block.kind === 'text') {
            const prose = document.createElement('div'); prose.className = 'ntext'; prose.dataset.block = index;
            prose.dataset.userContent = ''; prose.append(global.ChatDomPatch.htmlFragment(ctx.rich(block.text))); row.append(prose);
          }
        }
        if (message.attachments?.length) {
          const files = global.ConversationAttachments?.messageHtml(message.attachments);
          if (files) row.append(global.ChatDomPatch.htmlFragment(files));
          else for (const item of message.attachments) if (item.name) add('small', item.name);
        }
        for (const tool of byMessage.get(index) || []) {
          const presentation = global.ChatTools?.render?.(tool);
          const label = [tr(presentation?.title || tool.name), presentation?.sub].filter(Boolean).join(' · ');
          if (!presentation || presentation.summaryOnly) { add('small', label); continue; }
          const receipt = document.createElement('details'), title = document.createElement('summary');
          title.textContent = label; receipt.append(title); row.append(receipt);
          receipt.ontoggle = () => {
            if (!receipt.open || receipt.childElementCount > 1) return;
            const result = document.createElement('div');
            result.append(global.ChatDomPatch.htmlFragment(presentation.body));
            receipt.append(result);
          };
        }
        const turn = turns.get(index);
        if (user || (finals.has(index) && !turn?.outcome)) {
          const after = turn?.lastToolBlock ?? -1;
          const reply = user ? message.text : blocks.slice(after + 1)
            .filter(block => block.kind === 'text').map(block => block.text).join('\n\n');
          const footer = ctx._messageFooter(message, reply, after, absolute);
          if (footer) row.append(global.ChatDomPatch.htmlFragment(footer));
        }
        if (turn?.outcome === 'stopped') add('small', summaries.stoppedText(turn.elapsedMs));
        else if (turn?.outcome === 'interrupted') add('small', tr('本轮已中断'));
        else if (turn) add('small', tr('用时') + ' ' + summaries.formatDuration(turn.elapsedMs));
      }
      return fragment;
    }
    function earliestLiveIndex() {
      const snap = ctx._snap, first = Math.max(0, (snap?.messages?.length || 0) - (ctx._messageWindowSize || 80));
      return snap?.history?.messageIndices?.[first] ?? (Number(snap?.history?.messageStart) || 0) + first;
    }
    function alignEarlier(snap, first) {
      if (!archive) return;
      // A bounded live tail can slide past messages the reader has already loaded.
      if (first > boundary) {
        const previous = tail?.history;
        // The cursor bounds cover hidden internal messages too. Only visible
        // owners are present in messageIndices, so first - 1 can be absent.
        if (!previous?.messageIndices?.includes(boundary) || !(first <= previous.messageEnd)) { closeEarlier(); return; }
        insertPage(pageMessages(tail, boundary, first), false);
      } else if (first < boundary) {
        while (archive.lastElementChild) {
          const page = archive.lastElementChild;
          while (page.lastElementChild && Number(page.lastElementChild.dataset.historyIndex) >= first)
            page.lastElementChild.remove();
          if (page.childElementCount) break;
          page.remove();
        }
        if (!archive.childElementCount) { closeEarlier(); return; }
      }
      boundary = first; tail = snap;
    }
    function insertPage(fragment, prepend) {
      if (!fragment.childElementCount) return;
      const page = document.createElement('div');
      page.className = 'nchat-history-page'; page.append(fragment);
      if (prepend) archive.prepend(page);
      else archive.append(page);
      global.ChatMedia?.hydrate(page);
      global.ConversationAttachments?.hydrateMessageImages?.(page, { ref: ctx._ref, api: ctx._api() });
      // Measure the new block once. Chromium can now skip layout for distant
      // pages without changing the height of history above the reading anchor.
      page.style.containIntrinsicBlockSize = 'auto ' + page.getBoundingClientRect().height + 'px';
      page.style.contentVisibility = 'auto';
    }
    // Earlier pages share the scroll container, without replacing the live snapshot.
    async function openEarlier(end, current) {
      const scroll = scrollOf(), list = scroll?.querySelector('#nchatList');
      if (!list || end <= 0) return;
      const reply = await ctx._api().snapshot(ctx._ref, { messageEnd: end, messageLimit: 80, toolLimit: 160 });
      if (!current() || !list.isConnected || scroll.__soduworkScrollFollow?.follow) return;
      const snap = reply?.snapshot, history = snap?.history;
      if (!reply?.ok || history?.messageEnd !== end || !(history.messageStart < end))
        throw Error(reply?.reason || tr('更早的对话暂时加载失败，请稍后重试'));
      if (end !== Number(archive?.dataset.historyStart ?? earliestLiveIndex())) return;
      const fragment = pageMessages(snap, history.messageStart, end);
      const anchor = archive?.firstElementChild || list;
      const previous = anchor.getBoundingClientRect().top;
      if (!archive) {
        archive = document.createElement('div'); archive.className = 'nchat-inner nchat-archive';
        boundary = end; tail = ctx._snap; list.before(archive);
      }
      insertPage(fragment, true);
      archive.dataset.historyStart = history.messageStart;
      if (!scroll.__soduworkScrollFollow?.follow) scroll.scrollTop += anchor.getBoundingClientRect().top - previous;
    }
    const scrollOf = () => ctx._mount()?.querySelector('#nchatScroll');
    const messageNodes = scroll => [...(scroll?.querySelectorAll('[data-chat-node^="message:"]') || [])]
      .filter(node => /^message:\d+$/.test(node.dataset.chatNode || ''));
    const windowSize = () => Number(ctx._snap?.history?.messageLimit) ||
      Number(ctx._snap?.history?.loadedMessages) || Number(ctx._messageWindowSize) || 80;
    function capture() {
      const scroll = scrollOf();
      if (!scroll || !ctx._ref) return null;
      const start = Math.max(0, Number(ctx._snap?.history?.messageStart) || 0);
      const reading = { top: Math.max(0, Number(scroll.scrollTop) || 0),
        follow: scroll.__soduworkScrollFollow?.follow === true,
        messageLimit: Math.min(2000, Math.max(80, windowSize())), messageStart: start };
      const bounds = scroll.getBoundingClientRect();
      const visible = item => {
        const box = item.getBoundingClientRect(); return box.bottom > bounds.top && box.top < bounds.bottom;
      };
      // Page boxes retain their measured height offscreen. Only measure rows
      // in pages intersecting the viewport, never wake an entire long transcript.
      let historical;
      for (const page of archive?.children || []) {
        if (!visible(page)) continue;
        historical = Array.from(page.children).find(visible);
        if (historical) break;
      }
      if (historical) {
        reading.anchor = { index: Number(historical.dataset.historyIndex), offset: historical.getBoundingClientRect().top - bounds.top };
        return reading;
      }
      const node = messageNodes(scroll).find(visible);
      if (node) reading.anchor = { index: ctx._snap?.history?.messageIndices?.[Number(node.dataset.chatNode.slice(8))] ??
          start + Number(node.dataset.chatNode.slice(8)),
        offset: node.getBoundingClientRect().top - bounds.top };
      return reading;
    }
    async function restore(reading, isCurrent = () => true) {
      if (!reading || reading.follow !== false || !ctx._ref) return false;
      const scroll = scrollOf(), ref = ctx._ref, epoch = ctx._viewEpoch, scope = ctx._draftScopeEpoch;
      const interaction = scroll?.__soduworkScrollFollow?.interaction || 0;
      const current = () => isCurrent() && ref === ctx._ref && epoch === ctx._viewEpoch && scope === ctx._draftScopeEpoch &&
        scroll === scrollOf() && interaction === (scroll?.__soduworkScrollFollow?.interaction || 0);
      scroll?.__soduworkScrollFollow?.pause?.();
      const total = Number(ctx._snap?.history?.totalMessages) || ctx._snap?.messages?.length || 0;
      const start = Number.isSafeInteger(reading.messageStart) ? reading.messageStart : total;
      // A bookmark saved by an older client may request a 2,000-message
      // live window. Recover its absolute anchor through the same cursor pages.
      const cap = Number.isSafeInteger(reading.anchor?.index) && ctx._openEarlierPage &&
        Number.isSafeInteger(ctx._snap?.history?.messageEnd) ? 160 : 2000;
      const limit = Math.min(cap, Math.max(80, Number(reading.messageLimit) || 80, total - start));
      if (limit > windowSize()) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = ctx._snap;
          const reply = await ctx._api()?.snapshot(ref, { messageLimit: limit, toolLimit: limit * 2 });
          if (!current() || !reply?.ok || !reply.snapshot) return false;
          // The request expands subsequent runtime publications too. Prefer a
          // newer event covering this window; retry a stale initial refresh.
          if (ctx._snap === before) { ctx._snap = reply.snapshot; break; }
          if (windowSize() >= limit) break;
          if (attempt === 2) return false;
        }
        ctx._messageWindowSize = Math.max(limit, windowSize());
        ctx._render();
      }
      if (Number.isSafeInteger(reading.anchor?.index)) {
        let end = Number(archive?.dataset.historyStart ?? earliestLiveIndex());
        try {
          while (current() && reading.anchor.index < end) {
            await openEarlier(end, current);
            const start = Number(archive?.dataset.historyStart);
            if (!(start < end)) return false;
            end = start;
          }
        } catch { return false; }
      }
      return new Promise(resolve => {
        let frames = 0, stable = 0;
        const paint = fn => global.requestAnimationFrame ? global.requestAnimationFrame(fn) : global.setTimeout(fn, 16);
        const apply = () => {
          if (!current() || !scroll) { resolve(false); return; }
          if (scroll.__soduworkScrollFollow?.pause) scroll.__soduworkScrollFollow.pause();
          else if (scroll.__soduworkScrollFollow) scroll.__soduworkScrollFollow.follow = false;
          const anchor = reading.anchor;
          const indices = ctx._snap?.history?.messageIndices;
          const localIndex = Array.isArray(indices) ? indices.indexOf(anchor?.index) :
            anchor?.index - (Number(ctx._snap?.history?.messageStart) || 0);
          const node = archive?.querySelector('[data-history-index="' + Number(anchor?.index) + '"]') ||
            (Number.isSafeInteger(localIndex) && messageNodes(scroll).find(item => item.dataset.chatNode === 'message:' + localIndex));
          const top = node && Number.isFinite(anchor.offset)
            ? Math.max(0, scroll.scrollTop + node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset)
            : Math.max(0, Number(reading.top) || 0);
          stable = Math.abs(scroll.scrollTop - top) < 1 ? stable + 1 : 0;
          scroll.scrollTop = top;
          // content-visibility materializes messages after they enter the
          // viewport, changing estimated heights. Recheck after paint, bounded
          // to this navigation and interrupted immediately by user scrolling.
          if (++frames < 20 && stable < 3) paint(apply);
          else resolve(true);
        };
        paint(apply);
      });
    }
    async function revealSearchMatch(query, isCurrent = () => true) {
      const words = String(query || '').toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      if (!words.length || !isCurrent()) return false;
      const ref = ctx._ref, epoch = ctx._viewEpoch, scope = ctx._draftScopeEpoch;
      const current = () => isCurrent() && ref === ctx._ref && epoch === ctx._viewEpoch && scope === ctx._draftScopeEpoch;
      if (!await restore({ top: 0, follow: false, messageStart: 0, messageLimit: 2000 }, current) || !current()) return false;
      const title = String(ctx._snap?.title || '').toLocaleLowerCase();
      const index = (ctx._snap?.messages || []).findIndex(message => {
        const text = [title, message.text, ...(message.blocks || []).filter(block => block.kind === 'text').map(block => block.text)].join(' ').toLocaleLowerCase();
        return words.every(word => text.includes(word));
      });
      if (index < 0) return false;
      const absolute = ctx._snap?.history?.messageIndices?.[index] ?? (Number(ctx._snap?.history?.messageStart) || 0) + index;
      return restore({ follow: false, messageStart: absolute, anchor: { index: absolute, offset: 24 } }, current);
    }
    return { capture, restore, revealSearchMatch, earliestLiveIndex, openEarlier, closeEarlier, alignEarlier };
  }
  global.ChatReadingPosition = { create };
})(window);
