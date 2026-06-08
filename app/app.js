"use strict";

const SIGNAL_ORDER = ["surprisal", "entropy", "maxprob"];
const SIGNAL_LABELS = {
  surprisal: "surprisal",
  entropy: "entropy",
  maxprob: "maxprob",
  selfcons: "self-consistency",
};

let records = [];
let probeNames = [];
let current = -1;
let currentProbe = "Llama-3-8B";
let currentOverlay = "selfcons";

// Map a 0..1 intensity to a yellowish background (white -> accent yellow).
function colorFor(t) {
  if (t === null || t === undefined || Number.isNaN(t)) return "transparent";
  const x = Math.max(0, Math.min(1, t));
  const r = Math.round(255 + (245 - 255) * x);
  const g = Math.round(255 + (194 - 255) * x);
  const b = Math.round(255 + (0 - 255) * x);
  return `rgb(${r}, ${g}, ${b})`;
}

// Render text where each char is tinted by per-char values in [0,1].
// `raw` (optional) supplies the true values shown in the hover tooltip.
function renderColored(container, text, values, raw) {
  container.textContent = "";
  for (let i = 0; i < text.length; i++) {
    const span = document.createElement("span");
    span.textContent = text[i];
    span.style.backgroundColor = colorFor(values ? values[i] : null);
    const rv = raw ? raw[i] : values ? values[i] : null;
    if (rv !== null && rv !== undefined && !Number.isNaN(rv)) {
      span.title = Number(rv).toFixed(3);
    }
    container.appendChild(span);
  }
}

// List the scored spans: runs of characters sharing a gold value > 0.
function renderScores(container, text, values) {
  container.textContent = "";
  let i = 0, any = false;
  while (i < text.length) {
    const v = values[i];
    if (v && v > 0) {
      let j = i + 1;
      while (j < text.length && values[j] === v) j++;
      const li = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.backgroundColor = colorFor(v);
      const frag = document.createElement("span");
      frag.className = "frag";
      frag.textContent = `"${text.slice(i, j)}"`;
      const score = document.createElement("span");
      score.className = "score-val";
      score.textContent = v.toFixed(2);
      li.append(swatch, frag, score);
      container.appendChild(li);
      any = true;
      i = j;
    } else i++;
  }
  if (!any) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "No characters were marked as hallucinated.";
    container.appendChild(li);
  }
}

function normalize(arr) {
  if (!arr) return null;
  const vals = arr.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (!vals.length) return arr.map(() => null);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo;
  return arr.map((v) =>
    v === null || v === undefined || Number.isNaN(v)
      ? null : span === 0 ? 0 : (v - lo) / span);
}

function fmtR(r) {
  return (r === null || r === undefined) ? "n/a" : "r = " + Number(r).toFixed(3);
}

