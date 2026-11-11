/* The unit table: the view that answers "where is the rest of the vote".
 *
 * A map answers that question worst of all -- an uncounted county and a
 * county that voted 50/50 are both pale, and the big empty one is the one
 * the eye goes to. A sorted list answers it directly, which is why this is
 * the second app rather than the tenth.
 *
 * It reads the same store as the map and nothing else, so the two can never
 * disagree about a number.
 */
/* Which rows to show. "Counting" is the election-night question -- where is
 * a count under way and not finished -- so it is the one a producer reaches
 * for; "not started" is the list of places that have not reported at all. */
// Results files a fallback wrote (source.provider), named in the header.
const FALLBACKS = { nyt: "New York Times", ap: "AP" };

export const FILTERS = [
  { key: "all", label: "All" },
  { key: "counting", label: "Counting" },
  { key: "none", label: "Not started" },
  { key: "complete", label: "Complete" },
];

/* The district list: every seat of one chamber (the U.S. House, the Senate
 * and governors by state, each legislature by district) with the seat's
 * 2024 presidential margin and its rating, sortable by district, rating or
 * margin. Its modules load on first use, so a fault here costs the table
 * this view, never the unit table. */
const RATING_STEPS = ["Uncontested", "Solid", "Very Likely", "Likely", "Lean", "Tilt"];

/** Rating label -> 0 (Uncontested D) .. 6 (Toss-up) .. 12 (Uncontested R); null if unrated. */
export function ratingRank(label) {
  if (label === "Toss-up") return 6;
  const m = /^(.*) ([DR])$/.exec(label || "");
  const i = m ? RATING_STEPS.indexOf(m[1]) : -1;
  if (i < 0) return null;
  return m[2] === "D" ? i : 12 - i;
}

