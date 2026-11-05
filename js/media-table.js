/* Sortable / filterable media table. Progressive enhancement:
   the table renders and is usable without JS; this adds sort, search, and
   facet filters. Any element .mtable with data-facets="a,b" is upgraded;
   rows carry data-<facet> attributes and a th[data-sort] enables sorting. */
(function () {
  function build(container) {
    var facets = (container.getAttribute('data-facets') || '')
      .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var table = container.querySelector('.mtable__table');
    var tbody = table.querySelector('tbody');
    var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
    var search = container.querySelector('.mtable__search');
    var facetWrap = container.querySelector('.mtable__facets');
    var countEl = container.querySelector('.mtable__count');
    var active = {};
    var query = '';

    function labelFor(f) { return f.charAt(0).toUpperCase() + f.slice(1); }

    facets.forEach(function (f) {
      var vals = {};
      rows.forEach(function (r) {
        var v = r.getAttribute('data-' + f);
        if (v) { vals[v] = (vals[v] || 0) + 1; }
      });
      var keys = Object.keys(vals).sort();
      if (!keys.length) { return; }
      active[f] = '';
      var group = document.createElement('div');
      group.className = 'mtable__facet';
      var lab = document.createElement('span');
      lab.className = 'mtable__facet-label';
      lab.textContent = labelFor(f) + ':';
      group.appendChild(lab);

      if (keys.length <= 8) {
        var mk = function (val, text) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'mtable__chip' + (val === '' ? ' is-active' : '');
          b.textContent = text;
          b.addEventListener('click', function () {
            active[f] = val;
            group.querySelectorAll('.mtable__chip').forEach(function (c) { c.classList.remove('is-active'); });
            b.classList.add('is-active');
            apply();
          });
          group.appendChild(b);
        };
        mk('', 'All');
        keys.forEach(function (k) { mk(k, k + ' (' + vals[k] + ')'); });
      } else {
        var sel = document.createElement('select');
        sel.className = 'mtable__select';
        sel.setAttribute('aria-label', 'Filter by ' + labelFor(f));
        var o0 = document.createElement('option');
        o0.value = ''; o0.textContent = 'All (' + rows.length + ')';
        sel.appendChild(o0);
        keys.forEach(function (k) {
          var o = document.createElement('option');
          o.value = k; o.textContent = k + ' (' + vals[k] + ')';
          sel.appendChild(o);
        });
        sel.addEventListener('change', function () { active[f] = sel.value; apply(); });
        group.appendChild(sel);
      }
      facetWrap.appendChild(group);
    });

    if (search) {
      search.addEventListener('input', function () {
        query = search.value.toLowerCase().trim();
        apply();
      });
    }

    function apply() {
      var shown = 0;
      rows.forEach(function (r) {
        var ok = true;
        facets.forEach(function (f) {
          if (active[f] && r.getAttribute('data-' + f) !== active[f]) { ok = false; }
        });
        if (ok && query) { ok = r.textContent.toLowerCase().indexOf(query) !== -1; }
        r.style.display = ok ? '' : 'none';
        if (ok) { shown++; }
      });
      if (countEl) { countEl.textContent = 'Showing ' + shown + ' of ' + rows.length; }
    }

    var ths = Array.prototype.slice.call(table.querySelectorAll('th[data-sort]'));
    var sortState = { key: null, dir: 1 };
    ths.forEach(function (th) {
      th.classList.add('is-sortable');
      th.setAttribute('role', 'button');
      th.setAttribute('tabindex', '0');
      var doSort = function () {
        var key = th.getAttribute('data-sort');
        sortState.dir = (sortState.key === key) ? -sortState.dir : 1;
        sortState.key = key;
        var colIndex = Array.prototype.slice.call(th.parentNode.children).indexOf(th);
        rows.sort(function (a, b) {
          var av = cellVal(a, colIndex, key), bv = cellVal(b, colIndex, key);
          if (av < bv) { return -sortState.dir; }
          if (av > bv) { return sortState.dir; }
          return 0;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
        ths.forEach(function (t) { t.classList.remove('is-asc', 'is-desc'); });
        th.classList.add(sortState.dir > 0 ? 'is-asc' : 'is-desc');
      };
      th.addEventListener('click', doSort);
      th.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doSort(); }
      });
    });

    function cellVal(tr, colIndex, key) {
      var td = tr.children[colIndex];
      if (!td) { return ''; }
      if (key === 'date') { return td.getAttribute('data-date') || ''; }
      return (td.textContent || '').trim().toLowerCase();
    }

    apply();
  }

  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.slice.call(document.querySelectorAll('.mtable')).forEach(build);
  });
})();
