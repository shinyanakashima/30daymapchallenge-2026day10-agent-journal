// Runs map code written by the model in an isolated iframe and returns the SVG it drew.
// The iframe has sandbox="allow-scripts" (no same-origin access, so no access to the
// API key or the journal) and a CSP that blocks all network requests.
import d3Source from '../../node_modules/d3/dist/d3.min.js?raw';

export const WIDTH = 1200;
export const HEIGHT = 900;

export type RunResult = { ok: true; svg: string; logs: string[] } | { ok: false; error: string; logs: string[] };

const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">
<style>html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#fff}</style>
<script>${d3Source.replace(/<\/script/gi, '<\\/script')}</script>
</head><body>
<svg id="map" xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"></svg>
<script>
(function(){
  var logs = [];
  var nonce = null;
  var done = false;
  function send(msg){ if (done) return; done = true; msg.nonce = nonce; msg.logs = logs; parent.postMessage(msg, '*'); }
  ['log','warn','error'].forEach(function(k){ var o = console[k]; console[k] = function(){ try { logs.push(k + ': ' + Array.prototype.map.call(arguments, String).join(' ')); } catch(e){} o.apply(console, arguments); }; });
  window.addEventListener('error', function(e){ send({ type: 'error', error: String(e.message || e.error) + (e.lineno ? ' (line ' + e.lineno + ')' : '') }); });
  window.addEventListener('unhandledrejection', function(e){ send({ type: 'error', error: String(e.reason && e.reason.stack || e.reason) }); });
  function parse(path, text){
    var ext = path.split('.').pop().toLowerCase();
    if (ext === 'json' || ext === 'geojson' || ext === 'topojson') return JSON.parse(text);
    if (ext === 'csv') return d3.csvParse(text, d3.autoType);
    if (ext === 'tsv') return d3.tsvParse(text, d3.autoType);
    return text;
  }
  window.addEventListener('message', function(ev){
    var m = ev.data || {};
    if (m.type !== 'run') return;
    nonce = m.nonce;
    var data = {};
    try { Object.keys(m.files || {}).forEach(function(p){ data[p] = parse(p, m.files[p]); }); }
    catch (e) { send({ type: 'error', error: 'Could not parse data: ' + e }); return; }
    var svgEl = document.getElementById('map');
    var svg = d3.select(svgEl);
    var fn;
    try { fn = new Function('d3', 'svg', 'data', 'width', 'height', '"use strict";\\nreturn (async () => {\\n' + m.code + '\\n})();'); }
    catch (e) { send({ type: 'error', error: 'Syntax error: ' + e.message }); return; }
    Promise.resolve().then(function(){ return fn(d3, svg, data, ${WIDTH}, ${HEIGHT}); }).then(function(){
      // Not requestAnimationFrame: Chrome does not run it in an off-screen cross-origin iframe.
      setTimeout(function(){ setTimeout(function(){
        if (!svgEl.childNodes.length) { send({ type: 'error', error: 'The code ran but drew nothing in svg.' }); return; }
        svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svgEl.setAttribute('width', '${WIDTH}'); svgEl.setAttribute('height', '${HEIGHT}');
        send({ type: 'done', svg: new XMLSerializer().serializeToString(svgEl) });
      }, 0); }, 30);
    }).catch(function(e){ send({ type: 'error', error: String(e && e.stack || e) }); });
  });
  parent.postMessage({ type: 'ready' }, '*');
})();
</script></body></html>`;

/** Run code with d3, svg (1200×900 selection), data (parsed files), width, height. */
export function runMap(code: string, files: Record<string, string>, timeoutMs = 10000): Promise<RunResult> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = `position:fixed;left:-${WIDTH + 100}px;top:0;width:${WIDTH}px;height:${HEIGHT}px;border:0;visibility:hidden`;
    const nonce = crypto.randomUUID();
    let finished = false;
    const finish = (r: RunResult) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      iframe.remove();
      resolve(r);
    };
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== iframe.contentWindow) return;
      const m = ev.data || {};
      if (m.type === 'ready') {
        iframe.contentWindow!.postMessage({ type: 'run', nonce, code, files }, '*');
        return;
      }
      if (m.nonce !== nonce) return;
      if (m.type === 'done' && typeof m.svg === 'string') finish({ ok: true, svg: m.svg, logs: m.logs ?? [] });
      else finish({ ok: false, error: String(m.error ?? 'Unknown error'), logs: m.logs ?? [] });
    };
    window.addEventListener('message', onMessage);
    const timer = window.setTimeout(() => finish({ ok: false, error: `Timed out after ${timeoutMs / 1000} s`, logs: [] }), timeoutMs);
    iframe.srcdoc = HARNESS;
    document.body.append(iframe);
  });
}

/** Rasterise SVG markup to 1200×900 RGBA on a white background. Scripts in the SVG do not run in an <img>. */
export async function rasterize(svg: string): Promise<Uint8ClampedArray> {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(WIDTH, HEIGHT);
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.drawImage(img, 0, 0, WIDTH, HEIGHT);
    return ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
  } finally {
    URL.revokeObjectURL(url);
  }
}
