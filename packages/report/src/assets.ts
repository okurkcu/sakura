/** The report's whole stylesheet, inlined: no external fonts, images or sheets. */
export const REPORT_CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #59636e;
  --border: #d1d9e0;
  --panel: #f6f8fa;
  --link: #0969da;
  --breaking: #cf222e;
  --breaking-bg: #ffebe9;
  --warning: #9a6700;
  --warning-bg: #fff8c5;
  --info: #0969da;
  --info-bg: #ddf4ff;
  --ok: #1a7f37;
  --ok-bg: #dafbe1;
  --added-bg: #dafbe1;
  --removed-bg: #ffebe9;
  --changed-bg: #fff8c5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #9198a1;
    --border: #3d444d;
    --panel: #151b23;
    --link: #4493f8;
    --breaking: #ff7b72;
    --breaking-bg: #3c1618;
    --warning: #d29922;
    --warning-bg: #3a2e12;
    --info: #4493f8;
    --info-bg: #102a4c;
    --ok: #3fb950;
    --ok-bg: #12301d;
    --added-bg: #12301d;
    --removed-bg: #3c1618;
    --changed-bg: #3a2e12;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 1200px; margin: 0 auto; padding: 24px; }
a { color: var(--link); }
h1 { font-size: 24px; margin: 0 0 8px; }
h2 { font-size: 19px; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
h3 { font-size: 16px; margin: 20px 0 8px; }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
pre { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 10px; overflow: auto; margin: 8px 0; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 13px; }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 12px 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid currentColor; }
.badge.breaking, .badge.high, .badge.failed { color: var(--breaking); background: var(--breaking-bg); }
.badge.warning, .badge.medium, .badge.skipped { color: var(--warning); background: var(--warning-bg); }
.badge.info { color: var(--info); background: var(--info-bg); }
.badge.low, .badge.success { color: var(--ok); background: var(--ok-bg); }
.callout { border: 1px solid var(--border); border-left-width: 4px; border-radius: 6px; padding: 12px 16px; margin: 16px 0; background: var(--panel); }
.callout.failed { border-left-color: var(--breaking); }
.callout.skipped { border-left-color: var(--warning); }
.callout.unexpected { border-left-color: var(--breaking); }
.summary li { margin: 6px 0; }
.finding { border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; margin: 10px 0; }
.finding:target { outline: 2px solid var(--link); }
.finding-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.compare { position: relative; display: grid; border: 1px solid var(--border); border-radius: 6px; overflow: auto; max-height: 75vh; background: #fff; }
.compare > img { grid-area: 1 / 1; width: 100%; height: auto; display: block; }
.compare > .after { clip-path: inset(0 0 0 var(--split, 50%)); }
.compare > .overlay { display: none; }
.ui-route:has(.overlay-toggle:checked) .compare > .overlay { display: block; }
.ui-route:has(.overlay-toggle:checked) .compare > .after { display: none; }
.controls { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin: 8px 0; font-size: 13px; }
.controls input[type="range"] { width: 240px; }
.side-by-side { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.side-by-side > div { min-width: 0; }
pre .line { display: block; }
pre .line.changed { background: var(--changed-bg); }
pre .line.added { background: var(--added-bg); }
pre .line.removed { background: var(--removed-bg); }
@media (max-width: 800px) {
  .side-by-side { grid-template-columns: 1fr; }
  main { padding: 16px; }
}
`;

/**
 * The report's only script: drives the before/after sliders. Without JavaScript the comparison
 * stays at 50% and everything else still reads.
 */
export const REPORT_SCRIPT = `
document.querySelectorAll('[data-compare]').forEach(function (route) {
  var slider = route.querySelector('input[type="range"]');
  var compare = route.querySelector('.compare');
  if (!slider || !compare) return;
  function update() { compare.style.setProperty('--split', slider.value + '%'); }
  slider.addEventListener('input', update);
  update();
});
`;

/**
 * Content Security Policy of the report: nothing may load from the network, images only from
 * the run's own files. Defense in depth: the report never references a remote URL anyway.
 */
export const REPORT_CSP =
  "default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";
