/* Calls: where a race is called, on the wall itself (docs/schema.md §7).
 *
 * Every seat on the ballot in one list -- the same seats the boards count,
 * from data/seats.js -- with what the count says beside it and two taps to
 * call it: a party, then Confirm. A call needs who made it, so the caller is
 * picked once at the top ("Called by") and goes on every call until it is
 * changed. The time is now unless the editor says otherwise.
 *
 * Saving posts to scripts/serve.py, which checks the call, writes
 * <data>/calls.json and answers with the whole file; nothing here writes
 * anything else, and nothing here calls a race from a number -- the "now"
 * column is for the person making the call, not a suggestion.
 *
 *   const calls = createCallsApp({ el, seats, store, data, onSelect });
 *   calls.render();
 *
 * The shell mounts this only when GET /api/calls says the server can write,
 * which is only the default mode on the wall's own machine.
 */

import { STATE_NAMES } from "../data/seats.js";

const CHAMBERS = [["senate", "Senate"], ["governor", "Governor"], ["house", "House"]];
const PARTY = { dem: "Dem", rep: "Rep", ind: "Ind", lib: "Lib", grn: "Green", other: "Other" };
const LETTER = { dem: "D", rep: "R", ind: "I", lib: "L", grn: "G", other: "O" };
const CALLERS = ["AP", "NBC", "CNN", "ABC", "CBS", "Fox News", "Decision Desk HQ", "NYT"];
const PREFS = "magic-wall.calls.v1";
const CONFIRM_MS = 5000;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS)) || {}; } catch (_) { return {}; }
}
function writePrefs(p) {
  try { localStorage.setItem(PREFS, JSON.stringify({ ...readPrefs(), ...p })); } catch (_) { /* fine */ }
}

