/* LLM Wiki — клиент: список, редактор, граф связей. Без зависимостей. */
const API = window.WIKI_API || "/api";
const $ = (id) => document.getElementById(id);

const state = { slug: null, pages: [], graph: { nodes: [], edges: [] }, editing: false };

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

/* ---------- Markdown (минимальный) ---------- */
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function renderMarkdown(src, known) {
  const blocks = [];
  // Вырезаем блоки кода, чтобы внутри ничего не форматировалось.
  let text = src.replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/^\w*\n/, ""))}</code></pre>`);
    return `\u0000CODE${blocks.length - 1}\u0000`;
  });

  text = esc(text);
  const inline = (s) => {
    // Inline-код прячем первым, иначе [[ссылка]] в примере разметки станет ссылкой.
    const code = [];
    return s
      .replace(/`([^`]+)`/g, (_, c) => `\u0000IC${code.push(`<code>${c}</code>`) - 1}\u0000`)
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
        const slug = slugify(target);
        const cls = known.has(slug) ? "wikilink" : "wikilink missing";
        return `<a class="${cls}" data-slug="${slug}">${(label || target).trim()}</a>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\u0000IC(\d+)\u0000/g, (_, i) => code[+i]);
  };

  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (/^\u0000CODE(\d+)\u0000$/.test(line.trim())) { closeList(); out.push(line.trim()); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>`); continue;
    }
    if (/^&gt;\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ""))}</blockquote>`); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n").replace(/\u0000CODE(\d+)\u0000/g, (_, i) => blocks[+i]);
}

// Должно совпадать со slugify на сервере.
function slugify(s) {
  return s.trim().toLowerCase()
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^\p{L}\p{N}\-_.]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

/* ---------- Список и теги ---------- */
async function loadList(query = "") {
  const data = await api(`/pages?limit=200${query ? `&q=${encodeURIComponent(query)}` : ""}`);
  state.pages = data.results;
  const ul = $("page-list");
  ul.innerHTML = "";
  if (!state.pages.length) {
    ul.innerHTML = `<li class="muted">${query ? "ничего не найдено" : "пока пусто"}</li>`;
    return;
  }
  for (const p of state.pages) {
    const li = document.createElement("li");
    li.className = p.slug === state.slug ? "active" : "";
    // Сервер размечает совпадения символами \x02…\x03 — их и подсвечиваем.
    const sub = p.snippet
      ? esc(p.snippet).replace(/\x02/g, "<mark>").replace(/\x03/g, "</mark>")
      : (p.tags || "");
    li.innerHTML = `${esc(p.title)}${sub ? `<span class="sub">${sub}</span>` : ""}`;
    li.onclick = () => open(p.slug);
    ul.appendChild(li);
  }
}

async function loadTags() {
  const { tags } = await api("/tags");
  const ul = $("tag-list");
  ul.innerHTML = tags.length
    ? ""
    : '<li class="muted">тегов нет</li>';
  for (const t of tags) {
    const li = document.createElement("li");
    li.innerHTML = `${esc(t.tag)} <span class="sub">${t.count}</span>`;
    li.onclick = () => { $("search").value = t.tag; loadList(t.tag); switchTab("pages"); };
    ul.appendChild(li);
  }
}

async function loadStats() {
  const s = await api("/stats");
  $("stats").textContent = `${s.pages} страниц · ${s.links} связей · ${s.orphans} без связей`;
}

/* ---------- Просмотр / правка ---------- */
async function open(slug) {
  if (!slug) return;
  state.slug = slug;
  location.hash = slug;
  let page;
  try {
    page = await api(`/pages/${encodeURIComponent(slug)}`);
  } catch {
    // Страницы ещё нет — предлагаем создать.
    startEdit({ slug, title: slug, content: "", tags: [] });
    return;
  }
  state.editing = false;
  $("edit-mode").classList.add("hidden");
  $("view-mode").classList.remove("hidden");
  $("page-title").textContent = page.title;
  $("edit").classList.remove("hidden");
  $("delete").classList.remove("hidden");

  $("page-tags").innerHTML = page.tags
    .map((t) => `<span class="tag">#${esc(t)}</span>`)
    .join("");
  $("page-tags").querySelectorAll(".tag").forEach((el, i) => {
    el.onclick = () => { $("search").value = page.tags[i]; loadList(page.tags[i]); };
  });

  const known = new Set(state.graph.nodes.filter((n) => n.exists).map((n) => n.id));
  known.add(page.slug);
  $("page-content").innerHTML = renderMarkdown(page.content, known) ||
    '<p class="muted">Страница пустая.</p>';

  const linkList = (items, empty) =>
    items.length
      ? `<ul>${items.map((l) => `<li><a class="wikilink${l.title ? "" : " missing"}" data-slug="${esc(l.slug)}">${esc(l.title || l.slug)}</a></li>`).join("")}</ul>`
      : `<p class="muted">${empty}</p>`;
  $("page-links").innerHTML =
    `<div><h4>Ссылается на</h4>${linkList(page.links, "нет ссылок")}</div>` +
    `<div><h4>Ссылаются сюда</h4>${linkList(page.backlinks, "никто не ссылается")}</div>`;

  document.querySelectorAll("[data-slug]").forEach((a) => {
    a.onclick = () => open(a.dataset.slug);
  });

  loadList($("search").value.trim());
  graphFocus(slug);
}

