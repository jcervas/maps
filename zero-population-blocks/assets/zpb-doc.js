/* Page behavior, lifted out of index.html. Every block here is progressive
   enhancement: without it the page is plain pandoc output and loses only the
   sidenotes, the collapsible contents and the copy button. */

// Pandoc 2.9 adds attributes on both header and div. We remove the former (to
// be compatible with the behavior of Pandoc < 2.8).
document.addEventListener('DOMContentLoaded', function(e) {
  var hs = document.querySelectorAll("div.section[class*='level'] > :first-child");
  var i, h, a;
  for (i = 0; i < hs.length; i++) {
    h = hs[i];
    if (!/^h[1-6]$/i.test(h.tagName)) continue;  // it should be a header h1-h6
    a = h.attributes;
    while (a.length > 0) h.removeAttribute(a[0].name);
  }
});

/* ------------------------------------------------------------------
   Tufte sidenotes.

   Pandoc collects every markdown footnote (^[...]) into a numbered list
   at the foot of the document. This moves each one back to its reference
   point as a margin note, and wraps it in the label/checkbox pair that
   lets it open inline on narrow screens with no further scripting.

   Nothing changes about how footnotes are written. If this script does
   not run, the page degrades to ordinary numbered footnotes.

   It also fits out any <span class="marginnote"> — from mnote() in
   syllabus-helpers.R — with the same toggle.
   ------------------------------------------------------------------ */