function clock(iso) {
  const d = new Date(iso);
  return Number.isNaN(+d) ? iso : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function createCallsApp({ el, seats, store, data = ".", onSelect = null }) {
  el.classList.add("mw-calls");
  const prefs = readPrefs();
  let chamber = prefs.chamber || "senate";
  let state = "";
  let show = "all";                // all | open | called
  let find = "";
  let by = prefs.by || "AP";
  let open = null;                 // seat id whose editor is open
  let draft = null;                // that editor's fields
  let confirm = null;              // { id, party | null (retract), timer }
  let busy = null;                 // seat id being saved
  let message = null;              // { text, bad }
  let dirty = false;               // a poll arrived while the editor was open

  function candidates(seat) {
    const race = store.race && (store.race(seat.raceId) || store.race(seat.id));
    return (race && race.candidates) || [];
  }

  function winnerFor(seat, party) {
    const same = candidates(seat).filter((c) => c.party === party);
    return same.length === 1 ? same[0].name : null;
  }

  function seatName(s) {
    if (s.chamber === "house") return s.district === "AL" ? `${s.state} at-large` : `${s.state}-${s.district}`;
    return `${STATE_NAMES[s.state] || s.state}${s.special ? " (special)" : ""}`;
  }

  function nowText(s) {
    if (s.call) {
      const c = s.call;
      return `<span class="called ${esc(c.party)}">Called ${LETTER[c.party] || "?"}</span>`
        + `${c.winner ? ` ${esc(c.winner)}` : ""} <span class="hint">· ${esc(c.by)}, ${esc(clock(c.at))}</span>`;
    }
    const l = s.live && s.live.leader;
    if (l) {
      const rep = s.live.reporting != null ? ` · ${Math.round(s.live.reporting)}% in` : "";
      return `<span class="lead ${esc(l.party)}">${LETTER[l.party] || "?"} leads</span> ${esc(l.name)}`
        + `<span class="hint">${l.share != null ? ` ${(l.share * 100).toFixed(1)}%` : ""}${rep}</span>`;
    }
    return `<span class="hint">${s.live && s.live.votes ? "tied" : "no votes yet"}</span>`;
  }

  function list() {
    const q = find.trim().toLowerCase();
    // By the name on screen: "Alabama" before "Alaska", where AK sorts first.
    const sorted = seats.seats(chamber).slice().sort((x, y) =>
      seatName(x).localeCompare(seatName(y), undefined, { numeric: true }));
    return sorted.filter((s) =>
      (!state || s.state === state) &&
      (show === "all" || (show === "called") === !!s.call) &&
      (!q || [s.id, s.state, STATE_NAMES[s.state], seatName(s), s.incumbent,
              ...candidates(s).map((c) => c.name)].some((v) => v && String(v).toLowerCase().includes(q))));
  }

  function partyButton(s, p) {
    const asking = confirm && confirm.id === s.id && confirm.party === p;
    const label = asking ? `Call ${LETTER[p]}?` : LETTER[p];
    return `<button class="pick ${p}${asking ? " confirm" : ""}" data-act="call" data-id="${esc(s.id)}"
      data-party="${p}" ${busy ? "disabled" : ""} title="Call for ${PARTY[p]} (${esc(by)})">${label}</button>`;
  }

  function actions(s) {
    if (s.call) {
      const asking = confirm && confirm.id === s.id && confirm.party == null;
      return `<button data-act="edit" data-id="${esc(s.id)}" ${busy ? "disabled" : ""}>Edit</button>
        <button class="retract${asking ? " confirm" : ""}" data-act="retract" data-id="${esc(s.id)}"
          ${busy ? "disabled" : ""}>${asking ? "Retract?" : "Retract"}</button>`;
    }
    return `${partyButton(s, "dem")}${partyButton(s, "rep")}
      <button data-act="edit" data-id="${esc(s.id)}" ${busy ? "disabled" : ""} title="Another party, a winner, a time">More</button>`;
  }

  function editor(s) {
    const d = draft;
    const cands = candidates(s);
    const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
    return `<tr class="editor"><td colspan="4"><div class="ed">
      <label class="field"><span>Called for</span><select data-f="party">
        ${Object.keys(PARTY).map((p) => opt(p, PARTY[p], d.party)).join("")}</select></label>
      <label class="field"><span>Winner</span><input data-f="winner" list="mw-cands-${esc(s.id)}"
        value="${esc(d.winner || "")}" placeholder="optional"><datalist id="mw-cands-${esc(s.id)}">
        ${cands.map((c) => `<option value="${esc(c.name)}">${esc(PARTY[c.party] || c.party || "")}</option>`).join("")}
        </datalist></label>
      <label class="field"${d.party === "dem" || d.party === "rep" ? " hidden" : ""}><span>Caucus</span>
        <select data-f="caucus">${opt("", "none (Other)", d.caucus || "")}${opt("dem", "Dem", d.caucus)}${opt("rep", "Rep", d.caucus)}</select></label>
      <label class="field"><span>Called by</span><input data-f="by" list="mw-callers" value="${esc(d.by)}"></label>
      <label class="field"><span>Time</span><input data-f="at" type="datetime-local" value="${esc(d.at || "")}"
        title="Blank is now"></label>
      <label class="field"><span>Note</span><input data-f="note" value="${esc(d.note || "")}" placeholder="optional"></label>
      <span class="spacer"></span>
      <button data-act="cancel">Cancel</button>
      <button class="save" data-act="save" data-id="${esc(s.id)}" ${busy ? "disabled" : ""}>Save call</button>
    </div></td></tr>`;
  }

  function render() {
    if (el.hidden) return;
    dirty = false;
    const rows = list();
    const all = seats.seats(chamber);
    const called = all.filter((s) => s.call).length;
    const states = [...new Set(all.map((s) => s.state))].sort();
    const cs = seats.calls.status();
    const scrolled = el.querySelector(".callslist") ? el.querySelector(".callslist").scrollTop : 0;
    el.innerHTML = `
      <div class="callshead">
        <h2>Calls</h2>
        <div class="hint">A call reaches the boards only from here, and only with who made it.
          Saved to <code>${esc(data === "." ? "calls.json" : `${data}/calls.json`)}</code>;
          ${cs.count} call${cs.count === 1 ? "" : "s"} in it${cs.error ? `, <b class="bad">unreadable: ${esc(cs.error)}</b>` : ""}.</div>
        <div class="callsbar">
          <div class="seg" role="group" aria-label="Chamber">${CHAMBERS.map(([k, label]) =>
            `<button data-chamber="${k}" aria-pressed="${k === chamber}">${label}</button>`).join("")}</div>
          <label class="field"><span>State</span><select data-ctl="state">
            <option value="">All</option>${states.map((s) =>
              `<option value="${s}"${s === state ? " selected" : ""}>${s}</option>`).join("")}</select></label>
          <div class="seg" role="group" aria-label="Show">${[["all", "All"], ["open", "Uncalled"], ["called", `Called ${called}`]]
            .map(([k, label]) => `<button data-show="${k}" aria-pressed="${k === show}">${label}</button>`).join("")}</div>
          <label class="field"><span>Find</span><input data-ctl="find" value="${esc(find)}" placeholder="state, name" size="12"></label>
          <label class="field by"><span>Called by</span><input data-ctl="by" list="mw-callers" value="${esc(by)}" size="12"></label>
        </div>
        <datalist id="mw-callers">${CALLERS.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
        <div class="msg${message && message.bad ? " bad" : ""}" role="status">${message ? esc(message.text) : ""}</div>
      </div>
      <div class="callslist"><table>
        <thead><tr><th class="l">Seat</th><th>Held</th><th class="l">Now</th><th class="l">Call</th></tr></thead>
        <tbody>${rows.map((s) => `
          <tr class="${s.call ? `iscalled ${esc(s.call.party)}` : ""}${busy === s.id ? " busy" : ""}" data-seat="${esc(s.id)}">
            <td class="l"><button class="link" data-act="go" data-id="${esc(s.raceId || s.id)}">${esc(seatName(s))}</button>
              ${s.incumbent ? `<div class="hint">${esc(s.incumbent)}</div>` : ""}</td>
            <td>${s.held ? `<span class="held ${esc(s.held)}">${LETTER[s.held] || "?"}</span>` : ""}</td>
            <td class="l">${nowText(s)}</td>
            <td class="l act">${actions(s)}</td>
          </tr>${open === s.id ? editor(s) : ""}`).join("")}
        </tbody></table>
        ${rows.length ? "" : `<p class="hint">No seats match.</p>`}
      </div>`;
    const lst = el.querySelector(".callslist");
    if (lst) lst.scrollTop = scrolled;
  }

  async function save(id, call) {
    busy = id;
    message = null;
    render();
    try {
      const r = await fetch("/api/calls", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, race_id: id, call }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `server said ${r.status}`);
      const s = seats.seats(chamber).find((x) => x.id === id);
      const what = s ? `${seatName(s)} ${chamber === "house" ? "" : CHAMBERS.find(([k]) => k === chamber)[1]}`.trim() : id;
      message = { text: call ? `Called ${what} for ${PARTY[call.party]} (${call.by}).` : `Retracted the call in ${what}.` };
      open = null; draft = null;
      await seats.calls.tick();       // the boards see it now, not in 30 seconds
    } catch (e) {
      message = { text: `Not saved: ${e.message}`, bad: true };
    }
    busy = null;
    render();
  }

  function seatById(id) { return seats.seats(chamber).find((s) => s.id === id); }

  function ask(id, party) {
    if (confirm) clearTimeout(confirm.timer);
    confirm = { id, party, timer: setTimeout(() => { confirm = null; render(); }, CONFIRM_MS) };
    render();
  }

  el.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b || b.disabled) return;
    if (b.dataset.chamber) { chamber = b.dataset.chamber; state = ""; writePrefs({ chamber }); open = null; render(); return; }
    if (b.dataset.show) { show = b.dataset.show; render(); return; }
    const id = b.dataset.id;
    const act = b.dataset.act;
    if (act === "go") { if (onSelect) onSelect(id); return; }
    if (act === "cancel") { open = null; draft = null; render(); return; }   // and catches up on any poll
    const s = id ? seatById(id) : null;
    if (act === "call" && s) {
      const p = b.dataset.party;
      if (!(confirm && confirm.id === id && confirm.party === p)) { ask(id, p); return; }
      clearTimeout(confirm.timer); confirm = null;
      if (!by.trim()) { message = { text: "Fill in Called by first.", bad: true }; render(); return; }
      const w = winnerFor(s, p);
      save(id, { party: p, by: by.trim(), ...(w ? { winner: w } : {}) });
      return;
    }
    if (act === "retract" && s) {
      if (!(confirm && confirm.id === id && confirm.party == null)) { ask(id, null); return; }
      clearTimeout(confirm.timer); confirm = null;
      save(id, null);
      return;
    }
    if (act === "edit" && s) {
      if (confirm) { clearTimeout(confirm.timer); confirm = null; }
      const c = s.call || {};
      open = id;
      draft = { party: c.party || "ind", winner: c.winner || "", caucus: c.caucus || "",
                by: c.by || by, at: "", note: c.note || "" };
      render();
      return;
    }
    if (act === "save" && s && draft) {
      if (!draft.by.trim()) { message = { text: "Every call needs Called by.", bad: true }; render(); return; }
      const call = { party: draft.party, by: draft.by.trim() };
      const w = draft.winner.trim() || winnerFor(s, draft.party);
      if (w) call.winner = w;
      if (draft.caucus && draft.party !== "dem" && draft.party !== "rep") call.caucus = draft.caucus;
      if (draft.at) call.at = new Date(draft.at).toISOString().replace(/\.\d{3}Z$/, "Z");
      else if (s.call && s.call.party === draft.party) call.at = s.call.at;   // an edit keeps the time of the call
      if (draft.note.trim()) call.note = draft.note.trim();
      save(id, call);
    }
  });

  el.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.dataset.f && draft) {
      draft[t.dataset.f] = t.value;
      if (t.dataset.f === "party") {
        // Caucus means something only for a winner outside the two parties.
        const cau = el.querySelector('[data-f="caucus"]');
        if (cau) cau.closest("label").hidden = t.value === "dem" || t.value === "rep";
      }
      return;
    }
    if (t.dataset.ctl === "by") { by = t.value; writePrefs({ by }); return; }
    if (t.dataset.ctl === "find") {
      find = t.value;
      const pos = t.selectionStart;
      render();
      const again = el.querySelector('[data-ctl="find"]');
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    }
  });
  el.addEventListener("change", (ev) => {
    if (ev.target.dataset.ctl === "state") { state = ev.target.value; render(); }
  });

  // A poll redraws the list, except under an open editor: that would take
  // half-typed fields away. Closing it redraws.
  seats.onChange(() => { if (!open) render(); else dirty = true; });

  return { render };
}
