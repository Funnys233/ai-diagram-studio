// Small shared SSE decoder. UTF-8 decoding belongs to the transport; this handles
// split lines, CR/LF/CRLF, comments and multi-line data without dispatching partial events.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DiagramSse = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createParser(onEvent, maxBuffer = 1048576) {
    let line = '', event = '', data = [], size = 0, afterCr = false, first = true;
    function consume() {
      if (!line) {
        if (data.length) onEvent({ event: event || 'message', data: data.join('\n') });
        event = ''; data = []; size = 0;
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        if (field === 'data') data.push(value);
      }
      line = '';
    }
    return { push(text) {
      for (const char of text) {
        if (first) { first = false; if (char === '\uFEFF') continue; }
        if (afterCr) { afterCr = false; if (char === '\n') continue; }
        if (++size > maxBuffer) throw new Error('流式事件超过大小限制');
        if (char === '\r' || char === '\n') { consume(); afterCr = char === '\r'; }
        else line += char;
      }
    } };
  }
  return { createParser };
});