function startEdit(page) {
  state.editing = true;
  $("view-mode").classList.add("hidden");
  $("edit-mode").classList.remove("hidden");
  $("edit-slug").value = page.slug || "";
  $("edit-title").value = page.title || "";
  $("edit-tags").value = (page.tags || []).join(", ");
  $("edit-content").value = page.content || "";
  $("save-hint").textContent = "";
  ($("edit-slug").value ? $("edit-content") : $("edit-slug")).focus();
}

async function save() {
  const slug = slugify($("edit-slug").value);
  if (!slug) { $("save-hint").textContent = "нужен slug"; return; }
  await api(`/pages/${encodeURIComponent(slug)}`, {
    method: "PUT",
    body: JSON.stringify({
      title: $("edit-title").value.trim() || slug,
      content: $("edit-content").value,
      tags: $("edit-tags").value.split(",").map((s) => s.trim()).filter(Boolean),
    }),
  });
  await refreshGraph();
  await Promise.all([loadList($("search").value.trim()), loadTags(), loadStats()]);
  await open(slug);
}

async function removePage() {
  if (!state.slug || !confirm(`Удалить «${state.slug}»?`)) return;
  await api(`/pages/${encodeURIComponent(state.slug)}`, { method: "DELETE" });
  state.slug = null;
  location.hash = "";
  $("page-title").textContent = "Страница удалена";
  $("page-content").innerHTML = "";
  $("page-links").innerHTML = "";
  $("page-tags").innerHTML = "";
  $("edit").classList.add("hidden");
  $("delete").classList.add("hidden");
  await refreshGraph();
  await Promise.all([loadList(), loadTags(), loadStats()]);
}

/* ---------- Граф ---------- */
const canvas = $("graph");
const ctx = canvas.getContext("2d");
const view = { x: 0, y: 0, k: 1 };
let nodes = [], edges = [], drag = null, hover = null, raf = null;

// Цвета графа берём из CSS-переменных — так канвас следует теме (тёмная/светлая).
let theme = {};
function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (s.getPropertyValue(name).trim() || fallback);
  theme = {
    accent: v("--accent", "#5aa2ff"),
    line: v("--line", "#262d38"),
    ghostFill: v("--bg-2", "#12161c"),
    ghostStroke: v("--ghost", "#5b6472"),
    active: v("--text", "#e8eaef"),
    label: v("--text-2", "#b3bac7"),
    labelDim: v("--muted", "#7f8895"),
  };
}
readTheme();
// Системная смена темы на лету.
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => { readTheme(); draw(); });

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(canvas);

async function refreshGraph() {
  state.graph = await api("/graph");
  buildGraph();
}

