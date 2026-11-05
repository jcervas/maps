/* Column sorting for the state population table (written by build_poptable.js).
 *
 * Each header becomes a button. A numeric column sorts largest first on its
 * first click, the State column A to Z; a second click reverses it. The sort
 * reads each cell's data-v, the raw number, so the formatted text is never
 * parsed back. The totals row sits in <tfoot> and stays put. Without the
 * script the table is simply in alphabetical order. */
(function () {
  var table = document.getElementById("pt-table");
  if (!table) return;
  var body = table.tBodies[0];
  var heads = table.tHead.rows[0].cells;

  function key(row, i) {
    var cell = row.cells[i];
    return cell.hasAttribute("data-v") ? +cell.getAttribute("data-v") : cell.textContent.trim();
  }

  function sort(i, dir) {
    var rows = Array.prototype.slice.call(body.rows);
    rows.sort(function (a, b) {
      var x = key(a, i), y = key(b, i);
      var c = typeof x === "number" ? x - y : x.localeCompare(y);
      // ties fall back to state name, so equal seat counts read alphabetically
      return dir * c || key(a, 0).localeCompare(key(b, 0));
    });
    rows.forEach(function (r) { body.appendChild(r); });
    for (var j = 0; j < heads.length; j++) {
      heads[j].setAttribute("aria-sort", j === i ? (dir > 0 ? "ascending" : "descending") : "none");
    }
  }

  Array.prototype.forEach.call(heads, function (th, i) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pt-sort";
    while (th.firstChild) btn.appendChild(th.firstChild);
    th.appendChild(btn);
    if (!th.hasAttribute("aria-sort")) th.setAttribute("aria-sort", "none");
    var numeric = th.classList.contains("num");
    btn.addEventListener("click", function () {
      var now = th.getAttribute("aria-sort");
      var dir = now === "none" ? (numeric ? -1 : 1) : (now === "ascending" ? -1 : 1);
      sort(i, dir);
    });
  });
})();
