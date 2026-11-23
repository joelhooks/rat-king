import { WINDOW } from "./feed.ts";
import type { Snapshot } from "./feed.ts";
import { parentOf, payloadOf } from "./view.ts";
import type { Message } from "./view.ts";

const replacements = new Map(
  Object.entries({
    '"': "&quot;",
    "&": "&amp;",
    "'": "&#39;",
    "<": "&lt;",
    ">": "&gt;",
  })
);

const escape = (text: string) =>
  text.replaceAll(/[&<>"']/gu, (char) => replacements.get(char) ?? char);

const link = (project: string, filter: string, thread?: number) => {
  const params = new URLSearchParams({ filter, project });

  if (thread !== undefined) {
    params.set("thread", String(thread));
  }

  return `/?${escape(params.toString())}`;
};

const chip = (text: string, style = "") =>
  `<span class="chip ${style}">${escape(text)}</span>`;

const title = (message: Message) => {
  if (message.mode === "sealed") {
    return "Sealed message";
  }

  const heading =
    message.payload?.summary ??
    (message.payload?.body ?? message.body).split("\n", 1)[0];

  return heading === undefined || heading === ""
    ? "Signed message"
    : heading.slice(0, 160);
};

const intentLabel = (message: Message) => {
  const payload = payloadOf(message);

  if (payload === undefined) {
    return "Wake unknown";
  }

  if (payload.kind === "data") {
    return "Data · no wake intent";
  }

  return payload.quiet === true ? "Quiet intent" : "Wake intent";
};

const replyLink = (message: Message, thread: readonly Message[]) => {
  const parent = parentOf(message);

  if (parent === undefined) {
    return "";
  }

  const target = thread.find(
    (item) => item.id === parent && item.key < message.key
  );

  const label =
    target === undefined
      ? `${escape(parent)} (outside this thread view)`
      : `<a href="#message-${target.key}">${escape(parent)}</a>`;

  return `<div class="muted">Reply to ${label}</div>`;
};

const messageHtml = (message: Message, thread: readonly Message[]) => {
  const payload = payloadOf(message);

  const body =
    message.mode === "sealed"
      ? `<p class="sealedbody">Metadata only · ${message.size} ciphertext characters</p>`
      : `<p class="body">${escape(message.payload?.body ?? message.body)}</p>`;

  const badges =
    message.mode === "sealed"
      ? chip("Sealed", "sealed")
      : chip("Signed", "signed");

  const target =
    payload?.to === undefined ? "" : ` · addressed to ${escape(payload.to)}`;

  const aliases =
    message.addressed.size === 0
      ? ""
      : ` · resolved from ${escape([...message.addressed].join(", "))}`;

  const cc = payload?.cc ?? [];
  const ccLabel = cc.length === 0 ? "None declared" : escape(cc.join(", "));

  return `<article class="message" id="message-${message.key}"><span class="avatar" aria-hidden="true">${escape((payload?.from.split("/").at(-1) ?? "ID").slice(0, 2).toUpperCase())}</span><div>
  <div class="messagemeta"><strong>${escape(payload?.from ?? message.sender)}</strong> ${badges} ${chip(intentLabel(message))} <time datetime="${escape(message.time)}">${escape(message.time)}</time></div>
  ${payload === undefined ? "" : `<div class="muted">Signed by ${escape(message.sender)}</div>`}
  <div class="muted">Observed recipients: ${escape([...message.recipients].join(", "))}${target}${aliases}</div>
  <div class="muted">CC: ${payload === undefined ? "Unavailable" : ccLabel}</div>${replyLink(message, thread)}
  ${payload?.summary === undefined ? "" : `<strong class="summary">${escape(payload.summary)}</strong>`}${body}</div></article>`;
};

const filters = ["Threads", "Pending", "Answered"] as const;

const statusLabel = {
  connecting: "Connecting to mailbox",
  live: "Live tail",
  reconnecting: "Tail reconnecting",
} satisfies Record<Snapshot["status"], string>;

export const content = (snapshot: Snapshot, params: URLSearchParams) => {
  const selected =
    snapshot.projects.find(({ name }) => name === params.get("project")) ??
    snapshot.projects[0];

  const filter =
    filters.find((item) => item === params.get("filter")) ?? "Threads";

  const threads = (selected?.threads ?? []).filter(
    ({ asks }) =>
      filter === "Threads" ||
      asks.some(({ answered }) => answered === (filter === "Answered"))
  );

  const found = threads.find(({ key }) => String(key) === params.get("thread"));
  const active = found ?? (params.has("thread") ? undefined : threads[0]);
  const explicit = found !== undefined;
  const name = selected?.name ?? "Projects";

  const projects = snapshot.projects
    .map((project) => {
      const pending = project.threads
        .flatMap(({ asks }) => asks)
        .filter(({ answered }) => !answered).length;

      return `<a class="nav" href="${link(project.name, filter)}" ${project === selected ? 'aria-current="page"' : ""}>${escape(project.name)} <span class="qty">${pending}</span></a>`;
    })
    .join("");

  const rows = threads
    .map((thread) => {
      const [first] = thread.messages;

      if (first === undefined) {
        return "";
      }

      const open = thread.asks.filter(({ answered }) => !answered).length;
      const answered = thread.asks.length - open;

      return `<a class="row" href="${link(name, filter, thread.key)}" ${thread === active ? 'aria-current="page"' : ""}><span class="rowtop"><span class="eyebrow">#${thread.key}</span><span>${open > 0 ? chip(`${open} pending`, "pending") : ""} ${answered > 0 ? chip(`${answered} answered`, "signed") : ""}</span></span><strong>${escape(title(first))}</strong><span class="muted">${escape(payloadOf(first)?.from ?? first.sender)} · ${thread.messages.length} messages</span></a>`;
    })
    .join("");

  const first = active?.messages[0];

  const detail =
    active === undefined || first === undefined
      ? `<p class="empty">${params.has("thread") ? "Thread is outside this view." : "No matching threads."}</p>`
      : `
    <a class="back" href="${link(name, filter)}">← ${escape(name)}</a>
    <div class="detailtop"><span class="eyebrow">${escape(name)} / Thread ${active.key}</span> ${chip("Private mailbox")}
    <h2>${escape(title(first))}</h2></div>
    ${active.asks.length === 0 ? "" : `<section class="askbox" aria-label="Asks">${active.asks.map(({ answered, message }) => `<div>${chip(answered ? "Answered" : "No visible reply", answered ? "signed" : "pending")} <a href="#message-${message.key}">${escape(title(message))}</a></div>`).join("")}</section>`}
    <section class="stream"><h3 class="eyebrow">Mailbox thread · ${active.messages.length}</h3>${active.messages.map((message) => messageHtml(message, active.messages)).join("")}</section>`;

  return `<div id="viewer" data-revision="${snapshot.revision}" class="shell${explicit ? " drill-in" : ""}">
    <aside class="rail"><div class="railhead"><div class="eyebrow">Private mailbox</div><strong>Traffic</strong></div>
      <nav aria-label="Projects">${projects}</nav>
      <div class="network"><span class="dot${snapshot.status === "live" ? " live" : ""}"></span> <strong id="feed-status" role="status">${statusLabel[snapshot.status]}</strong><p class="muted">Last ${WINDOW} traffic positions. Pending means no visible reply in this window.</p></div></aside>
    <section class="list" aria-label="Thread list"><div class="listhead"><div class="eyebrow">Rat King / Project</div><h1>${escape(name)}</h1><div class="filterbar">${filters.map((item) => `<a href="${link(name, item)}" ${item === filter ? 'aria-current="page"' : ""}>${item}</a>`).join("")}</div></div>
    <div class="caption eyebrow">${threads.length} threads</div>${rows || '<p class="empty">No matching threads yet.</p>'}</section>
    <main class="detail">${detail}</main></div>`;
};

export const documentHtml = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Rat King / Traffic</title><link rel="stylesheet" href="/viewer.css"><script src="/viewer.js" defer></script></head><body><header class="top"><span class="brandmark" aria-hidden="true">RK</span><span class="brand">Rat King</span><span class="eyebrow">Read only</span></header>${body}</body></html>`;

export const liveScript = String.raw`(() => {
  const tick = async () => {
    const view = document.querySelector('#viewer');
    if (!view) return;
    try {
      const url = new URL('/snapshot', location.origin);
      url.search = location.search;
      url.searchParams.set('revision', view.dataset.revision);
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (response.status === 403) { location.replace('/'); return; }
      if (response.status === 200) {
        const frame = document.createElement('template');
        frame.innerHTML = await response.text();
        const next = frame.content.firstElementChild;
        const focus = view.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
        const panes = [...view.children];
        view.replaceWith(next);
        [...next.children].forEach((item, i) => { item.scrollTop = panes[i].scrollTop; });
        if (focus) [...next.querySelectorAll('a')].find(a => a.getAttribute('href') === focus)?.focus({ preventScroll: true });
      }
    } catch {
      const status = document.querySelector('#feed-status');
      if (status) status.textContent = 'Viewer disconnected';
      view.dataset.revision = '';
    }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 2000);
})();`;
