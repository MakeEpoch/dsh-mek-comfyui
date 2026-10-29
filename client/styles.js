/**
 * Shared stylesheet for `dsh-mek-comfyui`.
 *
 * One `<style data-dsh-css="dsh-comfyui">` tag serves the settings page, the
 * sidebar panel, and the conversation card. It is installed on first use,
 * reference-counted across mounts, and removed when the last consumer
 * unmounts or the plugin is cleaned up. Visual language follows the shipped
 * plugins: 13px body text, 12px hints, 8px control radius, 12px card radius,
 * and the `--dsw-alias-*` design tokens (with literal fallbacks so a Host
 * without them still looks deliberate).
 */

/** Attribute value identifying the single stylesheet tag. */
export const STYLE_ID = 'dsh-comfyui';

/** CSS custom-property fallbacks used throughout the rules below. */
const CSS = `
.cfq,.cfqp,.cfqt{--cfq-bg-l1:var(--dsw-alias-bg-l1,#fff);--cfq-bg-l2:var(--dsw-alias-bg-l2,#f4f4f5);--cfq-border:var(--dsw-alias-border-l2,#e3e3e6);--cfq-text:var(--dsw-alias-label-primary,#1a1a1a);--cfq-text-2:var(--dsw-alias-label-secondary,#5c5c66);--cfq-text-3:var(--dsw-alias-label-tertiary,#8b8b94);--cfq-accent:var(--dsw-alias-state-business-primary,#4a6cf7);--cfq-ok:var(--dsw-alias-state-success-primary,#3a9b6c);--cfq-warn:var(--dsw-alias-state-warning-primary,#b8860b);--cfq-err:var(--dsw-alias-state-error-primary,#c5524a);color:var(--cfq-text);font-size:13px;line-height:20px}
.cfq *,.cfq *::before,.cfq *::after,.cfqp *,.cfqp *::before,.cfqp *::after,.cfqt *,.cfqt *::before,.cfqt *::after{box-sizing:border-box}

/* ---------- shared primitives ---------- */
.cfq-card{border:0.5px solid var(--cfq-border);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px;background:var(--cfq-bg-l1);min-width:0}
.cfq-cardHead{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.cfq-cardTitle{font-size:14px;font-weight:600}
.cfq-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;border:0.5px solid var(--cfq-border);color:var(--cfq-text-2);white-space:nowrap}
.cfq-pill[data-tone=success]{color:var(--cfq-ok)}
.cfq-pill[data-tone=error]{color:var(--cfq-err)}
.cfq-pill[data-tone=running]{color:var(--cfq-accent)}
.cfq-pill[data-tone=warn]{color:var(--cfq-warn)}
.cfq-pill[data-tone=muted]{color:var(--cfq-text-3)}
.cfq-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
.cfq-hint{font-size:12px;line-height:18px;color:var(--cfq-text-3)}
.cfq-err{font-size:12px;line-height:18px;color:var(--cfq-err)}
.cfq-ok{font-size:12px;line-height:18px;color:var(--cfq-ok)}
.cfq-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--cfq-text-3);word-break:break-all}
.cfq-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:28px 16px;text-align:center;color:var(--cfq-text-3);font-size:12px;line-height:18px}
.cfq-empty strong{font-size:13px;font-weight:600;color:var(--cfq-text-2)}
.cfq-banner{border-radius:10px;padding:9px 12px;background:var(--cfq-bg-l2);font-size:12px;line-height:18px;color:var(--cfq-text-2);display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}
.cfq-banner[data-tone=warn]{color:var(--cfq-warn);border:0.5px solid color-mix(in srgb,var(--cfq-warn) 35%,transparent)}
.cfq-banner[data-tone=error]{color:var(--cfq-err);border:0.5px solid color-mix(in srgb,var(--cfq-err) 35%,transparent)}
.cfq-banner[data-tone=info]{color:var(--cfq-text-2)}
.cfq-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* ---------- controls ---------- */
.cfq button,.cfqp button,.cfqt button{font:inherit;font-size:13px;line-height:18px;cursor:pointer;border-radius:8px;padding:5px 12px;color:var(--cfq-text);background:var(--cfq-bg-l2);border:0.5px solid var(--cfq-border);min-height:30px}
.cfq button:hover:not(:disabled),.cfqp button:hover:not(:disabled),.cfqt button:hover:not(:disabled){border-color:color-mix(in srgb,var(--cfq-accent) 40%,var(--cfq-border))}
.cfq button:disabled,.cfqp button:disabled,.cfqt button:disabled{opacity:.55;cursor:not-allowed}
.cfq button[data-kind=primary],.cfqp button[data-kind=primary],.cfqt button[data-kind=primary]{background:var(--cfq-accent);border-color:transparent;color:#fff}
.cfq button[data-kind=ghost],.cfqp button[data-kind=ghost]{background:transparent}
.cfq button[data-kind=danger],.cfqp button[data-kind=danger]{color:var(--cfq-err)}
.cfq button:focus-visible,.cfqp button:focus-visible,.cfqt button:focus-visible,.cfq input:focus-visible,.cfq select:focus-visible,.cfq textarea:focus-visible,.cfqp input:focus-visible,.cfqp select:focus-visible,.cfqp textarea:focus-visible{outline:2px solid var(--cfq-accent);outline-offset:1px}
.cfq input[type=text],.cfq input[type=password],.cfq input[type=number],.cfq input[type=search],.cfq select,.cfq textarea,.cfqp input[type=text],.cfqp input[type=number],.cfqp input[type=search],.cfqp select,.cfqp textarea{font:inherit;font-size:13px;color:var(--cfq-text);background:var(--cfq-bg-l2);border:0.5px solid var(--cfq-border);border-radius:8px;padding:5px 9px;min-width:0;width:100%;min-height:32px}
.cfq textarea,.cfqp textarea{resize:vertical;font-family:inherit;line-height:19px}
.cfq input[type=checkbox],.cfq input[type=radio],.cfqp input[type=checkbox]{accent-color:var(--cfq-accent);width:14px;height:14px;margin:0}
.cfq-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.cfq-field>span{font-size:12px;line-height:18px;color:var(--cfq-text-2)}
.cfq-field small{font-size:11px;line-height:16px;color:var(--cfq-text-3)}
.cfq-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px 16px}
.cfq-grid[data-cols="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}
.cfq-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:0.5px solid var(--cfq-border);flex-wrap:wrap}
.cfq-row:last-child{border-bottom:0}
.cfq-rowMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 220px}
.cfq-rowTitle{font-size:13px;font-weight:500;overflow-wrap:anywhere}
.cfq-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.cfq-switch{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
.cfq-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:var(--cfq-text-2);cursor:pointer}
.cfq-check input{margin-top:2px}
.cfq-adv{border-top:0.5px solid var(--cfq-border);padding-top:10px;margin-top:2px}
.cfq-adv>summary{cursor:pointer;font-size:12px;color:var(--cfq-text-2);list-style:none;display:flex;align-items:center;gap:6px}
.cfq-adv>summary::-webkit-details-marker{display:none}
.cfq-adv>summary::before{content:'▸';font-size:10px;transition:transform .12s ease}
.cfq-adv[open]>summary::before{transform:rotate(90deg)}
.cfq-adv[open]>div{margin-top:10px}
.cfq-chips{display:flex;flex-wrap:wrap;gap:6px}
.cfq-chip{font-size:12px!important;line-height:16px!important;padding:2px 9px!important;min-height:24px!important;border-radius:999px!important;background:var(--cfq-bg-l2)!important;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cfq-chip[data-copied=true]{color:var(--cfq-ok)!important;border-color:currentColor!important}

/* ---------- settings page ---------- */
.cfq{width:100%;max-width:820px;min-width:0;display:flex;flex-direction:column;gap:14px}
.cfq-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.cfq-header h2{margin:0;font-size:17px;line-height:24px;font-weight:600}
.cfq-header p{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--cfq-text-3)}
.cfq .cfq-tabs{display:flex;gap:4px;border-bottom:0.5px solid var(--cfq-border);overflow-x:auto;scrollbar-width:thin}
.cfq .cfq-tab{flex:0 0 auto;white-space:nowrap;font:inherit;font-size:13px;cursor:pointer;color:var(--cfq-text-2);background:none;border:0;border-bottom:2px solid transparent;border-radius:0;padding:7px 12px;margin-bottom:-0.5px;min-height:34px}
.cfq .cfq-tab:hover{color:var(--cfq-text)}
.cfq .cfq-tab[aria-selected=true]{color:var(--cfq-accent);border-bottom-color:var(--cfq-accent);font-weight:600}
.cfq-panel{display:flex;flex-direction:column;gap:14px}
.cfq-footer{position:sticky;bottom:0;z-index:2;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 0;background:var(--cfq-bg-l1);border-top:0.5px solid var(--cfq-border)}
.cfq-footer .cfq-hint{flex:1 1 160px}
.cfq-seg{display:inline-flex;border:0.5px solid var(--cfq-border);border-radius:8px;overflow:hidden;background:var(--cfq-bg-l2)}
.cfq .cfq-seg>button,.cfqp .cfq-seg>button{border:0;border-radius:0;background:transparent;min-height:28px;padding:4px 12px}
.cfq .cfq-seg>button[aria-pressed=true],.cfqp .cfq-seg>button[aria-pressed=true]{background:var(--cfq-accent);color:#fff}
.cfq-quick{display:flex;flex-wrap:wrap;gap:6px}
.cfq .cfq-quick>button,.cfqp .cfq-quick>button{min-height:26px;padding:2px 10px;font-size:12px}
.cfq-stat{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--cfq-text-2)}
.cfq-stat b{font-weight:600;color:var(--cfq-text);font-variant-numeric:tabular-nums}
.cfq-presetForm{border-top:0.5px solid var(--cfq-border);padding-top:12px;display:flex;flex-direction:column;gap:12px}

/* ---------- sidebar panel ---------- */
.cfqp{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;background:var(--cfq-bg-l1)}
.cfqp-top{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:0.5px solid var(--cfq-border);flex:0 0 auto;flex-wrap:wrap}
.cfqp-top .cfq-seg{flex:1 1 auto}
.cfqp-top .cfq-seg>button{flex:1 1 0;min-width:0;justify-content:center}
.cfqp-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin}
.cfqp-sec{display:flex;flex-direction:column;gap:8px;min-width:0}
.cfqp-secHead{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--cfq-text-2);flex-wrap:wrap}
.cfqp-secTitle{font-size:12px;font-weight:600;color:var(--cfq-text-2);letter-spacing:.02em}
.cfqp-card{border:0.5px solid var(--cfq-border);border-radius:12px;background:var(--cfq-bg-l1);padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.cfqp-card[data-state=running]{border-color:color-mix(in srgb,var(--cfq-accent) 45%,var(--cfq-border))}
.cfqp-prompt{font-size:12px;line-height:18px;color:var(--cfq-text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.cfqp-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;line-height:16px;color:var(--cfq-text-3)}
.cfqp-thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px}
.cfqp-thumb{position:relative;display:block;border-radius:8px;overflow:hidden;border:0.5px solid var(--cfq-border);background:var(--cfq-bg-l2);aspect-ratio:1/1}
.cfqp-thumb img{width:100%;height:100%;object-fit:cover;display:block}
/* ── gallery wall ────────────────────────────────────────────────────────────
   Multi-column masonry: every image keeps its own aspect ratio (a 16:9 and a
   9:16 generation both look right instead of being cropped to a square), and
   CSS columns pack them without a measuring pass; break-inside:avoid keeps
   one image from splitting across a column. column-width (not column-count)
   makes the density follow the container: the right sidebar is ~400px wide but
   the viewport may be very wide, so a viewport media query would pack three
   columns into a narrow panel. */
.cfqw-wall{column-width:132px;column-gap:8px}
.cfqw-item{position:relative;break-inside:avoid;margin:0 0 8px;border-radius:10px;overflow:hidden;border:0.5px solid var(--cfq-border);background:var(--cfq-bg-l2);display:block}
.cfqw-item[data-favorite=true]{border-color:#e8b84b}
.cfqw-open{display:block;width:100%;padding:0;border:0;background:none;cursor:zoom-in;line-height:0}
.cfqw-open img{width:100%;height:auto;display:block}
.cfqw-open:focus-visible{outline:2px solid var(--cfq-accent,#4a6cf7);outline-offset:-2px}
.cfqw-badge{position:absolute;top:5px;left:5px;font-size:10px;line-height:14px;padding:0 5px;border-radius:6px;background:rgba(20,20,24,.7);color:#ffd166}
.cfqw-size{position:absolute;top:5px;right:5px;font-size:10px;line-height:14px;padding:0 5px;border-radius:6px;background:rgba(20,20,24,.55);color:rgba(255,255,255,.9);opacity:0;transition:opacity .12s ease}
.cfqw-item:hover .cfqw-size,.cfqw-item:focus-within .cfqw-size{opacity:1}
.cfqw-actions{position:absolute;inset:auto 0 0 0;display:flex;gap:3px;justify-content:flex-end;padding:4px;background:linear-gradient(transparent,rgba(0,0,0,.6));opacity:0;transition:opacity .12s ease}
.cfqw-item:hover .cfqw-actions,.cfqw-item:focus-within .cfqw-actions{opacity:1}
.cfqw-actions button,.cfqw-actions a{font-size:11px!important;line-height:14px!important;min-height:22px!important;padding:1px 7px!important;border-radius:6px!important;background:rgba(20,20,24,.74)!important;border-color:transparent!important;color:#fff!important;text-decoration:none;display:inline-flex;align-items:center}
.cfqw-actions button[data-fav=true]{color:#ffd166!important}
.cfqw-actions button:focus-visible,.cfqw-actions a:focus-visible{outline:2px solid #fff;outline-offset:1px}

/* ── image viewer ────────────────────────────────────────────────────────────
   Full-screen overlay; the fixed layer sits above the shell's own stacking so a
   sidebar scroll position cannot clip it. */
.cfql-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(12,13,17,.86);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.cfql-dialog{display:flex;flex-direction:column;width:100%;max-width:min(1040px,100%);max-height:100%;background:var(--cfq-bg-l1,#1b1c21);color:var(--cfq-text);border:0.5px solid rgba(255,255,255,.14);border-radius:14px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.55)}
.cfql-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-bottom:0.5px solid rgba(255,255,255,.1)}
.cfql-count{font-size:12px;color:var(--cfq-text-3);font-variant-numeric:tabular-nums}
.cfql-headActions{display:flex;align-items:center;gap:8px}
.cfql-link{font-size:11px;color:var(--cfq-text-3);text-decoration:none;padding:3px 8px;border-radius:6px;border:0.5px solid rgba(255,255,255,.16)}
.cfql-link:hover{color:var(--cfq-text);border-color:rgba(255,255,255,.3)}
.cfql-close{font-size:12px;line-height:18px;min-height:24px;padding:2px 9px;border-radius:6px;border:0.5px solid rgba(255,255,255,.16);background:transparent;color:var(--cfq-text);cursor:pointer}
.cfql-close:focus-visible,.cfql-link:focus-visible{outline:2px solid #fff;outline-offset:1px}
.cfql-stage{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;background:#0d0e12;padding:6px}
.cfql-stage img{max-width:100%;max-height:min(68vh,720px);object-fit:contain;display:block;border-radius:4px}
.cfql-nav{position:absolute;top:50%;transform:translateY(-50%);width:34px;height:56px;display:flex;align-items:center;justify-content:center;font-size:26px;line-height:1;color:#fff;background:rgba(20,20,24,.55);border:0;border-radius:8px;cursor:pointer;padding:0}
.cfql-nav[data-side=left]{left:10px}
.cfql-nav[data-side=right]{right:10px}
.cfql-nav:hover:not(:disabled){background:rgba(20,20,24,.82)}
.cfql-nav:disabled{opacity:.28;cursor:default}
.cfql-nav:focus-visible{outline:2px solid #fff;outline-offset:2px}
.cfql-body{display:flex;flex-direction:column;gap:8px;padding:10px 14px 12px;overflow:auto;max-height:34vh}
.cfql-prompt{margin:0;font-size:12px;line-height:18px;color:var(--cfq-text);overflow-wrap:anywhere}
.cfql-negative{margin:0;font-size:11px;line-height:16px;color:var(--cfq-text-3);overflow-wrap:anywhere}
.cfql-meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;line-height:16px;color:var(--cfq-text-3)}
.cfql-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding-top:2px}
.cfql-actions button,.cfql-actions a{font:inherit;font-size:12px;line-height:18px;min-height:28px;padding:3px 12px;border-radius:7px;border:0.5px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);color:var(--cfq-text);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
.cfql-actions button[data-fav=true]{color:#ffd166;border-color:#8a6d20}
.cfql-actions button:disabled{opacity:.5;cursor:not-allowed}
.cfql-actions button:focus-visible,.cfql-actions a:focus-visible{outline:2px solid #fff;outline-offset:1px}
@media(max-width:520px){.cfql-backdrop{padding:10px}.cfql-stage img{max-height:56vh}}
/* Scope switcher: a two-stop segmented control. Its own button rules replace
   the generic card-button styling so the pressed state reads as a toggle rather
   than as two separate buttons. */
.cfqp-scope{display:inline-flex;align-self:flex-start;gap:0;padding:2px;border-radius:8px;background:var(--cfq-bg-l2);border:0.5px solid var(--cfq-border)}
.cfqp-scope button{font:inherit;font-size:11px;line-height:16px;min-height:22px;padding:1px 10px;border:0;border-radius:6px;background:transparent;color:var(--cfq-text-2);cursor:pointer;white-space:nowrap}
.cfqp-scope button[aria-pressed=true]{background:var(--cfq-bg-l1);color:var(--cfq-text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.cfqp-scope button:disabled{opacity:.45;cursor:not-allowed}
.cfqp-scope button:focus-visible{outline:2px solid var(--cfq-accent);outline-offset:1px}
.cfqp-search{display:flex;gap:6px;align-items:center}
.cfqp-search input{flex:1 1 auto}
.cfqp-list{display:flex;flex-direction:column;gap:6px}

/* progress */
.cfq-prog{display:flex;flex-direction:column;gap:3px}
.cfq-progTrack{height:5px;border-radius:999px;background:var(--cfq-bg-l2);overflow:hidden}
.cfq-progFill{height:100%;border-radius:999px;background:var(--cfq-accent);transition:width .35s ease}
.cfq-progFill[data-indeterminate=true]{width:35%!important;animation:cfq-slide 1.4s ease-in-out infinite}
.cfq-progMeta{display:flex;justify-content:space-between;gap:8px;font-size:11px;line-height:15px;color:var(--cfq-text-3);font-variant-numeric:tabular-nums}
@keyframes cfq-slide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
@media(prefers-reduced-motion:reduce){.cfq-progFill[data-indeterminate=true]{animation:none;width:100%!important;opacity:.55}.cfq-progFill{transition:none}}

/* ---------- conversation card ---------- */
.cfqt{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:0.5px solid var(--cfq-border);border-radius:12px;background:var(--cfq-bg-l1);min-width:0;max-width:100%}
.cfqt-head{display:flex;align-items:center;gap:8px;min-width:0}
.cfqt-glyph{width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;line-height:1;flex:0 0 auto;border:0.5px solid var(--cfq-border);color:var(--cfq-text-2);background:var(--cfq-bg-l2)}
.cfqt-glyph[data-state=running]{color:var(--cfq-accent);border-color:currentColor}
.cfqt-glyph[data-state=ok]{color:var(--cfq-ok);border-color:currentColor}
.cfqt-glyph[data-state=error]{color:var(--cfq-err);border-color:currentColor}
.cfqt-glyph[data-state=stopped]{color:var(--cfq-warn);border-color:currentColor}
.cfqt-title{font-size:13px;font-weight:600;flex:0 0 auto}
.cfqt-state{font-size:11px;color:var(--cfq-text-3);margin-left:auto;flex:0 0 auto}
.cfqt-prompt{font-size:12px;line-height:18px;color:var(--cfq-text-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.cfqt-chips{display:flex;flex-wrap:wrap;gap:4px}
.cfqt-chip{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;border:0.5px solid var(--cfq-border);color:var(--cfq-text-3);white-space:nowrap}
.cfqt-thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px}
.cfqt-thumbs a{display:block;border-radius:8px;overflow:hidden;border:0.5px solid var(--cfq-border);aspect-ratio:1/1;background:var(--cfq-bg-l2)}
.cfqt-thumbs img{width:100%;height:100%;object-fit:cover;display:block}
.cfqt-foot{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;line-height:16px;color:var(--cfq-text-3);font-variant-numeric:tabular-nums}
.cfqt-error{font-size:12px;line-height:18px;color:var(--cfq-err);overflow-wrap:anywhere}

@media(max-width:560px){
.cfq-grid,.cfq-grid[data-cols="3"]{grid-template-columns:minmax(0,1fr)}
.cfq-footer{flex-wrap:wrap}
}
`;