(function () {
  function build(id, number, contentNodes) {
    var frag = document.createDocumentFragment();

    var label = document.createElement('label');
    label.className = 'margin-toggle ' + (number ? 'sidenote-ref' : 'marginnote-ref');
    label.setAttribute('for', id);
    label.textContent = number ? number : '⊕';   // circled plus, as Tufte does

    var toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = id;
    toggle.className = 'margin-toggle';

    var note = document.createElement('span');
    note.className = number ? 'sidenote' : 'marginnote';
    if (number) {
      var num = document.createElement('span');
      num.className = 'sidenote-number';
      num.textContent = number;
      note.appendChild(num);
    }
    contentNodes.forEach(function (n) { note.appendChild(n); });

    frag.appendChild(label);
    frag.appendChild(toggle);
    frag.appendChild(note);
    return frag;
  }

  /* A footnote body is an <li> holding one or more <p>. Unwrap a lone
     paragraph so the note sits inline in the margin; keep the markup for
     multi-paragraph notes. Drop pandoc's back-reference arrow either way. */
  function noteContent(li) {
    var src = li.cloneNode(true);
    Array.prototype.forEach.call(
      src.querySelectorAll('a.footnote-back'), function (a) { a.parentNode.removeChild(a); });
    var paras = [];
    Array.prototype.forEach.call(src.children, function (el) {
      if (el.tagName === 'P') paras.push(el);
    });
    var nodes = [];
    if (paras.length === 1 && src.children.length === 1) {
      while (paras[0].firstChild) nodes.push(paras[0].removeChild(paras[0].firstChild));
    } else {
      while (src.firstChild) nodes.push(src.removeChild(src.firstChild));
    }
    return nodes;
  }

  function sidenotes() {
    var refs = document.querySelectorAll('a.footnote-ref');
    if (!refs.length) return;
    var moved = 0;

    Array.prototype.forEach.call(refs, function (ref, i) {
      var li = document.getElementById((ref.getAttribute('href') || '').slice(1));
      if (!li) return;
      var number = (ref.textContent || String(i + 1)).trim();
      ref.parentNode.replaceChild(build('sn-' + (i + 1), number, noteContent(li)), ref);
      moved++;
    });

    /* Hide the original list only if every note actually made the move, so a
       partial failure still leaves the footnotes reachable at the bottom. */
    if (moved === refs.length) {
      Array.prototype.forEach.call(
        document.querySelectorAll('section.footnotes, div.footnotes'),
        function (el) { el.className += ' sidenoted'; });
    }
  }

  function marginnotes() {
    Array.prototype.forEach.call(
      document.querySelectorAll('span.marginnote'), function (note, i) {
        var prev = note.previousElementSibling;
        if (prev && prev.className.indexOf('margin-toggle') !== -1) return;
        var nodes = [];
        while (note.firstChild) nodes.push(note.removeChild(note.firstChild));
        note.parentNode.replaceChild(build('mn-' + (i + 1), null, nodes), note);
      });
  }

  function init() { sidenotes(); marginnotes(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ------------------------------------------------------------------
   Collapsible table of contents.

   Pandoc emits the TOC as a plain list. Wide enough for the sidebar
   layout, there is room to show it in full; on a phone it is two screens
   of links standing between the masthead and the first word of the
   syllabus. This wraps it in a <details> so it opens on a tap, and
   leaves it open where the sidebar lives.

   Nothing changes about how the TOC is written. If this script does not
   run, the panel renders exactly as pandoc emitted it.
   ------------------------------------------------------------------ */
(function () {
  var SIDEBAR = '(min-width: 1320px)';   /* keep in step with syllabus.css */

  function init() {
    var toc = document.getElementById('TOC');
    if (!toc || toc.getElementsByTagName('details').length) return;

    var details = document.createElement('details');
    var summary = document.createElement('summary');
    summary.textContent = 'Contents';
    details.appendChild(summary);
    while (toc.firstChild) details.appendChild(toc.removeChild(toc.firstChild));
    toc.appendChild(details);
    toc.className += ' toc-collapsible';

    var wide = window.matchMedia(SIDEBAR);
    details.open = wide.matches;

    /* Follow the layout on rotate or resize — but stop once the reader has
       opened or closed the panel themselves; their choice outranks ours. */
    var touched = false;
    summary.addEventListener('click', function () { touched = true; });
    function sync(e) { if (!touched) details.open = e.matches; }
    if (wide.addEventListener) wide.addEventListener('change', sync);
    else if (wide.addListener) wide.addListener(sync);   /* Safari < 14 */
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ------------------------------------------------------------------
   Static fallbacks for the JavaScript figures.

   Every d3 figure in this book draws itself into an empty <div> when the
   page loads, so a brief whose <script> tags were stripped -- by a mail
   client, almost always -- shows the prose and the tables and nothing
   where the figures were. syllabus-helpers.R therefore emits each
   figure's static twin into the HTML too, inside .dd-fallback.

   A twin is hidden when a real figure drew in the same SECTION, and only
   then. If d3 failed, or a figure threw, the section has no <svg> and the
   twin stays, so the reader still sees a chart.

   WHY THE SECTION IS THE UNIT. The obvious pairing -- a twin belongs to
   the figure written next to it -- does not hold in this corpus, and the
   chapters are not wrong to vary. voter-files writes the figure and then
   its twin; migration writes the twin and then the figure; lobbying draws
   two figures from a single toggle chunk that follows both their twins.
   Any rule based on which side the figure sits, or on pairing the Nth
   twin with the Nth figure, breaks on one of those three. The section is
   the smallest region that reliably contains a figure together with its
   twin however the chapter chose to order them.

   WHAT IT COSTS. A section holding two figures, one of which failed,
   hides both twins. That is the same blind spot the previous rule had and
   it is rare; a section is usually one figure. The alternative -- keeping
   every twin whenever any figure in the section failed -- prints a
   duplicate chart on a working page, which is the louder mistake.

   THIS REPLACES A PROXIMITY GUESS that looked four siblings each way and
   was wrong in both directions. A twin whose own figure had failed was
   hidden anyway when a neighbouring figure had drawn, leaving an empty gap
   where a chart belonged; a twin further than four siblings from its
   figure stayed on the page under the live chart, printing the figure
   twice. Both were found in August 2026 by loading every render and
   counting what was actually on the screen.

   AND IT SWEPT TOO EARLY. Two passes, at load and 400ms after, is enough
   on a fast machine and not enough on a slow one or a long page: a figure
   that draws on its own timer finished after the last sweep and kept its
   twin for good. It now watches until every twin is settled.
   ------------------------------------------------------------------ */
(function () {
  /* The section a twin lives in. Pandoc wraps every heading level in
     div.section; the body is the backstop for a figure above the first
     heading. */
  function scope(el) {
    var n = el.parentNode;
    while (n && n !== document.body) {
      if (n.classList && n.classList.contains('section')) return n;
      n = n.parentNode;
    }
    return document.body;
  }

  /* Did a real figure draw in here? An <svg> inside a twin does not count:
     the twin holds the static image, and a chapter that ever ships an SVG
     fallback would otherwise erase it. */
  function drewIn(section, twin) {
    var svgs = section.querySelectorAll('svg');
    for (var i = 0; i < svgs.length; i++) {
      if (!twin.contains(svgs[i])) return true;
    }
    return false;
  }

  function sweep() {
    var twins = document.querySelectorAll('.dd-fallback');
    if (!twins.length) return true;          /* nothing to watch, ever */
    var pending = 0;
    for (var i = 0; i < twins.length; i++) {
      if (drewIn(scope(twins[i]), twins[i])) twins[i].style.display = 'none';
      else pending++;
    }
    return pending === 0;
  }

  /* Sweep on load, then keep watching. The observer catches a figure the
     moment it appears; the interval covers a figure drawn somewhere the
     observer is not watching. Both stop as soon as every twin is settled,
     and in any case after QUIT, so a page with a permanently broken figure
     does not poll for the rest of the session. */
  var QUIT = 8000, timer = null, obs = null;

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (obs) { obs.disconnect(); obs = null; }
  }

  function run() {
    if (sweep()) return;
    if (window.MutationObserver) {
      obs = new MutationObserver(function () { if (sweep()) stop(); });
      obs.observe(document.body, { childList: true, subtree: true });
    }
    timer = setInterval(function () { if (sweep()) stop(); }, 250);
    setTimeout(stop, QUIT);
  }

  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run);
})();

/* ------------------------------------------------------------
   AI PROMPT COPY BUTTON — progressive enhancement only.
   Injects a copy button into each .ai-prompt title row. The button
   exists only if this script ran: an emailed brief (mail clients
   strip <script>) shows the title and the full prompt text, which
   the reader can still select and copy by hand. If this script does
   not run, nothing is lost.
   ------------------------------------------------------------ */
(function () {
  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
    } else { fallback(text, done); }
  }
  function fallback(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    done();
  }
  function init() {
    Array.prototype.forEach.call(
      document.querySelectorAll('.ai-prompt'), function (box) {
        var title = box.querySelector('.ai-prompt-title');
        var pre   = box.querySelector('.ai-prompt-text');
        if (!title || !pre) return;
        var btn = document.createElement('button');
        btn.className = 'ai-prompt-copy';
        btn.type = 'button';
        btn.textContent = 'copy';
        btn.addEventListener('click', function () {
          copyText(pre.textContent, function () {
            btn.textContent = 'copied';
            setTimeout(function () { btn.textContent = 'copy'; }, 1600);
          });
        });
        title.appendChild(btn);
      });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
