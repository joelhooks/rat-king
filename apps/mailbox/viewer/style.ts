export const stylesheet = `
:root {
  color-scheme: light;
  --accent: #ff1493;
  --accent-text: #c8006e;
  --code-ink: #4c4f69;
  --code-keyword: #303446;
  --code-bg: #eff1f5;
  --code-border: #ccd0da;
  --space-tight: 0.375rem;
  --space-small: 0.75rem;
  --space-section: 2rem;
  --top-size: 3.5rem;
}
html { font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
* { box-sizing: border-box; }
body { margin: 0; background: white; color: black; }
h1,h2,h3,p { margin: 0; }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.muted,.eyebrow { color: var(--code-ink); font-size: .75rem; }
.eyebrow { letter-spacing: .04em; text-transform: uppercase; }
.top { display: flex; align-items: center; gap: var(--space-small); height: var(--top-size); padding-inline: var(--space-small); border-bottom: 1px solid; }
.brandmark { color: var(--accent-text); font-weight: bold; }
.brand { font-weight: bold; }
.top .eyebrow { margin-left: auto; }
.shell { display: grid; grid-template-columns: minmax(13ch,14.5rem) minmax(24ch,.85fr) minmax(30ch,1.4fr); height: calc(100dvh - var(--top-size)); }
.rail,.list,.detail { min-width: 0; overflow: auto; }
.rail,.list { border-right: 1px solid; }
.rail { display: flex; flex-direction: column; padding: var(--space-small); }
.railhead { margin-bottom: var(--space-small); }
.railhead strong { display: block; font-size: 1.25rem; }
.nav { display: flex; gap: var(--space-tight); justify-content: space-between; align-items: center; min-height: 2.5rem; padding: var(--space-tight); text-decoration: none; }
.nav[aria-current],.row[aria-current] { border-left: 2px solid var(--accent); background: var(--code-bg); }
.nav[aria-current] { color: var(--accent-text); font-weight: bold; }
.nav:hover,.row:hover { background: var(--code-bg); }
.qty { color: var(--code-ink); font-size: .75rem; }
.network { margin-top: auto; padding: var(--space-tight); border: 1px solid var(--code-border); }
.network p { margin-top: var(--space-tight); }
.dot { display: inline-block; width: .5rem; height: .5rem; border: 1px solid currentColor; }
.dot.live { background: var(--accent); }
.listhead { padding: var(--space-small); }
.listhead h1 { font-size: 1.625rem; }
.filterbar { display: flex; gap: var(--space-tight); flex-wrap: wrap; margin-top: var(--space-small); }
.filterbar a { border: 1px solid var(--code-border); padding: .1em .25em; font-size: .875rem; }
.filterbar a[aria-current] { border-color: var(--accent-text); color: var(--accent-text); font-weight: bold; background: var(--code-bg); }
.caption { padding: .25rem var(--space-small); border-block: 1px solid; background: var(--code-bg); }
.row { display: block; color: inherit; text-decoration: none; border-bottom: 1px solid var(--code-border); border-left: 2px solid transparent; padding: var(--space-tight) var(--space-small); min-height: 5rem; }
.row strong { display: block; margin-block: .25rem; }
.rowtop { display: flex; justify-content: space-between; align-items: center; gap: var(--space-tight); flex-wrap: wrap; }
.chip { display: inline-block; background: var(--code-bg); border: 1px solid var(--code-border); padding: .1em .25em; font-size: .75rem; line-height: 1.25; color: var(--code-keyword); }
.chip.sealed,.chip.pending { color: var(--accent-text); }
.detailtop { padding: var(--space-small) var(--space-section) 0; }
.detailtop h2 { font-size: clamp(1.5rem,2.4vw,2rem); line-height: 1.15; margin-block: var(--space-tight); }
.askbox { margin: var(--space-small) var(--space-section) 0; padding: var(--space-tight) var(--space-small); border: 1px solid; }
.askbox>div+div { margin-top: var(--space-tight); }
.stream { padding: var(--space-small) var(--space-section) var(--space-section); }
.stream h3 { display: flex; align-items: center; gap: var(--space-tight); }
.stream h3::after { content: ''; height: 1px; background: currentColor; flex: 1; }
.message { display: grid; grid-template-columns: 2rem minmax(0,1fr); gap: var(--space-tight); padding-block: var(--space-tight); }
.message+.message { border-top: 1px solid var(--code-border); }
.avatar { display: grid; place-items: center; width: 2rem; height: 2rem; background: var(--code-bg); border: 1px solid var(--code-border); color: var(--code-keyword); font-size: .75rem; font-weight: bold; }
.messagemeta { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-tight); }
.messagemeta time { margin-left: auto; font-size: .75rem; color: var(--code-ink); }
.summary { display: block; margin-top: var(--space-tight); }
.message p { margin-block: .25rem; max-width: 80ch; }
.body { white-space: pre-wrap; }
.sealedbody { background: var(--code-bg); color: var(--code-ink); border: 1px dashed var(--code-ink); padding: var(--space-tight); }
.empty { padding: var(--space-small); color: var(--code-ink); }
.back { display: none; }
@media(max-width:63rem) {
  .detailtop,.stream { padding-inline: var(--space-small); }
  .askbox { margin-inline: var(--space-small); }
}
@media(max-width:48.75rem) {
  .shell { display: block; height: auto; }
  .rail,.list,.detail { border-right: 0; overflow: visible; }
  .rail { border-bottom: 1px solid; }
  .rail nav { display: flex; gap: var(--space-tight); flex-wrap: wrap; }
  .nav { min-height: 44px; }
  .network { margin-top: var(--space-small); }
  .shell:not(.drill-in) .detail,.drill-in .rail,.drill-in .list { display: none; }
  .back { display: inline-flex; align-items: center; min-height: 44px; margin-inline: var(--space-small); }
}
`;