export function createTableApp({ el, store, context, seats: seatsOf = () => null }) {
  let sortKey = "margin";
  let sortDir = -1;
  let filter = "all";

  let mode = "units";
  try { if (localStorage.getItem("mw.table.mode") === "districts") mode = "districts"; } catch (_) { /* private window */ }
  const dist = { chamber: "house", scope: null, sortKey: "district", sortDir: 1, mods: null, error: null };

  const COLUMNS = [
    { key: "name", label: "Unit", align: "left" },
    { key: "dem", label: "Dem" },
    { key: "rep", label: "Rep" },
    { key: "total", label: "Votes" },
    { key: "margin", label: "Margin" },
    { key: "swing", label: "Swing" },
    { key: "reporting", label: "Rep. %" },
    { key: "outstanding", label: "Est. left", title:
      "Estimate: the baseline's total votes in this unit minus the votes counted so far, floored at zero. Assumes turnout matches the baseline; not a projection." },
  ];

  const num = (n) => (n == null ? "—" : d3.format(",")(Math.round(n)));
  const pts = (v) =>
    v == null ? "—" : `${v >= 0 ? "D+" : "R+"}${d3.format(".1f")(Math.abs(v))}`;
  // A margin led by an independent is labeled with the leader's party
  // letter; its number is still the top-two margin (store.topTwo).
  const marginText = (r) => (r.margin == null ? "—"
    : r.lead === "ind" ? `I+${d3.format(".1f")(Math.abs(r.margin))}` : pts(r.margin));

  /* The outstanding estimate needs a baseline at the race's own tier: a
   * town's count minus a county's baseline is not a number. It is also
   * meaningless for a certified file, where nothing is outstanding and the
   * difference is only a turnout change. */
  function outstandingFor(ctx, data) {
    const { raceId, baselineKey, tier } = ctx;
    if (!raceId || !data || raceId === baselineKey) return { ok: false, why: "no live race" };
    const btier = store.baselineTier(baselineKey);
    const rtier = { cd: "cd", town: "town", district: "district" }[tier] || "county";
    if (btier !== rtier) return { ok: false, why: `no ${rtier} baseline` };
    const counted = Object.values(store.results(raceId).statewide
      ? store.results(raceId).statewide.votes || {} : {}).reduce((a, b) => a + (Number(b) || 0), 0);
    if (data.final && counted > 0) return { ok: false, why: "certified" };
    return { ok: true };
  }

  function rows() {
    const ctx = context();
    const { focus, raceId, baselineKey } = ctx;
    if (!focus) return null;
    const race = raceId ? store.race(raceId) : null;
    const data = raceId ? store.results(raceId) : null;
    // What is drawn when there is no race: the map's subject, which is the
    // House baseline in the House mode and a presidential one otherwise.
    const drawn = ctx.subject || baselineKey;

    // With a race loaded the rows come from the results file, so units with
    // no geography (an absentee batch, a house district) are listed too.
    // Without one, the rows are the state's geography over the baseline.
    const src = data
      ? data.units
      : (ctx.units || []).map((f) => ({
          id: f.properties.id,
          name: f.properties.name,
          votes: (store.baselineUnit(drawn, f.properties.id) || {}).votes,
        }));
    const est = outstandingFor(ctx, data);

    const out = [];
    for (const u of src) {
      const totals = store.partyTotals(u.votes || {}, race);
      // The two leading contenders, as the map colors them: King against
      // Kouzounas in Maine, not Kouzounas against Costello.
      const top = store.topTwo(u.votes || {}, race);
      const lp = top && top.leader.party;
      out.push({
        id: u.id,
        name: u.name || u.id || "—",
        mapped: u.id != null,
        dem: totals.dem,
        rep: totals.rep,
        total: store.totalVotes(totals),
        margin: top ? (lp === "rep" ? -top.pts : top.pts) : null,
        lead: !top ? null : lp === "dem" || lp === "rep" ? lp : "ind",
        swing: raceId && u.id != null
          ? store.swingPts(raceId, u.id, baselineKey) : null,
        reporting: data ? store.reportingPct(u, data) : null,
        outstanding: null,
        override: !!u.override,
      });
      const row = out[out.length - 1];
      if (est.ok && u.id != null) {
        const was = store.baselineUnit(baselineKey, u.id);
        if (was) {
          const base = store.totalVotes(store.partyTotals(was.votes, store.race(baselineKey)));
          row.outstanding = Math.max(0, base - row.total);
        }
      }
    }
    return out;
  }

  function sorted(list) {
    const dir = sortDir;
    return [...list].sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      if (x == null && y == null) return 0;
      if (x == null) return 1;                 // nulls last, either direction
      if (y == null) return -1;
      if (typeof x === "string") return dir * x.localeCompare(y);
      return dir * (x - y);
    });
  }

  const modeSeg = () => `<div class="seg" role="group" aria-label="Table" style="margin:0 0 8px">${
    [["units", "Units"], ["districts", "Districts"]].map(([k, l]) =>
      `<button data-mode="${k}" aria-pressed="${k === mode}">${l}</button>`).join("")}</div>`;

  function bindMode() {
    for (const b of el.querySelectorAll("[data-mode]")) {
      b.addEventListener("click", () => {
        mode = b.dataset.mode;
        try { localStorage.setItem("mw.table.mode", mode); } catch (_) { /* private window */ }
        render();
      });
    }
  }

  function render() {
    if (mode === "districts") { renderDistricts(); return; }
    const { focus, raceId, baselineKey, tier } = context();
    if (!focus) {
      el.innerHTML = `${modeSeg()}<p class="hint">Go into a state to see its ${"units"} listed,
        or choose Districts for every seat of a chamber.</p>`;
      bindMode();
      return;
    }
    const all = rows() || [];
    const list = all.filter(keep);
    const ctx = context();
    const est = outstandingFor(ctx, raceId ? store.results(raceId) : null);
    const label = raceId
      ? `${(store.race(raceId) || {}).office || raceId} — ${focus}`
      : `${store.baselineLabel(context().subject || baselineKey)} — ${focus}`;

    // The summary is of the whole state, not of the filtered rows: "1.2M
    // counted" must not shrink because the filter hid the finished counties.
    const counted = all.reduce((n, r) => n + (r.total || 0), 0);
    const reporting = all.filter((r) => r.reporting === 100).length;
    const partial = all.filter((r) => matches(r, "counting")).length;
    const unmapped = all.filter((r) => !r.mapped).length;
    const left = est.ok ? all.reduce((n, r) => n + (r.outstanding || 0), 0) : null;
    const data = raceId ? store.results(raceId) : null;
    const asOf = data && data.updated
      ? ` &middot; ${data.override === "race"
          ? `<strong>OVERRIDE</strong> from ${(data.source && data.source.source) || "manual"}, as of`
          : "as of"} ${new Date(data.updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${
          data.override === "units"
            ? ` &middot; <strong>${data.override_units} overridden</strong> by hand (${data.override_source.source})` : ""}${
          data.source && FALLBACKS[data.source.provider] && data.override !== "race"
            ? ` &middot; source: ${FALLBACKS[data.source.provider]} (fallback)` : ""}`
      : "";

    const head = COLUMNS.map((c) =>
      `<th data-key="${c.key}"${c.title ? ` title="${c.title}"` : ""} class="${c.align === "left" ? "l" : ""}${
        sortKey === c.key ? " sorted" : ""}">${c.label}${
        sortKey === c.key ? (sortDir < 0 ? " ▼" : " ▲") : ""}</th>`).join("");

    const body = sorted(list).map((r) => `
      <tr${r.mapped ? "" : ' class="unmapped"'}>
        <td class="l">${r.name}${r.mapped ? "" : ' <span class="flag">no geography</span>'}${
          r.override ? ' <span class="flag">override</span>' : ""}</td>
        <td>${num(r.dem)}</td>
        <td>${num(r.rep)}</td>
        <td>${num(r.total)}</td>
        <td class="${r.margin == null ? "" : r.lead === "ind" ? "i" : r.margin >= 0 ? "d" : "r"}">${marginText(r)}</td>
        <td class="${r.swing == null ? "" : r.swing >= 0 ? "d" : "r"}">${pts(r.swing)}</td>
        <td>${r.reporting == null ? "—" : d3.format(".0f")(r.reporting) + "%"}</td>
        <td>${r.outstanding == null ? "—" : "~" + num(r.outstanding)}</td>
      </tr>`).join("");

    const seg = `<div class="seg" role="group" aria-label="Show rows" style="margin:0 0 8px">${
      FILTERS.map((f) => `<button data-filter="${f.key}" aria-pressed="${f.key === filter}">${f.label}${
        f.key === "all" ? "" : ` (${all.filter((r) => matches(r, f.key)).length})`}</button>`).join("")}</div>`;
    const estNote = est.ok
      ? ` &middot; est. ~${num(left)} left if turnout matches ${store.baselineLabel(baselineKey)}`
      : ` &middot; outstanding: n/a (${est.why})`;

    el.innerHTML = `
      <div class="tablehead">
        ${modeSeg()}
        <h2>${label}</h2>
        <p class="hint">${list.length === all.length ? list.length : `${list.length} of ${all.length}`} ${{ town: "towns", district: "districts", cd: "districts" }[tier] || "counties"} &middot;
          ${num(counted)} votes counted${
            reporting || partial ? ` &middot; ${reporting} complete, ${partial} partial` : ""
          }${unmapped ? ` &middot; ${unmapped} with no geography` : ""}${raceId ? estNote : ""}${asOf}</p>
        ${raceId ? seg : ""}
      </div>
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

    bindMode();
    for (const b of el.querySelectorAll("[data-filter]")) {
      b.addEventListener("click", () => { filter = b.dataset.filter; render(); });
    }
    for (const th of el.querySelectorAll("th")) {
      th.addEventListener("click", () => {
        const k = th.dataset.key;
        if (k === sortKey) sortDir = -sortDir;
        else { sortKey = k; sortDir = k === "name" ? 1 : -1; }
        render();
      });
    }
  }

  /* ------------------------------------------------------ districts */

  function loadDistrictMods() {
    if (dist.mods || dist.loading) return;
    dist.loading = Promise.all([import("../data/ratings.js"), import("../data/district_pres.js"),
                                import("../data/seats.js")])
      .then(([ratings, pres, seatMod]) => { dist.mods = { ratings, pres, seatMod }; })
      .catch((e) => { dist.error = e.message; console.error("table districts:", e); })
      .finally(() => { dist.loading = null; if (mode === "districts") render(); });
  }

  /** Two-party margin in points, Dem positive, from [dem, rep]. */
  const twoParty = (v) => (v && v[0] + v[1] > 0 ? (100 * (v[0] - v[1])) / (v[0] + v[1]) : null);

  function districtRows(api, chamber) {
    const { ratings, pres, seatMod } = dist.mods;
    const leg = seatMod.LEG_CHAMBERS.includes(chamber);
    const statewide = chamber === "senate" || chamber === "governor";
    return api.seats(chamber).map((s) => {
      // A House seat is keyed by its label (AL-03), a legislative one by its
      // unit (PA-S33); a statewide seat takes its state's 2024 result.
      const p = statewide ? api.pres2024(s.state) : null;
      const margin = statewide ? (p ? p.margin : null)
        : twoParty(pres.DISTRICT_PRES_2024[leg ? s.unitId : s.label]);
      const label = ratings.legLabel(s) || ratings.ratingFor(s);
      const n = parseInt(s.district, 10);
      return {
        seat: s,
        name: statewide ? `${s.label}${s.special ? " (special)" : ""}` : leg ? `${s.label.replace(/^\S+ \S+ /, "")}` : s.label,
        // District order: state, then number (at-large first), an unexpired
        // term after its district's regular seat.
        order: [s.state, Number.isFinite(n) ? n : 0, s.special ? 1 : 0],
        held: s.held, incumbent: s.incumbent || null,
        margin, rating: label || null, rank: ratingRank(label),
        source: label ? ratings.ratingSource(s) : null,
      };
    });
  }

  function sortDistricts(list) {
    const dir = dist.sortDir;
    const val = { district: (r) => r.order, pres: (r) => r.margin, rating: (r) => r.rank }[dist.sortKey];
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;                 // unrated / no margin last, either direction
      if (y == null) return -1;
      if (Array.isArray(x)) {
        for (let i = 0; i < x.length; i++) {
          const c = typeof x[i] === "string" ? x[i].localeCompare(y[i]) : x[i] - y[i];
          if (c) return dir * c;
        }
        return 0;
      }
      return dir * (x - y) || a.order[0].localeCompare(b.order[0]) || a.order[1] - b.order[1];
    });
  }

  function renderDistricts() {
    const api = seatsOf();
    if (!dist.mods && !dist.error) loadDistrictMods();
    if (dist.error || !api || !dist.mods) {
      el.innerHTML = `${modeSeg()}<p class="hint">${dist.error
        ? `District list not available: ${dist.error}` : "Loading the seat list…"}</p>`;
      bindMode();
      return;
    }
    const { seatMod } = dist.mods;
    const chambers = seatMod.ALL_CHAMBERS.filter((c) => api.seats(c).length);
    if (!chambers.includes(dist.chamber)) dist.chamber = chambers[0] || "house";
    const order = ["house", "senate", "governor", ...seatMod.LEG_CHAMBERS];
    chambers.sort((a, b) => order.indexOf(a) - order.indexOf(b));

    const { focus } = context();
    let all = districtRows(api, dist.chamber);
    // The House is 435 seats: a state the map is in narrows it by default.
    const multiState = new Set(all.map((r) => r.seat.state)).size > 1;
    const scope = multiState && dist.scope !== "all" && focus && all.some((r) => r.seat.state === focus) ? focus : null;
    const list = scope ? all.filter((r) => r.seat.state === scope) : all;

    const pts = (v) => (v == null ? "—" : `${v >= 0 ? "D+" : "R+"}${d3.format(".1f")(Math.abs(v))}`);
    const cls = (p) => (p === "dem" ? "d" : p === "rep" ? "r" : "");
    const rcls = (r) => (r.rank == null || r.rank === 6 ? "" : r.rank < 6 ? "d" : "r");
    const COLS = [
      // Row number: 1 to N down the list whatever the sort, so "the 218th
      // seat" can be read straight off a list sorted by margin or rating.
      { key: null, label: "#", title: "Position in the list as sorted (1 to N); not a sort of its own." },
      { key: "district", label: CHAMBER_LABEL(dist.chamber), align: "left" },
      { key: null, label: "Held by", align: "left" },
      { key: "pres", label: "2024 Pres.", title: dist.chamber === "senate" || dist.chamber === "governor"
        ? "The state's 2024 presidential result, two-party margin."
        : "2024 presidential two-party margin in the 2026 district, from Dave's Redistricting App (data/district_pres.js). West Virginia's legislative districts: estimated from The New York Times's precinct results; other states' legislative districts have none." },
      { key: "rating", label: "Rating", title: "Ordered Solid D … Toss-up … Solid R; unrated seats last." },
    ];
    const head = COLS.map((c) => `<th${c.key ? ` data-dkey="${c.key}"` : ' style="cursor:default"'}${
      c.title ? ` title="${c.title}"` : ""} class="${c.align === "left" ? "l" : ""}${
      dist.sortKey === c.key ? " sorted" : ""}">${c.label}${
      dist.sortKey === c.key ? (dist.sortDir < 0 ? " ▼" : " ▲") : ""}</th>`).join("");
    const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const body = sortDistricts(list).map((r, i) => `
      <tr>
        <td class="rownum">${i + 1}</td>
        <td class="l">${esc(r.name)}</td>
        <td class="l ${cls(r.held)}">${r.held ? (r.held === "dem" ? "D" : r.held === "rep" ? "R" : "Other") : "—"}${
          r.incumbent ? ` <span style="font-weight:400;color:var(--ink-soft)">${esc(r.incumbent)}</span>` : ""}</td>
        <td class="${r.margin == null ? "" : r.margin >= 0 ? "d" : "r"}">${pts(r.margin)}</td>
        <td class="${rcls(r)}">${r.rating ? `${esc(r.rating)} <span style="font-weight:400;color:var(--ink-soft);font-size:0.786rem">${esc(r.source)}</span>` : "—"}</td>
      </tr>`).join("");

    const rated = list.filter((r) => r.rating).length;
    const withPres = list.filter((r) => r.margin != null).length;
    const chamberSeg = `<div class="seg" role="group" aria-label="Chamber" style="margin:0 0 8px">${
      chambers.map((c) => `<button data-chamber="${c}" aria-pressed="${c === dist.chamber}">${
        esc(seatMod.CHAMBER_TITLES[c] || c)}</button>`).join("")}</div>`;
    const scopeSeg = multiState && focus && all.some((r) => r.seat.state === focus)
      ? `<div class="seg" role="group" aria-label="States" style="margin:0 0 8px">${
          [[focus, focus], ["all", "All states"]].map(([k, l]) =>
            `<button data-scope="${k}" aria-pressed="${(k === "all") === !scope}">${l}</button>`).join("")}</div>`
      : "";
    el.innerHTML = `
      <div class="tablehead">
        ${modeSeg()}
        ${chamberSeg}
        ${scopeSeg}
        <h2>${esc(seatMod.CHAMBER_TITLES[dist.chamber] || dist.chamber)}${scope ? ` — ${scope}` : ""}</h2>
        <p class="hint">${list.length} seats on the 2026 ballot &middot; ${rated} rated &middot; ${withPres} with a 2024 presidential margin${
          dist.chamber === "senate" || dist.chamber === "governor" ? " (statewide)"
            : dist.chamber === "house" ? " (Dave's Redistricting App)"
            : dist.chamber.startsWith("wv-") ? " (estimated from NYT precinct results)" : ""}.
          Click a column to sort.</p>
      </div>
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

    bindMode();
    for (const b of el.querySelectorAll("[data-chamber]")) {
      b.addEventListener("click", () => { dist.chamber = b.dataset.chamber; render(); });
    }
    for (const b of el.querySelectorAll("[data-scope]")) {
      b.addEventListener("click", () => { dist.scope = b.dataset.scope === "all" ? "all" : null; render(); });
    }
    for (const th of el.querySelectorAll("th[data-dkey]")) {
      th.addEventListener("click", () => {
        const k = th.dataset.dkey;
        if (k === dist.sortKey) dist.sortDir = -dist.sortDir;
        else { dist.sortKey = k; dist.sortDir = k === "pres" ? -1 : 1; }
        render();
      });
    }
  }

  const CHAMBER_LABEL = (c) => (c === "senate" || c === "governor" ? "State" : "District");

  /* A unit with no votes in it has not started, whatever its reporting
   * field says; one at 100% is complete; anything else with votes is still
   * counting, including a file that does not say how far along it is. */
  function matches(r, key) {
    if (key === "all") return true;
    const started = (r.total || 0) > 0 || (r.reporting != null && r.reporting > 0);
    if (key === "none") return !started;
    if (key === "complete") return r.reporting === 100;
    if (key === "counting") return started && r.reporting !== 100;
    return true;
  }

  function keep(r) {
    // Filtering by reporting needs a count to filter; a baseline-only table
    // shows everything.
    return !context().raceId || matches(r, filter);
  }

  return {
    render,
    /** Reporting filter: one of FILTERS' keys. */
    setFilter(key) {
      if (!FILTERS.some((f) => f.key === key)) return;
      filter = key;
      render();
    },
    status() { return { filter, filters: FILTERS, sortKey, sortDir, mode,
                        districts: { chamber: dist.chamber, sortKey: dist.sortKey, sortDir: dist.sortDir } }; },
  };
}
