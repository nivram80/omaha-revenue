// Info tips: a small "i" button beside a label that says what it means and
// where the number came from. A tip opens on hover and on keyboard focus,
// stays open while the pointer is over it, pins open on a click or tap, and
// closes on Escape, on moving away, or on a click elsewhere (WCAG 1.4.13).
// Its text is the button's accessible description, so a screen reader reads
// it on focus, and any links in it come next in the tab order.
//
// The popup is shown with the Popover API, which puts it in the top layer, so
// a scrolling table or card can never clip it. Without that API it falls back
// to a box positioned under the button.

import { html } from "../vendor/lit-html.js";

const POPOVER = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;
const GAP = 6;
const MARGIN = 8;

let open = null; // { wrap, pinned }
let hideTimer = 0;

/**
 * key must be unique on the page and stable across renders; label names what
 * the tip explains ("About <label>"); body is any lit template.
 */
export function tip(key, label, body, { estimate = false } = {}) {
  const id = `tip-${key.replace(/[^\w-]+/g, "-")}`;
  return html`<span class="tip"
      @pointerenter=${(e) => { if (e.pointerType === "mouse") show(e.currentTarget, false); }}
      @pointerleave=${(e) => { if (e.pointerType === "mouse") hideSoon(e.currentTarget); }}
      @focusin=${(e) => show(e.currentTarget, false)}
      @focusout=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) hide(e.currentTarget); }}>
    <button type="button" class="tip-btn ${estimate ? "tip-est" : ""}"
      aria-label=${`About ${label}${estimate ? " (estimate)" : ""}`}
      aria-describedby=${id} aria-expanded="false"
      @pointerdown=${(e) => { e.currentTarget.wasPinned = isPinned(e.currentTarget.parentElement); }}
      @click=${(e) => {
        const wrap = e.currentTarget.parentElement;
        if (e.currentTarget.wasPinned) hide(wrap);
        else show(wrap, true);
        e.currentTarget.wasPinned = false;
      }}>i</button>
    <span class="tip-pop" id=${id} popover="manual">${body}</span>
  </span>`;
}

function isPinned(wrap) {
  return !!open && open.wrap === wrap && open.pinned;
}

function show(wrap, pinned) {
  clearTimeout(hideTimer);
  if (open && open.wrap !== wrap) hide(open.wrap);
  const pop = wrap.querySelector(".tip-pop");
  const btn = wrap.querySelector(".tip-btn");
  if (!wrap.classList.contains("open")) {
    wrap.classList.add("open");
    if (POPOVER && !pop.matches(":popover-open")) pop.showPopover();
    place(btn, pop);
  }
  btn.setAttribute("aria-expanded", "true");
  open = { wrap, pinned: pinned || isPinned(wrap) };
}

function hide(wrap) {
  clearTimeout(hideTimer);
  const pop = wrap.querySelector(".tip-pop");
  wrap.classList.remove("open");
  if (POPOVER && pop?.matches(":popover-open")) pop.hidePopover();
  wrap.querySelector(".tip-btn")?.setAttribute("aria-expanded", "false");
  if (open?.wrap === wrap) open = null;
}

/** Leaving with the pointer: a pinned or focused tip stays, others close after a beat. */
function hideSoon(wrap) {
  if (isPinned(wrap) || wrap.contains(document.activeElement)) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hide(wrap), 180);
}

/** Under the button, kept on screen; above it if there is no room below. */
function place(btn, pop) {
  if (!POPOVER) return;
  const b = btn.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(MARGIN, Math.min(b.left - 12, innerWidth - w - MARGIN));
  let top = b.bottom + GAP;
  if (top + h > innerHeight - MARGIN && b.top - GAP - h > MARGIN) top = b.top - GAP - h;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

if (typeof window !== "undefined") {
  // Capture phase, so Escape closes the tip and not also the panel behind it.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) {
      hide(open.wrap);
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
  document.addEventListener("pointerdown", (e) => {
    if (open && !open.wrap.contains(e.target)) hide(open.wrap);
  }, true);
  // The popup is fixed to the viewport, so it follows its button on scroll.
  // Tabbing to a button can scroll it into view, so this must not close it.
  const follow = () => {
    if (!open) return;
    const btn = open.wrap.querySelector(".tip-btn");
    const b = btn.getBoundingClientRect();
    if (b.bottom < 0 || b.top > innerHeight) hide(open.wrap);
    else place(btn, open.wrap.querySelector(".tip-pop"));
  };
  document.addEventListener("scroll", follow, true);
  window.addEventListener("resize", follow);
}