// Feature 4: tokenize into words with char ranges (whitespace split).
function wordRanges(text) {
  const ranges = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length, m[0]]);
  }
  return ranges;
}
function normWord(w) {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function renderHoverText(container, text, generations) {
  container.textContent = "";
  const genSets = generations.map(
    (g) => new Set(wordRanges(g).map((r) => normWord(r[2])).filter(Boolean))
  );
  const ranges = wordRanges(text);
  let pos = 0;
  for (const [s, e, w] of ranges) {
    if (s > pos) container.appendChild(document.createTextNode(text.slice(pos, s)));
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = w;
    const nw = normWord(w);
    const hits = nw ? genSets.reduce((acc, set) => acc + (set.has(nw) ? 1 : 0), 0) : 0;
    span.dataset.hits = hits;
    span.addEventListener("mouseenter", () => highlightGenerations(nw, hits));
    span.addEventListener("mouseleave", clearGenerationHighlight);
    container.appendChild(span);
    pos = e;
  }
  if (pos < text.length) container.appendChild(document.createTextNode(text.slice(pos)));
}

function highlightGenerations(nw, hits) {
  const lis = document.querySelectorAll("#generations li");
  lis.forEach((li) => {
    const has = nw && li.dataset.words && li.dataset.words.split(" ").includes(nw);
    li.classList.toggle("gen-hit", !!has);
    li.classList.toggle("gen-miss", !has);
  });
  const badge = document.getElementById("hover-badge");
  if (badge) badge.textContent = nw ? `"${nw}" appears in ${hits}/10 generations` : "";
}
function clearGenerationHighlight() {
  document.querySelectorAll("#generations li").forEach((li) => {
    li.classList.remove("gen-hit", "gen-miss");
  });
  const badge = document.getElementById("hover-badge");
  if (badge) badge.textContent = "";
}

function renderOverlay(rec, probe) {
  const sig = currentOverlay;
  const vals = probe.signals[sig];
  const norm = sig === "selfcons" ? vals : normalize(vals);
  renderColored(document.getElementById("overlay-gold"), rec.text, rec.gold, rec.gold);
  renderColored(document.getElementById("overlay-sig"), rec.text, norm, vals);
  document.getElementById("overlay-sig-label").textContent = SIGNAL_LABELS[sig];
  document.getElementById("overlay-r").textContent = fmtR(probe.r[sig]);
}

// Feature B: underline/box characters that belong to a token-focus mask.
function applyMasks(container, rec) {
  const ne = document.getElementById("mask-ne").checked ? rec.masks.ne : null;
  const rare = document.getElementById("mask-rare").checked ? rec.masks.rare : null;
  const spans = container.querySelectorAll("span");
  spans.forEach((span, i) => {
    span.classList.remove("m-ne", "m-rare");
    if (ne && ne[i]) span.classList.add("m-ne");
    if (rare && rare[i]) span.classList.add("m-rare");
  });
}

function show(idx) {
  const rec = records[idx];
  current = idx;
  const probe = rec.probes[currentProbe] || rec.probes[Object.keys(rec.probes)[0]];

  document.getElementById("rec-id").textContent = rec.id;
  document.getElementById("question").textContent = rec.question;
  document.getElementById("example-select").value = String(idx);
  document.querySelectorAll(".probe-name").forEach((el) => (el.textContent = currentProbe));

  // Gold.
  renderColored(document.getElementById("gold-text"), rec.text, rec.gold, rec.gold);
  applyMasks(document.getElementById("gold-text"), rec);
  renderScores(document.getElementById("gold-scores"), rec.text, rec.gold);

  // Overlay (feature 1 + 2).
  renderOverlay(rec, probe);

  // Generations + hover text (feature 4).
  const ol = document.getElementById("generations");
  ol.textContent = "";
  for (const g of probe.generations) {
    const li = document.createElement("li");
    li.textContent = g;
    li.dataset.words = [...new Set(wordRanges(g).map((r) => normWord(r[2])).filter(Boolean))].join(" ");
    ol.appendChild(li);
  }
  renderHoverText(document.getElementById("hover-text"), rec.text, probe.generations);

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function randomOther() {
  if (records.length <= 1) return 0;
  let i = current;
  while (i === current) i = Math.floor(Math.random() * records.length);
  return i;
}

async function init() {
  try {
    const resp = await fetch("data.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    records = await resp.json();
  } catch (e) {
    document.querySelector("main").insertAdjacentHTML("beforeend",
      `<p class="error">Could not load data.json (${e.message}). ` +
      `Serve this folder over HTTP, e.g. <code>python -m http.server</code>.</p>`);
    return;
  }
  if (!records.length) return;
  probeNames = Object.keys(records[0].probes);
  currentProbe = probeNames.includes("Llama-3-8B") ? "Llama-3-8B" : probeNames[0];

  // Example dropdown.
  const select = document.getElementById("example-select");
  records.forEach((r, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    const q = r.question.length > 60 ? r.question.slice(0, 60) + "…" : r.question;
    opt.textContent = `${r.id} — ${q}`;
    select.appendChild(opt);
  });
  select.addEventListener("change", (e) => show(Number(e.target.value)));

  // Probe dropdown (feature 3).
  const probeSel = document.getElementById("probe-select");
  probeNames.forEach((n) => {
    const opt = document.createElement("option");
    opt.value = n; opt.textContent = n;
    probeSel.appendChild(opt);
  });
  probeSel.value = currentProbe;
  probeSel.addEventListener("change", (e) => { currentProbe = e.target.value; show(current); });

  // Overlay signal dropdown (feature 1).
  const ovSel = document.getElementById("overlay-select");
  ["selfcons", "surprisal", "entropy", "maxprob"].forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s; opt.textContent = SIGNAL_LABELS[s];
    ovSel.appendChild(opt);
  });
  ovSel.value = currentOverlay;
  ovSel.addEventListener("change", (e) => {
    currentOverlay = e.target.value;
    renderOverlay(records[current], records[current].probes[currentProbe]);
  });

  // Mask toggles (feature B) — re-apply to the current gold render.
  const reapplyMasks = () =>
    applyMasks(document.getElementById("gold-text"), records[current]);
  document.getElementById("mask-ne").addEventListener("change", reapplyMasks);
  document.getElementById("mask-rare").addEventListener("change", reapplyMasks);

  document.getElementById("next-btn").addEventListener("click", () => show(randomOther()));
  const firstIdx = records.findIndex((r) => r.id === "val-en-7");
  show(firstIdx >= 0 ? firstIdx : 0);
}

init();