function buildGraph() {
  const showGhosts = $("show-ghosts").checked;
  const prev = new Map(nodes.map((n) => [n.id, n]));
  const visible = state.graph.nodes.filter((n) => showGhosts || n.exists);
  const ids = new Set(visible.map((n) => n.id));
  const r = canvas.getBoundingClientRect();

  nodes = visible.map((n) => {
    const old = prev.get(n.id);
    return {
      ...n,
      x: old?.x ?? r.width / 2 + (Math.random() - 0.5) * 220,
      y: old?.y ?? r.height / 2 + (Math.random() - 0.5) * 220,
      vx: 0, vy: 0,
      // Базовый размер по числу связей (экранных px при k=1). Фактический радиус
      // при отрисовке считает worldR() с учётом зума — см. ниже.
      r: 2.6 + Math.min(4, n.degree * 0.6),
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  edges = state.graph.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ s: byId.get(e.source), t: byId.get(e.target) }));
  kick();
}

let energy = 0;
function kick() { energy = 1; if (!raf) raf = requestAnimationFrame(tick); }

function simulate() {
  const r = canvas.getBoundingClientRect();
  const cx = r.width / 2, cy = r.height / 2;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    // Притяжение к центру, чтобы граф не расползался.
    a.vx += (cx - a.x) * 0.0015;
    a.vy += (cy - a.y) * 0.0015;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d2 = dx * dx + dy * dy || 0.01;
      if (d2 > 160000) continue; // дальние узлы друг друга не отталкивают
      const f = 1500 / d2;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
    }
  }
  for (const e of edges) {
    const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y;
    const d = Math.hypot(dx, dy) || 0.01;
    const f = (d - 120) * 0.01;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    e.s.vx += fx; e.s.vy += fy; e.t.vx -= fx; e.t.vy -= fy;
  }
  let moved = 0;
  for (const n of nodes) {
    if (n === drag?.node) { n.vx = n.vy = 0; continue; }
    n.vx *= 0.82; n.vy *= 0.82;
    n.x += n.vx; n.y += n.vy;
    moved += Math.abs(n.vx) + Math.abs(n.vy);
  }
  energy = moved / Math.max(1, nodes.length);
}

// Радиус узла в МИРОВЫХ координатах для текущего зума.
// На экране узел = worldR*k px: почти постоянный размер с потолком —
// при отдалении (k<1) слегка растёт до R_MAX, при приближении (k>1) не пухнет.
const R_MIN = 2.5, R_MAX = 12; // экранные px
function worldR(n) {
  const screen = Math.max(R_MIN, Math.min(R_MAX, n.r / Math.sqrt(view.k)));
  return screen / view.k;
}

function draw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  const near = new Set();
  if (hover || state.slug) {
    const focus = hover?.id ?? state.slug;
    for (const e of edges) {
      if (e.s.id === focus) near.add(e.t.id);
      if (e.t.id === focus) near.add(e.s.id);
    }
    near.add(focus);
  }

  // Толщина линий и шрифт задаются в мировых единицах (ctx масштабируется на k),
  // поэтому делим на k — так на экране они держат постоянный размер при любом зуме.
  const px = 1 / view.k;
  for (const e of edges) {
    const lit = near.size && (near.has(e.s.id) && near.has(e.t.id));
    ctx.strokeStyle = lit ? theme.accent : theme.line;
    ctx.globalAlpha = lit ? 0.75 : 1;
    ctx.lineWidth = (lit ? 1.6 : 1) * px;
    ctx.setLineDash(e.t.exists ? [] : [3 * px, 3 * px]);
    ctx.beginPath();
    ctx.moveTo(e.s.x, e.s.y);
    ctx.lineTo(e.t.x, e.t.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  for (const n of nodes) {
    const active = n.id === state.slug;
    const dim = near.size && !near.has(n.id);
    const rr = worldR(n);
    ctx.globalAlpha = dim ? 0.3 : 1;
    ctx.beginPath();
    ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
    ctx.fillStyle = active ? theme.active : n.exists ? theme.accent : theme.ghostFill;
    ctx.fill();
    if (!n.exists) { ctx.strokeStyle = theme.ghostStroke; ctx.lineWidth = 1.4 * px; ctx.stroke(); }
    if (active) { ctx.strokeStyle = theme.accent; ctx.lineWidth = 2.5 * px; ctx.stroke(); }

    if (view.k > 0.55 && (n.degree > 0 || active || nodes.length < 60)) {
      ctx.fillStyle = dim ? theme.labelDim : theme.label;
      ctx.font = `${active ? 600 : 400} ${11 * px}px -apple-system, sans-serif`;
      ctx.textAlign = "center";
      const label = n.title.length > 22 ? n.title.slice(0, 21) + "…" : n.title;
      ctx.fillText(label, n.x, n.y + rr + 11 * px);
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function tick() {
  simulate();
  draw();
  raf = energy > 0.02 || drag ? requestAnimationFrame(tick) : null;
  if (!raf) draw();
}

function toWorld(ev) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - r.left - view.x) / view.k,
    y: (ev.clientY - r.top - view.y) / view.k,
  };
}
function nodeAt(p) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const rr = worldR(n) + 6 / view.k; // +6 экранных px на попадание
    if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= rr * rr) return n;
  }
  return null;
}

