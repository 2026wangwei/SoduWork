/* Shared Markdown dialect for desktop rendering, previews and speech. */
(function (global) {
  'use strict';
  const commonjs = typeof module !== 'undefined' && module.exports;
  const marked = commonjs ? require('../vendor/markdown/marked.umd.js') : global.marked;
  const nativeEmStrong = marked.Tokenizer.prototype.emStrong;
  const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const nonAscii = /[^\x00-\x7f]/u;
  const punctuation = /\p{P}/u;
  const cjkStrongEnd = /[^\x00-\x7f](?=\*{2}(?!\*)[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu;
  marked.use({
    extensions: [{
      name: 'legacyMediaFence', level: 'block',
      start(src) {
        // The next blank line already ends the current paragraph.
        const end = src.indexOf('\n\n');
        const marker = /\n {0,3}soduwork-media[ \t]*```json\b/.exec(end < 0 ? src : src.slice(0, end));
        return marker ? marker.index + 1 : undefined;
      },
      tokenizer(src) {
        // Some saved replies joined the media label to the JSON opening fence.
        // Consume its closing fence here so the rest of the reply stays Markdown.
        const block = /^ {0,3}soduwork-media[ \t]*```json[ \t]*(?:\n|(?=\{))([\s\S]*?)\n {0,3}```[ \t]*(?:\n|$)/.exec(src);
        if (block) return { type: 'code', raw: block[0], lang: 'soduwork-media', text: block[1] };
      },
    }],
    hooks: {
      emStrongMask(maskedSrc) {
        // Adjust delimiter classification only in Marked's masked scan. Code,
        // links and escapes stay masked; raw text and nested tokens use src.
        // Run once per inline scan, including when strong is nested in emphasis.
        return maskedSrc.replace(cjkStrongEnd, (char) => (
          punctuation.test(char) ? 'a'.repeat(char.length) : char
        ));
      },
    },
    tokenizer: {
      emStrong(src, maskedSrc, prevChar) {
        if (!/^\*{2}(?!\*)/.test(src)) return false;
        const first = String.fromCodePoint(src.codePointAt(2) || 0);
        // Chinese quotation marks can also start a bold span next to CJK text.
        if (cjkCharacter.test(prevChar || '') && nonAscii.test(first) && punctuation.test(first)) {
          return nativeEmStrong.call(this, src, maskedSrc, ' ');
        }
        return false;
      },
      del(src) {
        // Single tildes commonly separate numeric ranges. Only explicit double
        // tildes delegate to GFM; returning undefined prevents single-tilde fallback.
        if (src.startsWith('~~')) return false;
      },
    },
  });
  if (commonjs) module.exports = marked;
})(globalThis);
