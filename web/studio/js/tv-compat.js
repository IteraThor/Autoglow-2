window.__started = 1;
// Small fills for TV browsers older than Chrome 69 (webOS 4, older Tizen). Syntax (?. ?? spread) is
// handled by the build (build-tv.sh); these are the library methods the dashboard calls.
if (!Array.prototype.flatMap) {
  Object.defineProperty(Array.prototype, 'flatMap', {
    configurable: true, writable: true,
    value(fn, self) { return this.reduce((out, x, i, a) => out.concat(fn.call(self, x, i, a)), []); }
  });
}
if (!Object.fromEntries) {
  Object.fromEntries = it => { const o = {}; for (const [k, v] of it) o[k] = v; return o; };
}
// replaceChildren: Chrome 86
if (!Element.prototype.replaceChildren) {
  Element.prototype.replaceChildren = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
    for (let i = 0; i < arguments.length; i++) {
      const n = arguments[i];
      this.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
    }
  };
}