canvas.addEventListener("mousedown", (ev) => {
  const p = toWorld(ev);
  const n = nodeAt(p);
  drag = n
    ? { node: n, dx: n.x - p.x, dy: n.y - p.y, moved: false }
    : { pan: true, sx: ev.clientX - view.x, sy: ev.clientY - view.y, moved: false };
  kick();
});
canvas.addEventListener("mousemove", (ev) => {
  const p = toWorld(ev);
  if (drag) {
    drag.moved = true;
    if (drag.pan) { view.x = ev.clientX - drag.sx; view.y = ev.clientY - drag.sy; draw(); }
    else { drag.node.x = p.x + drag.dx; drag.node.y = p.y + drag.dy; kick(); }
    return;
  }
  const n = nodeAt(p);
  if (n !== hover) {
    hover = n;
    const tip = $("graph-tip");
    if (n) {
      const r = canvas.getBoundingClientRect();
      tip.textContent = `${n.title}${n.exists ? "" : " (не создана)"} · ${n.degree} св.`;
      tip.style.left = `${ev.clientX - r.left + 12}px`;
      tip.style.top = `${ev.clientY - r.top + 12}px`;
      tip.classList.remove("hidden");
    } else tip.classList.add("hidden");
    draw();
  }
});
window.addEventListener("mouseup", () => {
  // Клик без перетаскивания = переход на страницу; после drag узел остаётся на месте.
  if (drag && !drag.pan && !drag.moved) open(drag.node.id);
  drag = null;
});
canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  const k = Math.min(3, Math.max(0.25, view.k * (ev.deltaY < 0 ? 1.12 : 0.89)));
  view.x = mx - ((mx - view.x) / view.k) * k;
  view.y = my - ((my - view.y) / view.k) * k;
  view.k = k;
  draw();
}, { passive: false });

function graphFocus(slug) {
  const n = nodes.find((x) => x.id === slug);
  if (!n) { draw(); return; }
  const r = canvas.getBoundingClientRect();
  view.x = r.width / 2 - n.x * view.k;
  view.y = r.height / 2 - n.y * view.k;
  draw();
}

/* ---------- Обвязка UI ---------- */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("page-list").classList.toggle("hidden", name !== "pages");
  $("tag-list").classList.toggle("hidden", name !== "tags");
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

let searchTimer;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadList(e.target.value.trim()), 180);
});
$("new-page").onclick = () => startEdit({ slug: "", title: "", content: "", tags: [] });
$("edit").onclick = async () => {
  const p = await api(`/pages/${encodeURIComponent(state.slug)}`);
  startEdit(p);
};
$("cancel").onclick = () => (state.slug ? open(state.slug) : location.reload());
$("save").onclick = () => save().catch((e) => ($("save-hint").textContent = e.message));
$("delete").onclick = () => removePage().catch((e) => alert(e.message));
$("show-ghosts").onchange = buildGraph;
$("graph-reset").onclick = () => { view.x = 0; view.y = 0; view.k = 1; buildGraph(); };

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
    e.preventDefault(); $("search").focus();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "s" && state.editing) {
    e.preventDefault(); save().catch((err) => ($("save-hint").textContent = err.message));
  }
  if (e.key === "Escape" && state.editing && state.slug) open(state.slug);
});
window.addEventListener("hashchange", () => {
  const s = decodeURIComponent(location.hash.slice(1));
  if (s && s !== state.slug) open(s);
});

(async function init() {
  resize();
  await refreshGraph();
  await Promise.all([loadList(), loadTags(), loadStats()]);
  const s = decodeURIComponent(location.hash.slice(1));
  if (s) open(s);
  else draw();
})();
