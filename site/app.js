"use strict";

const OUTCOME = {
  passed: { word: "passed", glyph: "✓", cls: "is-passed" },
  failed: { word: "failed", glyph: "✗", cls: "is-failed" },
  aborted: { word: "aborted", glyph: "⊘", cls: "is-aborted" },
  none: { word: "no run", glyph: "·", cls: "is-none" },
};

const STEP_RESULT = {
  completed: { word: "completed", cls: "seg-completed" },
  failed: { word: "failed", cls: "seg-failed" },
  skipped: { word: "skipped", cls: "seg-skipped" },
};

const ESCROW_KIND = {
  "nothing-created": {
    word: "Nothing created",
    cls: "esc-none",
    note: "create-deployment never completed, so no escrow was ever funded.",
  },
  returned: {
    word: "Returned",
    cls: "esc-ok",
    note: "Every deployment this run created is closed.",
  },
  leaked: {
    word: "Leaked",
    cls: "esc-bad",
    note: "At least one deployment is still active and holding funds.",
  },
};

const TICK_STEPS = [
  100, 250, 500, 1000, 2000, 2500, 5000, 10000, 15000, 20000, 30000, 60000, 120000, 300000, 600000,
  900000, 1800000, 3600000,
];

const UTC = "UTC";
const fWeekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: UTC });
const fDayNum = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: UTC });
const fDayLong = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: UTC,
});
const fDayShort = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: UTC,
});
const fStamp = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: UTC,
});

function el(tag, attrs, kids) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = String(v);
      else if (k === "style") node.setAttribute("style", v);
      else node.setAttribute(k, String(v));
    }
  }
  if (kids)
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function trimZeros(s) {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) {
    const s = ms / 1000;
    const text = trimZeros(s < 10 ? s.toFixed(2) : s.toFixed(1));
    if (text !== "60") return text + "s";
  }
  let m = Math.floor(ms / 60000);
  let s = Math.round((ms % 60000) / 1000);
  if (s === 60) {
    m += 1;
    s = 0;
  }
  return m + "m " + String(s).padStart(2, "0") + "s";
}

function fmtTick(ms) {
  if (ms === 0) return "0";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return trimZeros((ms / 1000).toFixed(1)) + "s";
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return s === 0 ? m + "m" : m + "m " + s + "s";
}

function fmtRelative(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const delta = now - t;
  if (delta < 0) return "just now";
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  const days = Math.floor(hours / 24);
  return days + (days === 1 ? " day ago" : " days ago");
}

function dayDate(day) {
  return new Date(day + "T00:00:00Z");
}