/** How many mounts currently need the stylesheet. */
let refCount = 0;
/** The installed tag, when this module owns one. */
let tag = null;
/** Whether a foreign installer owns the tag (HMR, a second bundle copy). */
let foreign = false;

/**
 * Install the stylesheet, sharing one tag between every consumer.
 * @returns an idempotent disposer that removes the tag when the last consumer leaves.
 */
export function installStyles() {
  if (typeof document === 'undefined') return () => {};
  let released = false;
  if (refCount === 0) {
    const existing = document.querySelector(`style[data-dsh-css="${STYLE_ID}"]`);
    if (existing !== null) {
      // A previous bundle instance (hot reload, duplicated chunk) already owns
      // the tag; reuse it and leave removal to that owner.
      foreign = true;
      tag = null;
    } else {
      try {
        const element = document.createElement('style');
        element.dataset.dshCss = STYLE_ID;
        element.textContent = CSS;
        document.head.appendChild(element);
        tag = element;
        foreign = false;
      } catch {
        // A locked-down document without a head: the UI still renders, unstyled.
        tag = null;
        foreign = true;
      }
    }
  }
  refCount += 1;
  return () => {
    if (released) return;
    released = true;
    refCount = Math.max(0, refCount - 1);
    if (refCount > 0) return;
    if (foreign) { foreign = false; tag = null; return; }
    const element = tag;
    tag = null;
    try { element?.parentNode?.removeChild(element); } catch { /* already detached */ }
  };
}

/** Force-remove the stylesheet regardless of consumers; used by plugin cleanup. */
export function removeStyles() {
  refCount = 0;
  foreign = false;
  const element = tag;
  tag = null;
  if (element === null) {
    if (typeof document === 'undefined') return;
    try { document.querySelector(`style[data-dsh-css="${STYLE_ID}"]`)?.remove(); } catch { /* detached */ }
    return;
  }
  try { element.parentNode?.removeChild(element); } catch { /* already detached */ }
}
