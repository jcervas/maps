/* ------------------------------------------------------------------
   Tufte sidenotes for kramdown pages.

   The same treatment the course syllabi get from their pandoc template,
   fitted to kramdown's markup. Kramdown collects every [^note] into a
   numbered list at the foot of the page; this moves each one back to its
   reference point as a margin note, wrapped in the label/checkbox pair
   that lets it open inline on narrow screens with no further scripting.

   Nothing changes about how footnotes are written. If this script does
   not run, the page keeps its ordinary numbered footnotes.

   Kramdown's markup:
     <sup id="fnref:x" role="doc-noteref"><a href="#fn:x" class="footnote">1</a></sup>
     <div class="footnotes"><ol><li id="fn:x"><p>... <a class="reversefootnote">↩</a></p></li></ol></div>

   Opt in per page with css/sidenotes.css and this script.
   ------------------------------------------------------------------ */
(function () {
  function build(id, number, contentNodes) {
    var frag = document.createDocumentFragment();

    var label = document.createElement('label');
    label.className = 'margin-toggle sidenote-ref';
    label.setAttribute('for', id);
    label.textContent = number;

    var toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = id;
    toggle.className = 'margin-toggle';

    var note = document.createElement('span');
    note.className = 'sidenote';
    note.setAttribute('role', 'note');
    var num = document.createElement('span');
    num.className = 'sidenote-number';
    num.textContent = number;
    note.appendChild(num);
    contentNodes.forEach(function (n) { note.appendChild(n); });

    frag.appendChild(label);
    frag.appendChild(toggle);
    frag.appendChild(note);
    return frag;
  }

  /* A footnote body is an <li> holding one or more <p>. Unwrap a lone
     paragraph so the note sits inline in the margin; keep the markup for
     multi-paragraph notes. Drop kramdown's back-reference arrow either way.
     The <li> is cloned, so a note referenced twice can be placed twice. */
  function noteContent(li) {
    var src = li.cloneNode(true);
    Array.prototype.forEach.call(
      src.querySelectorAll('a.reversefootnote'), function (a) { a.parentNode.removeChild(a); });
    var nodes = [];
    if (src.children.length === 1 && src.children[0].tagName === 'P') {
      var p = src.children[0];
      while (p.firstChild) nodes.push(p.removeChild(p.firstChild));
    } else {
      while (src.firstChild) nodes.push(src.removeChild(src.firstChild));
    }
    return nodes;
  }

  function sidenotes() {
    var refs = document.querySelectorAll('a.footnote[href^="#fn:"]');
    if (!refs.length) return;
    var moved = 0;

    Array.prototype.forEach.call(refs, function (ref, i) {
      var li = document.getElementById(decodeURIComponent(ref.getAttribute('href').slice(1)));
      if (!li) return;
      var number = ref.textContent.trim() || String(i + 1);
      // Replace the whole <sup>, so the label is not superscripted twice.
      var anchor = ref.parentNode.tagName === 'SUP' ? ref.parentNode : ref;
      anchor.parentNode.replaceChild(build('sn-' + (i + 1), number, noteContent(li)), anchor);
      moved++;
    });

    /* Hide the original list only if every note actually made the move, so a
       partial failure still leaves the footnotes reachable at the bottom. */
    if (moved === refs.length) {
      Array.prototype.forEach.call(
        document.querySelectorAll('div.footnotes'),
        function (el) { el.className += ' sidenoted'; });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sidenotes);
  } else {
    sidenotes();
  }
})();