function middleTruncate(s, head, tail) {
  if (typeof s !== "string") return "";
  if (s.length <= head + tail + 1) return s;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

function stepSum(run) {
  let total = 0;
  for (const s of run.steps) total += Number(s.durationMs) || 0;
  return total;
}

function wallTime(run) {
  const a = Date.parse(run.startedAt);
  const b = Date.parse(run.finishedAt);
  if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return b - a;
  return stepSum(run);
}

function outcomeOf(run) {
  if (!run || !run.outcome) return OUTCOME.none;
  return OUTCOME[run.outcome.kind] || OUTCOME.none;
}

function weatherOf(cells, thresholds) {
  let passed = 0;
  let failed = 0;
  let aborted = 0;
  let noData = 0;
  for (const run of cells) {
    const kind = run && run.outcome ? run.outcome.kind : null;
    if (kind === "passed") passed += 1;
    else if (kind === "failed") failed += 1;
    else if (kind === "aborted") aborted += 1;
    else noData += 1;
  }
  const scored = passed + failed;
  const passRate = scored === 0 ? null : (passed / scored) * 100;
  const display = passRate === null ? null : Math.floor(passRate);
  let icon = null;
  let label = "no data";
  if (passRate !== null) {
    const hit = (thresholds || []).find(function (t) {
      return passRate >= t.minPassRate;
    });
    icon = hit ? hit.icon : null;
    // A scored row must never read "no data" beside a real percentage. If the
    // thresholds do not reach this rate, say so rather than claiming no runs.
    label = hit ? hit.label : "ungraded";
  }
  return {
    passed: passed,
    failed: failed,
    aborted: aborted,
    noData: noData,
    scored: scored,
    passRate: passRate,
    display: display,
    icon: icon,
    label: label,
  };
}

const DENSITIES = ["dense", "expanded"];

const FILTERS = [
  { id: "all", label: "All", empty: "No scenario is configured" },
  { id: "failing", label: "Failing", empty: "Nothing is failing right now" },
  { id: "passing", label: "Passing", empty: "Nothing passed its latest run" },
  { id: "noverdict", label: "No verdict", empty: "Every scenario reached a verdict" },
];

function storageGet(key, allowed, fallback) {
  try {
    const value = localStorage.getItem(key);
    return allowed.indexOf(value) >= 0 ? value : fallback;
  } catch (err) {
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    return;
  }
}

function latestRunOf(cells) {
  for (let i = cells.length - 1; i >= 0; i -= 1) {
    if (cells[i]) return { run: cells[i], dayIndex: i };
  }
  return null;
}

function bucketOf(latest) {
  if (!latest) return "noverdict";
  const kind = latest.run.outcome ? latest.run.outcome.kind : null;
  if (kind === "failed") return "failing";
  if (kind === "passed") return "passing";
  return "noverdict";
}

function compareVersions(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

function listWords(items) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

function daySignatures() {
  const days = state.data.days || [];
  return days.map(function (day, i) {
    const versions = new Set();
    for (const row of state.rows) {
      const run = row.cells[i];
      if (run && run.akt && run.akt.version) versions.add(run.akt.version);
    }
    return versions.size ? Array.from(versions).sort(compareVersions) : null;
  });
}

function versionHistory() {
  const sigs = daySignatures();
  const marks = new Map();
  const seen = [];
  let prev = null;
  sigs.forEach(function (sig, i) {
    if (!sig) return;
    for (const v of sig) if (seen.indexOf(v) < 0) seen.push(v);
    const changed = prev ? prev.join("|") !== sig.join("|") : sig.length > 1;
    if (changed) {
      marks.set(
        i,
        sig.length > 1
          ? { kind: "mixed", glyph: "\u25c7", label: "akt mixed on this day: " + listWords(sig) }
          : {
              kind: "change",
              glyph: "\u25c6",
              label:
                prev && prev.length === 1
                  ? "akt " + prev[0] + " to " + sig[0] + " on this day"
                  : "akt settled on " + sig[0] + " on this day",
            },
      );
    }
    prev = sig;
  });
  const live = sigs.filter(Boolean);
  const first = live.length ? live[0] : null;
  const last = live.length ? live[live.length - 1] : null;
  return { marks: marks, seen: seen, first: first, last: last };
}

function versionSpan(history) {
  const n = history.seen.length;
  if (!n) return null;
  if (n === 1) return history.seen[0];
  const from = listWords(history.first);
  const to = listWords(history.last);
  // First and last in day order, not sorted, so a rollout reads as the
  // transition that actually happened rather than as a min-to-max range.
  if (from === to) return from + ", " + n + " versions in this window";
  const text = from + " to " + to;
  return n > 2 ? text + ", " + n + " versions" : text;
}

const state = {
  data: null,
  rows: [],
  leaks: [],
  markers: new Map(),
  versions: { marks: new Map(), seen: [], first: null, last: null },
  selected: null,
  density: "dense",
  filter: "all",
};

function boot() {
  state.density = storageGet("ciweather.rows", DENSITIES, "dense");
  state.filter = storageGet(
    "ciweather.filter",
    FILTERS.map(function (f) {
      return f.id;
    }),
    "all",
  );
  document.documentElement.dataset.density = state.density;

  fetch("data.json", { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText + " for data.json");
      return res.json();
    })
    .then(render)
    .catch(showLoadError);
}

function showLoadError(err) {
  const panel = document.getElementById("load-error");
  const detail = document.getElementById("load-error-detail");
  detail.textContent =
    (err && err.message ? err.message : String(err)) +
    (location.protocol === "file:"
      ? " (this page is running from file://, which confirms the cause above)"
      : "");
  panel.hidden = false;
}

function render(data) {
  state.data = data;
  const thresholds = (data.weather && data.weather.thresholds) || [];
  const days = data.days || [];

  state.rows = (data.scenarios || []).map(function (s) {
    const cells = (Array.isArray(s.cells) ? s.cells : []).slice(0, days.length);
    while (cells.length < days.length) cells.push(null);
    const latest = latestRunOf(cells);
    return {
      id: s.id,
      title: s.title || s.id,
      question: s.question || "",
      cells: cells,
      weather: weatherOf(cells, thresholds),
      bucket: bucketOf(latest),
    };
  });

  state.rows.sort(function (a, b) {
    const ar = a.weather.passRate;
    const br = b.weather.passRate;
    if (ar === null && br === null) return a.title.localeCompare(b.title);
    if (ar === null) return 1;
    if (br === null) return -1;
    if (ar !== br) return ar - br;
    if (a.weather.scored !== b.weather.scored) return b.weather.scored - a.weather.scored;
    return a.title.localeCompare(b.title);
  });

  state.leaks = collectLeaks();
  state.versions = versionHistory();
  state.markers = state.versions.marks;

  renderMasthead();
  renderAlerts();
  renderFilterTabs();
  renderDensityControl();
  renderGrid();
  applyFilter();
  renderUnregistered();
  document.getElementById("alerts").addEventListener("click", onAlertsClick);
  const controls = document.getElementById("controls");
  controls.addEventListener("click", onControlsClick);
  document.getElementById("filter-empty").addEventListener("click", onControlsClick);
  document.getElementById("filter-tabs").addEventListener("keydown", onTabsKeydown);
  document.getElementById("grid").addEventListener("click", onGridClick);

  document.getElementById("grid-section").hidden = false;

  const first = defaultSelection();
  if (first) select(first.rowId, first.dayIndex, false);

  window.addEventListener("resize", onResize, { passive: true });
  // Labels are kept or dropped by measurement, so the fitting pass has to run
  // again once the webfont swaps in and every width changes under it.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutTimeline);
}

function runCount() {
  let total = 0;
  for (const row of state.rows) {
    for (const run of row.cells) if (run) total += 1;
  }
  return total;
}

function collectLeaks() {
  const out = [];
  for (const row of state.rows) {
    row.cells.forEach(function (run, i) {
      if (!run || !run.escrow || run.escrow.kind !== "leaked") return;
      const active = Array.isArray(run.escrow.stillActive) ? run.escrow.stillActive : [];
      for (const entry of active) out.push({ row: row, run: run, dayIndex: i, entry: entry });
    });
  }
  return out;
}

function pickSelection(rows) {
  const days = state.data.days || [];
  for (let i = days.length - 1; i >= 0; i -= 1) {
    for (const row of rows) {
      const run = row.cells[i];
      if (run && run.outcome && run.outcome.kind === "failed")
        return { rowId: row.id, dayIndex: i };
    }
  }
  for (let i = days.length - 1; i >= 0; i -= 1) {
    for (const row of rows) {
      if (row.cells[i]) return { rowId: row.id, dayIndex: i };
    }
  }
  return null;
}

function defaultSelection() {
  const shown = state.rows.filter(function (row) {
    return state.filter === "all" || row.bucket === state.filter;
  });
  return pickSelection(shown) || pickSelection(state.rows);
}

function renderMasthead() {
  const data = state.data;
  const days = data.days || [];
  const host = document.getElementById("masthead-chips");
  clear(host);

  for (const net of data.networks || []) {
    const netParts = [el("span", { class: "chip-mono", text: net.chainId })];
    if (net.name && net.name !== net.chainId) netParts.unshift(el("span", { text: net.name }));
    host.appendChild(chip("Network", netParts));
  }

  if (days.length) {
    host.appendChild(
      chip("Window", [
        el("span", {
          class: "chip-mono",
          text:
            fDayShort.format(dayDate(days[0])) +
            " to " +
            fDayShort.format(dayDate(days[days.length - 1])),
        }),
        el("span", { text: days.length + " days" }),
      ]),
    );
  }

  if (data.generatedAt) {
    const rel = fmtRelative(data.generatedAt, Date.now());
    const abs = Number.isFinite(Date.parse(data.generatedAt))
      ? fStamp.format(new Date(data.generatedAt)) + " UTC"
      : data.generatedAt;
    host.appendChild(
      chip("Built", [
        el("span", { text: rel || "unknown" }),
        el("span", { class: "chip-mono", text: abs }),
      ]),
    );
  }

  const span = versionSpan(state.versions);
  if (span) {
    host.appendChild(chip("akt", [el("span", { class: "chip-mono", text: span })]));
  }

  const window_ = days.length;
  const heading = document.getElementById("grid-heading");
  if (window_) heading.textContent = "The last " + window_ + (window_ === 1 ? " day" : " days");
  const emptyBody = document.getElementById("grid-empty-body");
  if (window_)
    emptyBody.textContent =
      "Every scenario is configured but not one run landed in the last " +
      window_ +
      (window_ === 1 ? " day" : " days") +
      ", so there is nothing to grade. This is an empty dashboard, not a passing one and not a failing one.";

  const runs = runCount();
  const note = document.getElementById("grid-note");
  note.textContent =
    runs === 0
      ? "Worst weather first. No runs recorded in this window."
      : "Worst weather first. " +
        runs +
        (runs === 1 ? " run" : " runs") +
        " across " +
        state.rows.length +
        (state.rows.length === 1 ? " scenario." : " scenarios.");
}

function chip(label, kids) {
  return el(
    "div",
    { class: "chip" },
    [el("span", { class: "chip-key", text: label })].concat(kids),
  );
}

function renderAlerts() {
  const host = document.getElementById("alerts");
  clear(host);
  if (!state.leaks.length) return;

  let total = 0n;
  let priced = 0;
  let unpriced = 0;
  for (const leak of state.leaks) {
    const v = leak.entry.depositUact;
    if (typeof v === "string" && /^[0-9]+$/.test(v)) {
      total += BigInt(v);
      priced += 1;
    } else {
      unpriced += 1;
    }
  }

  // Calling sandbox tokens real money would be the kind of lie this dashboard exists to
  // catch, so the warning follows the chain the leak actually happened on.
  function leakStakes(leaks) {
    const chains = new Set(leaks.map((l) => l.run?.network?.chainId));
    if (chains.size === 1 && chains.has("akashnet-2")) return ". This is real money.";
    if (chains.has("akashnet-2")) return ". At least one is mainnet, so real money.";
    return ". These are test-network funds, not real money.";
  }

  const lines = state.leaks.map(function (leak) {
    const jump = el(
      "button",
      {
        type: "button",
        class: "leak-jump",
        "data-row": leak.row.id,
        "data-day": String(leak.dayIndex),
      },
      [
        el("span", { text: leak.row.title }),
        el("span", {
          class: "leak-day",
          text: fDayShort.format(dayDate(state.data.days[leak.dayIndex])),
        }),
      ],
    );

    const facts = el("dl", { class: "leak-facts" }, [
      el("dt", { text: "dseq" }),
      el("dd", { class: "mono", text: leak.entry.dseq || "unrecorded" }),
      el("dt", { text: "Deposit at risk" }),
      el("dd", {
        class: "mono",
        text:
          typeof leak.entry.depositUact === "string"
            ? leak.entry.depositUact + " uact"
            : "not recorded",
      }),
      el("dt", { text: "akt said" }),
      el("dd", { class: "mono leak-reason", text: leak.entry.reason || "no reason recorded" }),
    ]);

    const link =
      leak.run.ci && leak.run.ci.runUrl
        ? el("a", { class: "leak-link", href: leak.run.ci.runUrl, rel: "noreferrer noopener" }, [
            "Open the CI run",
          ])
        : el("span", { class: "leak-link is-absent", text: "No CI run recorded" });

    return el("li", { class: "leak" }, [jump, facts, link]);
  });

  const showLabel =
    state.leaks.length === 1
      ? "Show the deployment"
      : "Show the " + state.leaks.length + " deployments";

  const banner = el(
    "section",
    { class: "alert", "aria-labelledby": "leak-heading", "data-open": "false" },
    [
      el("p", { class: "alert-head", id: "leak-heading" }, [
        el("span", { class: "alert-glyph", "aria-hidden": "true", text: "⚠" }),
        el("strong", { text: "Funds locked on chain" }),
        el("b", {
          class: "alert-total",
          text: priced ? total.toString() + " uact" : "amount not recorded",
        }),
      ]),
      el("button", {
        type: "button",
        class: "alert-toggle",
        "aria-expanded": "false",
        "aria-controls": "leak-list",
        "data-show-label": showLabel,
        text: showLabel,
      }),
      el("p", { class: "alert-body" }, [
        "Deployments this dashboard created are still active and still holding deposits, across " +
          priced +
          (priced === 1 ? " deployment" : " deployments") +
          (unpriced ? ", plus " + unpriced + " with no deposit recorded" : "") +
          leakStakes(state.leaks) +
          " It stays locked until someone closes the deployment.",
      ]),
      el("ul", { class: "leak-list", id: "leak-list" }, lines),
    ],
  );

  host.appendChild(banner);
}

function renderUnregistered() {
  const host = document.getElementById("unregistered");
  const list = state.data.unregisteredScenarios || [];
  if (!list.length) {
    host.hidden = true;
    return;
  }
  clear(host);
  host.appendChild(
    document.createTextNode(
      list.length +
        (list.length === 1 ? " run directory has" : " run directories have") +
        " no entry in scenarios.yaml, so they are recorded but not graded: ",
    ),
  );
  list.forEach(function (name, i) {
    if (i) host.appendChild(document.createTextNode(", "));
    host.appendChild(el("code", { text: name }));
  });
  host.appendChild(document.createTextNode("."));
  host.hidden = false;
}

function bucketCounts() {
  const counts = { all: state.rows.length, failing: 0, passing: 0, noverdict: 0 };
  for (const row of state.rows) counts[row.bucket] += 1;
  return counts;
}

function renderFilterTabs() {
  const host = document.getElementById("filter-tabs");
  clear(host);
  const counts = bucketCounts();
  for (const f of FILTERS) {
    const on = state.filter === f.id;
    host.appendChild(
      el(
        "button",
        {
          type: "button",
          role: "tab",
          id: "tab-" + f.id,
          class: "tab" + (on ? " is-on" : ""),
          "aria-selected": on ? "true" : "false",
          tabindex: on ? "0" : "-1",
          "data-filter": f.id,
        },
        [
          el("span", { class: "tab-label", text: f.label }),
          el("span", { class: "tab-count", text: String(counts[f.id]) }),
        ],
      ),
    );
  }
}

function renderDensityControl() {
  const host = document.getElementById("density-control");
  clear(host);
  host.appendChild(el("span", { class: "ctl-key", text: "Rows" }));
  for (const id of DENSITIES) {
    const on = state.density === id;
    host.appendChild(
      el("button", {
        type: "button",
        class: "ctl-btn" + (on ? " is-on" : ""),
        "aria-pressed": on ? "true" : "false",
        "data-density": id,
        text: id === "dense" ? "Dense" : "Expanded",
      }),
    );
  }
}

function setFilter(id) {
  if (
    !FILTERS.some(function (f) {
      return f.id === id;
    })
  )
    return;
  const hadFocus = document.activeElement && document.activeElement.closest("#filter-tabs");
  state.filter = id;
  storageSet("ciweather.filter", id);
  renderFilterTabs();
  applyFilter();
  // renderFilterTabs replaces the buttons, so focus would otherwise fall to body.
  if (hadFocus) {
    const button = document.getElementById("tab-" + id);
    if (button) button.focus();
  }
}

function applyFilter() {
  let shown = 0;
  for (const tr of document.querySelectorAll(".grid tbody tr")) {
    const on = state.filter === "all" || tr.dataset.bucket === state.filter;
    tr.hidden = !on;
    tr.classList.toggle("is-first-row", on && shown === 0);
    if (on) shown += 1;
  }
  const hasRows = state.rows.length > 0;
  const blank = hasRows && shown === 0;
  document.getElementById("grid-scroll").hidden = blank;
  document.getElementById("grid-empty").hidden = runCount() !== 0 || blank;
  renderFilterEmpty(blank);
}

function renderFilterEmpty(blank) {
  const host = document.getElementById("filter-empty");
  if (!blank) {
    host.hidden = true;
    return;
  }
  const match = FILTERS.find(function (f) {
    return f.id === state.filter;
  });
  const label = match ? match.label : state.filter;
  clear(host);
  const back = el("button", {
    type: "button",
    class: "btn-inline",
    text: "Show all scenarios",
    "data-filter": "all",
  });
  host.appendChild(el("p", { class: "empty-head", text: match ? match.empty : "Nothing matches" }));
  host.appendChild(
    el("p", {
      class: "empty-body",
      text:
        "The " +
        label +
        " tab is selected and nothing in this window matches it. The other tabs show how many scenarios they hold.",
    }),
  );
  host.appendChild(back);
  host.hidden = false;
}

function setDensity(id) {
  if (DENSITIES.indexOf(id) < 0) return;
  state.density = id;
  storageSet("ciweather.rows", id);
  document.documentElement.dataset.density = id;
  const hadFocus = document.activeElement && document.activeElement.closest("#density-control");
  renderDensityControl();
  renderGrid();
  applyFilter();
  if (hadFocus) {
    const button = document.querySelector('#density-control [data-density="' + id + '"]');
    if (button) button.focus();
  }
  if (state.selected) select(state.selected.rowId, state.selected.dayIndex, false);
}

function onControlsClick(event) {
  const tab = event.target.closest("[data-filter]");
  if (tab) {
    setFilter(tab.dataset.filter);
    return;
  }
  const density = event.target.closest("[data-density]");
  if (density) setDensity(density.dataset.density);
}

function onTabsKeydown(event) {
  const step = { ArrowLeft: -1, ArrowRight: 1, Home: "first", End: "last" };
  if (!(event.key in step)) return;
  event.preventDefault();
  const ids = FILTERS.map(function (f) {
    return f.id;
  });
  const at = ids.indexOf(state.filter);
  const move = step[event.key];
  let next;
  if (move === "first") next = 0;
  else if (move === "last") next = ids.length - 1;
  else next = (at + move + ids.length) % ids.length;
  setFilter(ids[next]);
}

function renderGrid() {
  const data = state.data;
  const days = data.days || [];
  const table = document.getElementById("grid");
  const caption = table.querySelector("caption");
  clear(table);
  if (caption) table.appendChild(caption);

  const thead = el("thead");
  const headRow = el("tr");
  headRow.appendChild(
    el("th", { class: "corner", scope: "col" }, [
      el("span", { class: "sr-only", text: "Scenario" }),
    ]),
  );
  days.forEach(function (day, i) {
    const latest = i === days.length - 1;
    const mark = state.markers.get(i);
    const th = el(
      "th",
      {
        class: "day-head" + (latest ? " is-latest" : "") + (mark ? " is-version-edge" : ""),
        scope: "col",
        "aria-current": latest ? "date" : null,
      },
      [
        el("span", { class: "day-wd", text: fWeekday.format(dayDate(day)).toUpperCase() }),
        el("span", { class: "day-num", text: fDayNum.format(dayDate(day)) }),
        latest ? el("span", { class: "sr-only", text: " (most recent)" }) : null,
        mark
          ? el("span", {
              class: "ver-mark ver-" + mark.kind,
              role: "img",
              "aria-label": mark.label,
              title: mark.label,
              text: mark.glyph,
            })
          : null,
      ],
    );
    th.title = fDayLong.format(dayDate(day)) + (mark ? "\n" + mark.label : "");
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const row of state.rows) {
    const tr = el("tr", { "data-row": row.id, "data-bucket": row.bucket });
    tr.appendChild(rowHeader(row));
    row.cells.forEach(function (run, i) {
      tr.appendChild(dayCell(row, run, i, days[i]));
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

function weatherTitle(row) {
  const w = row.weather;
  const head = row.title + (row.question ? "\n" + row.question : "");
  if (w.display === null) {
    return head + "\nNo scored runs in this window, so there is no weather to report.";
  }
  return (
    head +
    "\n" +
    w.label +
    ", " +
    w.display +
    "% of scored runs passed" +
    "\n" +
    w.passed +
    " passed, " +
    w.failed +
    " failed" +
    (w.aborted ? ", " + w.aborted + " aborted and left out of the rate" : "") +
    (w.noData ? ", " + w.noData + " with no run" : "")
  );
}

function weatherIcon(w) {
  return w.icon
    ? el("span", { class: "wx", role: "img", "aria-label": w.label, text: w.icon })
    : el("span", { class: "wx wx-none", "aria-hidden": "true", text: "\u00b7" });
}

function rateNode(w) {
  return w.display === null
    ? el("span", { class: "rate-none", text: "no runs" })
    : el("b", { class: "rate-num", text: w.display + "%" });
}

function rowHeader(row) {
  const head = el("th", { class: "row-head", scope: "row" }, [
    state.density === "dense" ? denseHead(row) : expandedHead(row),
  ]);
  head.title = weatherTitle(row);
  return head;
}

function denseHead(row) {
  const w = row.weather;
  return el("div", { class: "rh rh-dense" }, [
    weatherIcon(w),
    el("span", { class: "rh-title", text: row.title }),
    el("span", { class: "rh-label", text: w.label }),
    sparkline(row, true),
    rateNode(w),
  ]);
}

function expandedHead(row) {
  const w = row.weather;
  const rate =
    w.display === null
      ? rateNode(w)
      : el("span", { class: "rate" }, [
          rateNode(w),
          el("span", { class: "rate-frac", text: w.passed + "/" + w.scored + " passed" }),
        ]);

  const ran = w.passed + w.failed + w.aborted;
  const coverage = [el("span", { class: "cov", text: ran + "/" + (ran + w.noData) + " days" })];
  if (w.aborted > 0) {
    coverage.push(el("span", { class: "cov cov-warn", text: w.aborted + " aborted" }));
  }

  return el("div", { class: "rh" }, [
    el("div", { class: "rh-top" }, [
      weatherIcon(w),
      el("div", { class: "rh-name" }, [
        el("span", { class: "rh-title", text: row.title }),
        el("span", { class: "rh-label", text: w.label }),
      ]),
    ]),
    el("p", { class: "rh-q", text: row.question }),
    el("div", { class: "rh-stats" }, [rate].concat(coverage)),
    sparkline(row, false),
  ]);
}

function dayCell(row, run, dayIndex, day) {
  const o = outcomeOf(run);
  const td = el("td", {
    class: "day-cell" + (state.markers.has(dayIndex) ? " is-version-edge" : ""),
  });
  const leaked = !!(run && run.escrow && run.escrow.kind === "leaked");

  const parts = [row.title + ", " + fDayLong.format(dayDate(day)) + ", " + o.word];
  if (run && run.outcome && run.outcome.kind === "failed")
    parts.push("at step " + run.outcome.atStep);
  if (leaked) parts.push("funds locked on chain");

  const btn = el(
    "button",
    {
      type: "button",
      class: "cell " + o.cls + (leaked ? " has-leak" : ""),
      "data-row": row.id,
      "data-day": String(dayIndex),
      "aria-label": parts.join(", ") + ".",
      "aria-pressed": "false",
    },
    [
      el("span", { class: "cell-glyph", "aria-hidden": "true", text: o.glyph }),
      leaked ? el("span", { class: "cell-leak", "aria-hidden": "true" }) : null,
    ],
  );

  const hover = [row.title + " · " + fDayLong.format(dayDate(day)), o.word.toUpperCase()];
  if (run && run.outcome && run.outcome.kind === "failed") {
    hover[1] = "FAILED at " + run.outcome.atStep;
    hover.push(run.outcome.message);
  } else if (run && run.outcome && run.outcome.kind === "aborted") {
    hover.push(run.outcome.reason);
  }
  if (leaked) hover.push("Funds locked on chain.");
  btn.title = hover.join("\n");

  td.appendChild(btn);
  return td;
}

function revealDetail() {
  const target = document.getElementById("detail-section");
  if (!target) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
}

function onGridClick(event) {
  const btn = event.target.closest("button.cell");
  if (!btn) return;
  select(btn.dataset.row, Number(btn.dataset.day), true);
  // detail === 0 is a click synthesized from Enter or Space, so a keyboard user
  // arrowing across the grid is never yanked down the page.
  if (event.detail > 0) revealDetail();
}

function onAlertsClick(event) {
  const toggle = event.target.closest(".alert-toggle");
  if (toggle) {
    const alert = toggle.closest(".alert");
    const open = alert.dataset.open !== "true";
    alert.dataset.open = open ? "true" : "false";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.textContent = open ? "Hide the detail" : toggle.dataset.showLabel;
    return;
  }
  const btn = event.target.closest("button.leak-jump");
  if (!btn) return;
  select(btn.dataset.row, Number(btn.dataset.day), true);
  revealDetail();
}

function select(rowId, dayIndex, announce) {
  const row = state.rows.find(function (r) {
    return r.id === rowId;
  });
  const days = state.data.days || [];
  if (!row || !Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= days.length) return;
  state.selected = { rowId: rowId, dayIndex: dayIndex };

  for (const btn of document.querySelectorAll("button.cell")) {
    const on = btn.dataset.row === rowId && Number(btn.dataset.day) === dayIndex;
    btn.classList.toggle("is-selected", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  const run = row.cells[dayIndex];
  const day = state.data.days[dayIndex];
  renderDetail(row, run, day);

  if (announce) {
    const o = outcomeOf(run);
    document.getElementById("live").textContent =
      "Showing " + row.title + ", " + fDayLong.format(dayDate(day)) + ", " + o.word + ".";
  }
}

function renderDetail(row, run, day) {
  const host = document.getElementById("detail");
  clear(host);
  document.getElementById("detail-section").hidden = false;

  if (!run) {
    host.appendChild(
      el("div", { class: "panel panel-empty" }, [
        el("p", { class: "empty-head" }, [
          row.title,
          " did not run on ",
          fDayShort.format(dayDate(day)),
        ]),
        el("p", {
          class: "empty-body",
          text: "No run file exists for this day. A missing day is not a failure and never enters the pass rate, so this square is left out of the weather entirely.",
        }),
      ]),
    );
    return;
  }

  const panel = el("div", { class: "panel" });
  panel.appendChild(detailHead(row, run, day));

  const timeline = buildTimeline(run);
  panel.appendChild(timeline);
  panel.appendChild(stepTable(run));

  const verdict = verdictBlock(run);
  if (verdict) panel.appendChild(verdict);

  const cols = el(
    "div",
    { class: "panel-cols" },
    [
      leaseBlock(run),
      probeBlock(run),
      attestationBlock(run),
      escrowBlock(run),
      reapBlock(run),
    ].filter(Boolean),
  );
  panel.appendChild(cols);

  host.appendChild(panel);
  layoutTimeline();
}

function detailHead(row, run, day) {
  const o = outcomeOf(run);
  const meta = [];

  meta.push(metaPair("Wall time", fmtDuration(wallTime(run))));
  if (run.network) meta.push(metaPair("Network", run.network.chainId));
  if (run.akt && run.akt.version) meta.push(metaPair("akt", run.akt.version));
  if (run.lease && run.lease.dseq) meta.push(metaPair("dseq", run.lease.dseq));
  // The timeline below covers the final attempt only, while wall time spans them all.
  // Without this the two silently disagree and nothing on screen explains the gap.
  if (run.attempts && run.attempts.count > 1)
    meta.push(metaPair("Deploy attempts", String(run.attempts.count)));
  if (run.ci && Number.isFinite(run.ci.attempt))
    meta.push(metaPair("CI attempt", String(run.ci.attempt)));

  const link =
    run.ci && run.ci.runUrl
      ? el("a", { class: "runlink", href: run.ci.runUrl, rel: "noreferrer noopener" }, [
          el("span", { text: "Open the CI run" }),
          el("span", { class: "runlink-arrow", "aria-hidden": "true", text: "↗" }),
        ])
      : el("span", { class: "runlink is-absent", text: "No CI run URL recorded" });

  return el("header", { class: "panel-head" }, [
    el("div", { class: "panel-head-main" }, [
      el("p", { class: "eyebrow", text: "Run detail" }),
      el("h2", { class: "panel-title" }, [
        el("span", { text: row.title }),
        el("span", { class: "panel-sep", "aria-hidden": "true", text: "·" }),
        el("span", { class: "panel-day", text: fDayLong.format(dayDate(day)) }),
      ]),
      el("p", { class: "panel-q", text: row.question }),
    ]),
    el("div", { class: "panel-head-side" }, [
      el("p", { class: "badge badge-" + run.outcome.kind }, [
        el("span", { class: "badge-glyph", "aria-hidden": "true", text: o.glyph }),
        el("span", {
          text:
            run.outcome.kind === "failed"
              ? "Failed at " + run.outcome.atStep
              : o.word.charAt(0).toUpperCase() + o.word.slice(1),
        }),
      ]),
      link,
    ]),
    el("dl", { class: "panel-meta" }, meta),
  ]);
}

function metaPair(key, value) {
  return el("div", {}, [el("dt", { text: key }), el("dd", { class: "mono", text: value })]);
}

function metaItem(key, value) {
  return [el("dt", { text: key }), el("dd", {}, [value])];
}

const OPTIONAL_STEPS = new Set(["attestation"]);

function stepModel(run) {
  const order = state.data.stepOrder || [];
  const rank = new Map(
    order.map(function (s, i) {
      return [s, i];
    }),
  );
  const steps = run.steps || [];
  const seen = new Set(
    steps.map(function (s) {
      return s.step;
    }),
  );
  const ordered = steps
    .map(function (s, i) {
      return {
        step: s,
        known: rank.has(s.step),
        rank: rank.has(s.step) ? rank.get(s.step) : order.length,
        seq: i,
      };
    })
    .sort(function (a, b) {
      return a.rank - b.rank || a.seq - b.seq;
    });
  const missing = order.filter(function (s) {
    // Only some scenarios ever run attestation, so its absence is never a gap.
    return !seen.has(s) && !OPTIONAL_STEPS.has(s);
  });
  return { steps: steps, ordered: ordered, missing: missing, rank: rank };
}

function buildTimeline(run) {
  const model = stepModel(run);
  const steps = model.steps;
  const missing = model.missing;
  const known = model.rank;
  const total = stepSum(run);

  const bar = el("div", {
    class: "tl-bar",
    role: "img",
    "aria-label": timelineLabel(run, missing),
  });
  const failingIndex = steps.findIndex(function (s) {
    return s.result === "failed";
  });

  steps.forEach(function (s, i) {
    const r = STEP_RESULT[s.result] || { word: s.result || "unknown", cls: "seg-unknown" };
    const dur = Number(s.durationMs) || 0;
    const isKnown = known.has(s.step);
    const seg = el(
      "div",
      {
        class: "tl-seg " + r.cls + (i === failingIndex ? " is-failing" : ""),
        style: "flex-grow:" + Math.max(dur, 0) + ";flex-basis:0",
        "data-seg": String(i),
      },
      [el("span", { class: "tl-seg-label", text: s.step })],
    );
    const tip = [s.step + (isKnown ? "" : " (unknown step)"), r.word + ", " + fmtDuration(dur)];
    if (Array.isArray(s.errors)) for (const e of s.errors) tip.push(e);
    seg.dataset.tip = tip.join("\n");
    seg.setAttribute("aria-label", tip.join(". "));
    bar.appendChild(seg);
  });

  if (!steps.length) {
    bar.appendChild(
      el("div", { class: "tl-seg seg-unknown", style: "flex-grow:1;flex-basis:0" }, [
        el("span", { class: "tl-seg-label", text: "no steps recorded" }),
      ]),
    );
  }

  const rail = el("div", { class: "tl-rail" });
  if (failingIndex >= 0 && total > 0) {
    let before = 0;
    for (let i = 0; i < failingIndex; i += 1) before += Number(steps[i].durationMs) || 0;
    const width = Number(steps[failingIndex].durationMs) || 0;
    const at = ((before + width / 2) / total) * 100;
    rail.dataset.at = String(at);
    rail.appendChild(
      el("div", { class: "tl-callout-box" }, [
        el("span", { class: "tl-callout-step", text: steps[failingIndex].step }),
        el("span", { class: "tl-callout-word", text: "failed here" }),
        el("span", { class: "tl-callout-dur", text: fmtDuration(width) }),
      ]),
    );
    rail.appendChild(el("div", { class: "tl-callout-pin", style: "left:" + at.toFixed(3) + "%" }));
  }

  const axis = el("div", { class: "tl-axis" });
  if (total > 0) {
    const step = tickStep(total);
    for (let t = 0; t <= total; t += step) {
      const p = (t / total) * 100;
      if (t > 0 && p > 92) continue;
      axis.appendChild(tick(p, fmtTick(t), p < 4 ? "at-start" : ""));
    }
    axis.appendChild(tick(100, fmtDuration(total), "at-end"));
  }

  const tip = el("div", { class: "tl-tip", hidden: true });
  bar.addEventListener("pointerleave", function () {
    tip.hidden = true;
  });
  bar.addEventListener("pointermove", function (event) {
    const seg = event.target.closest(".tl-seg");
    if (!seg || !seg.dataset.tip) {
      tip.hidden = true;
      return;
    }
    tip.textContent = seg.dataset.tip;
    tip.hidden = false;
    const barBox = bar.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const x = event.clientX - barBox.left;
    tip.style.left = Math.max(half, Math.min(barBox.width - half, x)) + "px";
  });

  const node = el("div", { class: "tl" + (missing.length ? "" : " tl--notail") }, [
    rail,
    bar,
    tip,
    axis,
    missing.length
      ? el("div", { class: "tl-tail", title: "Never attempted: " + missing.join(", ") }, [
          el("span", { class: "tl-tail-n", text: String(missing.length) }),
          el("span", {
            class: "tl-tail-word",
            text: missing.length === 1 ? "step not reached" : "steps not reached",
          }),
        ])
      : null,
  ]);

  const wrap = el("section", { class: "panel-sec" }, [
    el("h3", { class: "eyebrow", text: "Where the time went" }),
    node,
    el("ul", { class: "tl-legend" }, [
      legendDot("seg-completed", "Completed"),
      legendDot("seg-failed", "Failed"),
      legendDot("seg-skipped", "Skipped after the failure"),
      el("li", { class: "tl-legend-item" }, [
        el("span", { class: "tl-legend-swatch tl-legend-tail", "aria-hidden": "true" }),
        el("span", { text: "Never reached, consumed no time" }),
      ]),
    ]),
  ]);

  return wrap;
}

function timelineLabel(run, missing) {
  const parts = (run.steps || []).map(function (s) {
    return (
      s.step +
      " " +
      (STEP_RESULT[s.result] ? STEP_RESULT[s.result].word : String(s.result)) +
      " in " +
      fmtDuration(Number(s.durationMs) || 0)
    );
  });
  if (missing.length) parts.push(missing.length + " further steps were never reached");
  return "Step timeline. " + (parts.length ? parts.join(". ") : "No steps recorded") + ".";
}

function legendDot(cls, word) {
  return el("li", { class: "tl-legend-item" }, [
    el("span", { class: "tl-legend-swatch " + cls, "aria-hidden": "true" }),
    el("span", { text: word }),
  ]);
}

function tick(percent, label, extra) {
  return el(
    "div",
    { class: "tl-tick " + (extra || ""), style: "left:" + percent.toFixed(3) + "%" },
    [
      el("span", { class: "tl-tick-mark", "aria-hidden": "true" }),
      el("span", { class: "tl-tick-label", text: label }),
    ],
  );
}

function tickStep(total) {
  for (const s of TICK_STEPS) if (total / s <= 4) return s;
  return TICK_STEPS[TICK_STEPS.length - 1];
}

function layoutTimeline() {
  const bar = document.querySelector("#detail .tl-bar");
  if (bar) {
    for (const label of bar.querySelectorAll(".tl-seg-label")) {
      label.hidden = false;
      const seg = label.parentElement;
      label.hidden = label.offsetWidth + 12 > seg.clientWidth;
    }
  }
  const rail = document.querySelector("#detail .tl-rail");
  const box = rail ? rail.querySelector(".tl-callout-box") : null;
  if (!rail || !box || !rail.dataset.at) return;
  const railWidth = rail.clientWidth;
  const boxWidth = box.offsetWidth;
  const centre = (parseFloat(rail.dataset.at) / 100) * railWidth;
  const left = Math.max(0, Math.min(centre - boxWidth / 2, railWidth - boxWidth));
  box.style.left = left.toFixed(2) + "px";
  rail.style.height = Math.max(34, box.offsetHeight + 11) + "px";
}

let resizePending = false;
function onResize() {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(function () {
    resizePending = false;
    layoutTimeline();
  });
}

function stepTable(run) {
  const model = stepModel(run);
  const rows = model.ordered;
  const missing = model.missing;

  const body = el("tbody");
  for (const r of rows) {
    const s = r.step;
    const result = STEP_RESULT[s.result] || {
      word: String(s.result || "unknown"),
      cls: "seg-unknown",
    };
    const tr = el("tr", { class: s.result === "failed" ? "is-failing" : "" }, [
      el("th", { scope: "row" }, [
        el("span", { class: "st-name", text: s.step }),
        r.known
          ? null
          : el("span", {
              class: "st-unknown",
              title:
                "This step is not in the known vocabulary, so it is rendered as unknown and ordered last.",
              text: "unknown",
            }),
      ]),
      el("td", {}, [el("span", { class: "st-badge " + result.cls, text: result.word })]),
      el("td", { class: "mono st-dur", text: fmtDuration(Number(s.durationMs) || 0) }),
      el("td", {}, [txList(s.txs)]),
      el("td", {}, [errorList(s.errors)]),
    ]);
    body.appendChild(tr);
  }

  for (const name of missing) {
    body.appendChild(
      el("tr", { class: "is-missing" }, [
        el("th", { scope: "row" }, [el("span", { class: "st-name", text: name })]),
        el("td", {}, [el("span", { class: "st-badge seg-notreached", text: "not reached" })]),
        el("td", { class: "st-dur st-quiet", text: "no time" }),
        el("td", { class: "st-quiet", text: "none" }),
        el("td", { class: "st-quiet", text: "never attempted" }),
      ]),
    );
  }

  if (!rows.length && !missing.length) {
    body.appendChild(
      el("tr", {}, [
        el("td", { colspan: "5", class: "st-quiet", text: "This run recorded no steps." }),
      ]),
    );
  }

  return el("section", { class: "panel-sec" }, [
    el("h3", { class: "eyebrow", text: "Every step, in order" }),
    el("div", { class: "st-scroll" }, [
      el("table", { class: "st" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { scope: "col", text: "Step" }),
            el("th", { scope: "col", text: "Result" }),
            el("th", { scope: "col", text: "Took" }),
            el("th", { scope: "col", text: "Transactions" }),
            el("th", { scope: "col", text: "Errors" }),
          ]),
        ]),
        body,
      ]),
    ]),
  ]);
}

function txList(txs) {
  if (!Array.isArray(txs) || !txs.length) return el("span", { class: "st-quiet", text: "none" });
  return el(
    "ul",
    { class: "tx-list" },
    txs.map(function (tx) {
      return el("li", {}, [
        el("code", { class: "tx-hash", title: tx.hash, text: middleTruncate(tx.hash, 6, 6) }),
        el("span", {
          class: tx.code === 0 ? "tx-code is-ok" : "tx-code is-bad",
          text: tx.code === 0 ? "code 0" : "code " + tx.code,
        }),
      ]);
    }),
  );
}

function errorList(errors) {
  if (!Array.isArray(errors) || !errors.length)
    return el("span", { class: "st-quiet", text: "none" });
  return el(
    "ul",
    { class: "err-list" },
    errors.map(function (e) {
      return el("li", { class: "mono", text: e });
    }),
  );
}

function verdictBlock(run) {
  if (run.outcome.kind === "failed") {
    return el("section", { class: "panel-sec verdict verdict-failed" }, [
      el("h3", { class: "eyebrow", text: "akt said" }),
      el("pre", { class: "verbatim" }, [el("code", { text: run.outcome.message })]),
      el("p", {
        class: "verdict-note",
        text: "That is the CLI's own text, copied out of the run file without a word changed.",
      }),
    ]);
  }
  if (run.outcome.kind === "aborted") {
    return el("section", { class: "panel-sec verdict verdict-aborted" }, [
      el("h3", { class: "eyebrow", text: "Run aborted" }),
      el("pre", { class: "verbatim" }, [el("code", { text: run.outcome.reason })]),
      el("p", {
        class: "verdict-note",
        text: "Our runner never reached a verdict, so this day is left out of the pass rate in both directions. Counting it as a failure would blame Akash for our own outage.",
      }),
    ]);
  }
  return null;
}

function ipText(lease) {
  const ips = lease && Array.isArray(lease.ips) ? lease.ips : [];
  return ips
    .map(function (e) {
      return e.ip + ":" + e.externalPort;
    })
    .join(", ");
}

function leaseBlock(run) {
  const lease = run.lease;
  const body = [];

  if (!lease) {
    body.push(
      el("p", {
        class: "block-empty",
        text: "No lease was created. The run never got past the point where a provider wins the order, so there is no provider, no price and no endpoint to report.",
      }),
    );
  } else {
    if (lease.providerOrg || lease.provider) {
      body.push(
        el("div", { class: "prov" }, [
          el("div", { class: "prov-name" }, [
            el("span", { text: lease.providerOrg || "Unnamed provider" }),
            typeof lease.providerAudited === "boolean"
              ? el("span", {
                  class: lease.providerAudited ? "tag tag-audited" : "tag tag-community",
                  text: lease.providerAudited ? "audited" : "community",
                })
              : null,
          ]),
          lease.provider
            ? el("code", {
                class: "prov-addr",
                title: lease.provider,
                text: middleTruncate(lease.provider, 12, 8),
              })
            : null,
        ]),
      );
    }
    const facts = [];
    const ips = ipText(lease);
    if (ips) {
      facts.push(metaItem("Dedicated IP", el("span", { class: "mono", text: ips })));
    }
    if (lease.providerRegion)
      facts.push(metaItem("Region", el("span", { text: lease.providerRegion })));
    if (lease.price)
      facts.push(
        metaItem(
          "Price",
          el("span", {
            class: "mono",
            text: trimZeros(String(lease.price.amount)) + " " + lease.price.denom,
          }),
        ),
      );
    if (Number.isFinite(lease.bidCount))
      facts.push(metaItem("Bids", el("span", { class: "mono", text: String(lease.bidCount) })));
    if (lease.dseq) facts.push(metaItem("dseq", el("span", { class: "mono", text: lease.dseq })));
    if (facts.length) body.push(el("dl", { class: "block-facts" }, facts.flat()));
    if (lease.providerRegion) {
      body.push(
        el("p", {
          class: "block-note",
          text: "Provider attributes are self declared, so the region is a hint for grouping and never an assertion.",
        }),
      );
    }
  }

  return block("The lease", body);
}

function probeBlock(run) {
  const probe = run.lease && run.lease.probe;
  const body = [];

  if (!probe) {
    body.push(
      el("p", {
        class: "block-empty",
        text: "The HTTP probe never ran, so nothing was asked of the workload.",
      }),
    );
    return block("The probe", body);
  }

  const attempts = Array.isArray(probe.attempts) ? probe.attempts : [];
  if (!attempts.length) {
    body.push(
      el("p", {
        class: "block-empty",
        text: "Nothing was dialled. The run had no endpoint to ask, so no scheme was ever tried.",
      }),
    );
    return block("The probe", body);
  }

  const winner = attempts.findIndex(function (a) {
    return (
      a.scheme === probe.servedBy && Number.isFinite(a.status) && a.status >= 200 && a.status < 300
    );
  });

  body.push(
    el("p", { class: "probe-head" }, [
      probe.servedBy
        ? el("span", { class: "probe-served" }, [
            el("b", { text: probe.servedBy.toUpperCase() }),
            el("span", { text: " answered" }),
          ])
        : el("span", { class: "probe-served is-bad", text: "Nothing answered" }),
      winner >= 0
        ? el("span", {
            class: "probe-count",
            text: "answered on attempt " + (winner + 1) + " of " + attempts.length,
          })
        : el("span", {
            class: "probe-count",
            text: attempts.length + (attempts.length === 1 ? " attempt" : " attempts"),
          }),
    ]),
  );

  const ips = ipText(run.lease);
  if (ips) {
    body.push(
      el("p", { class: "probe-ip" }, [
        el("span", { class: "probe-ip-label", text: "Dedicated IP" }),
        el("span", { class: "mono", text: ips }),
      ]),
    );
  }

  if (probe.url) {
    body.push(el("code", { class: "probe-url", title: probe.url, text: probe.url }));
  }

  body.push(
    el(
      "ol",
      { class: "att-list" },
      attempts.map(function (a) {
        const ok = Number.isFinite(a.status) && a.status >= 200 && a.status < 300;
        return el("li", { class: "att" + (ok ? " is-ok" : " is-bad") }, [
          el("span", { class: "att-scheme", text: a.scheme }),
          Number.isFinite(a.status)
            ? el("span", { class: "att-status mono", text: String(a.status) })
            : el("span", { class: "att-status mono is-absent", text: "no reply" }),
          el("span", { class: "att-dur mono", text: fmtDuration(Number(a.durationMs) || 0) }),
          typeof a.bodyMatched === "boolean"
            ? el("span", {
                class: a.bodyMatched ? "att-body is-ok" : "att-body is-bad",
                text: a.bodyMatched ? "body matched" : "body did not match",
              })
            : null,
          a.error ? el("span", { class: "att-err mono", text: a.error }) : null,
        ]);
      }),
    ),
  );

  body.push(
    el("p", {
      class: "block-note",
      text: "Akash lease hostnames carry no scheme, so the probe tries both. An https refusal followed by an http answer is ordinary, not a fault.",
    }),
  );

  return block("The probe", body);
}

function attestationFailureWord(record) {
  if (!record) return "Could not get a report";
  if (record.mockReport) return "Mock report, not real hardware";
  if (!record.nonceVerified) return "Nonce not verified";
  return "TEE type did not match";
}

function attestationBlock(run) {
  const step = (run.steps || []).find(function (s) {
    return s.step === "attestation";
  });
  const record = run.lease && run.lease.attestation;
  if (!step && !record) return null;

  const body = [];

  if (step && step.result === "failed") {
    body.push(
      el("p", { class: "tee-badge tee-alarm" }, [
        el("b", { text: attestationFailureWord(record) }),
        el("span", {
          class: "tee-note",
          text: (step.errors && step.errors[0]) || "No further detail recorded.",
        }),
      ]),
    );
  } else if (step && step.result === "completed") {
    body.push(
      el("p", { class: "tee-badge tee-ok" }, [
        el("b", { text: "Hardware-backed attestation verified" }),
        el("span", {
          class: "tee-note",
          text: "akt's own nonce round-tripped through a genuine hardware quote.",
        }),
      ]),
    );
  } else {
    body.push(
      el("p", { class: "tee-badge tee-none" }, [
        el("b", { text: "Attestation recorded" }),
        el("span", {
          class: "tee-note",
          text: "No step result was recorded alongside it, so this is reported without a verdict.",
        }),
      ]),
    );
  }

  if (record) {
    const facts = [metaItem("TEE type", el("span", { text: record.teeType }))];
    if (Number.isFinite(record.reportSizeBytes))
      facts.push(
        metaItem(
          "Report size",
          el("span", { class: "mono", text: record.reportSizeBytes + " bytes" }),
        ),
      );
    facts.push(
      metaItem("Nonce", el("span", { text: record.nonceVerified ? "verified" : "not verified" })),
    );
    facts.push(
      metaItem(
        "Mock report",
        record.mockReport
          ? el("span", { class: "is-bad", text: "yes" })
          : el("span", { text: "no" }),
      ),
    );
    facts.push(
      metaItem("Cert chain", el("span", { text: record.certChainPresent ? "present" : "none" })),
    );
    facts.push(
      metaItem("GPU reports", el("span", { class: "mono", text: String(record.gpuReportCount) })),
    );
    body.push(el("dl", { class: "block-facts" }, facts.flat()));
    body.push(
      el("p", {
        class: "block-note",
        text: "The nonce check only proves the report answered akt's own 64 byte challenge. A mock attestation sidecar echoes that nonce back with no TEE behind it at all, which is why a mock report fails the run even though the check itself passes.",
      }),
    );
  }

  return block("Attestation", body);
}

function escrowBlock(run) {
  const escrow = run.escrow;
  const body = [];

  if (!escrow) {
    body.push(
      el("p", { class: "block-empty", text: "This run recorded nothing about its escrow." }),
    );
    return block("Escrow", body);
  }

  const kind = ESCROW_KIND[escrow.kind] || { word: String(escrow.kind), cls: "esc-none", note: "" };
  body.push(
    el("p", { class: "esc-badge " + kind.cls }, [
      el("b", { text: kind.word }),
      kind.note ? el("span", { class: "esc-note", text: kind.note }) : null,
    ]),
  );

  const closed = Array.isArray(escrow.closed) ? escrow.closed : [];
  if (closed.length) {
    body.push(
      el(
        "ul",
        { class: "esc-list" },
        closed.map(function (c) {
          return el("li", {}, [
            el("span", { class: "esc-dseq mono", text: c.dseq }),
            c.closeTxHash
              ? el("code", {
                  class: "tx-hash",
                  title: c.closeTxHash,
                  text: middleTruncate(c.closeTxHash, 6, 6),
                })
              : el("span", { class: "st-quiet", text: "no close tx recorded" }),
          ]);
        }),
      ),
    );
  }

  const active = Array.isArray(escrow.stillActive) ? escrow.stillActive : [];
  if (active.length) {
    body.push(
      el(
        "ul",
        { class: "esc-list esc-active" },
        active.map(function (a) {
          return el("li", {}, [
            el("p", { class: "esc-active-head" }, [
              el("span", { class: "esc-dseq mono", text: a.dseq }),
              el("span", {
                class: "esc-amount mono",
                text:
                  typeof a.depositUact === "string"
                    ? a.depositUact + " uact"
                    : "deposit not recorded",
              }),
            ]),
            el("p", { class: "esc-reason mono", text: a.reason }),
          ]);
        }),
      ),
    );
  }

  return block("Escrow", body);
}

function reapBlock(run) {
  const reap = run.reap;
  if (!reap) return null;
  const closed = Array.isArray(reap.closedDseqs) ? reap.closedDseqs : [];
  const errors = Array.isArray(reap.errors) ? reap.errors : [];
  if (!closed.length && !errors.length) return null;

  const body = [];
  if (closed.length) {
    body.push(
      el("p", { class: "block-line" }, [
        "A previous run left ",
        el("b", { text: String(closed.length) }),
        closed.length === 1
          ? " deployment open. It was closed before this run started: "
          : " deployments open. They were closed before this run started: ",
        el("span", { class: "mono", text: closed.join(", ") }),
        ".",
      ]),
    );
  }
  if (errors.length) {
    body.push(
      el(
        "ul",
        { class: "err-list" },
        errors.map(function (e) {
          return el("li", { class: "mono", text: e });
        }),
      ),
    );
  }
  return block("Cleanup before this run", body);
}

function block(title, body) {
  return el(
    "section",
    { class: "block" },
    [el("h3", { class: "eyebrow", text: title })].concat(body),
  );
}

function sparkline(row, compact) {
  const days = state.data.days || [];
  const values = row.cells.map(function (run) {
    const n = run && run.lease ? run.lease.bidCount : null;
    return Number.isFinite(n) ? n : null;
  });

  const present = values.filter(function (v) {
    return v !== null;
  });
  const latest = present.length ? present[present.length - 1] : null;
  const max = Math.max(2, present.length ? Math.max.apply(null, present) : 0);

  const W = compact ? 48 : 72;
  const H = compact ? 14 : 20;
  const PAD = compact ? 5 : 6;
  const xOf = function (i) {
    return days.length > 1 ? (i / (days.length - 1)) * W : W / 2;
  };
  const yOf = function (v) {
    return H - (v / max) * H;
  };

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", compact ? "spark spark-mini" : "spark");
  svg.setAttribute("viewBox", -PAD + " " + -PAD + " " + (W + PAD * 2) + " " + (H + PAD * 2));
  svg.setAttribute("width", String(W + PAD * 2));
  svg.setAttribute("height", String(H + PAD * 2));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", sparkLabel(row, values, days));

  const runsOf = [];
  let cur = [];
  values.forEach(function (v, i) {
    if (v === null) {
      if (cur.length) runsOf.push(cur);
      cur = [];
    } else {
      cur.push({ x: xOf(i), y: yOf(v) });
    }
  });
  if (cur.length) runsOf.push(cur);

  for (const seg of runsOf) {
    if (seg.length > 1) {
      const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
      area.setAttribute(
        "d",
        "M" +
          seg
            .map(function (p) {
              return p.x.toFixed(2) + "," + p.y.toFixed(2);
            })
            .join("L") +
          "L" +
          seg[seg.length - 1].x.toFixed(2) +
          "," +
          H +
          "L" +
          seg[0].x.toFixed(2) +
          "," +
          H +
          "Z",
      );
      area.setAttribute("fill", "var(--accent)");
      area.setAttribute("fill-opacity", "0.1");
      area.setAttribute("stroke", "none");
      svg.appendChild(area);

      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      line.setAttribute(
        "d",
        "M" +
          seg
            .map(function (p) {
              return p.x.toFixed(2) + "," + p.y.toFixed(2);
            })
            .join("L"),
      );
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "var(--accent)");
      line.setAttribute("stroke-width", "2");
      line.setAttribute("stroke-linejoin", "round");
      line.setAttribute("stroke-linecap", "round");
      svg.appendChild(line);
    } else {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", seg[0].x.toFixed(2));
      dot.setAttribute("cy", seg[0].y.toFixed(2));
      dot.setAttribute("r", "2");
      dot.setAttribute("fill", "var(--accent)");
      svg.appendChild(dot);
    }
  }

  const lastIndex = values.reduce(function (acc, v, i) {
    return v === null ? acc : i;
  }, -1);
  if (lastIndex >= 0) {
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("cx", xOf(lastIndex).toFixed(2));
    ring.setAttribute("cy", yOf(values[lastIndex]).toFixed(2));
    ring.setAttribute("r", compact ? "3" : "4");
    ring.setAttribute("fill", "var(--accent)");
    ring.setAttribute("stroke", "var(--surface)");
    ring.setAttribute("stroke-width", "2");
    svg.appendChild(ring);
  }

  if (compact) return svg;

  return el("div", { class: "spark-wrap" }, [
    svg,
    latest === null
      ? el("span", { class: "spark-word", text: "no bid data" })
      : el("span", { class: "spark-value mono", text: String(latest) }),
    latest === null ? null : el("span", { class: "spark-word", text: "bids" }),
  ]);
}

function sparkLabel(row, values, days) {
  if (!days.length) return "No bid history for " + row.title + ".";
  const parts = values.map(function (v, i) {
    return (
      fDayShort.format(dayDate(days[i])) +
      " " +
      (v === null ? "no lease" : v + (v === 1 ? " bid" : " bids"))
    );
  });
  return "Bids per day for " + row.title + ". " + parts.join(", ") + ".";
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
