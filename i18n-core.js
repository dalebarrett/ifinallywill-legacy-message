// ════════════════════════════════════════════════════════════════════════
// i18n-core.js — runtime UI translation for Legacy Message™
//
// Approach: a MutationObserver watches the DOM and translates any UI text the
// app renders, using a dictionary of English → {fr,es,pt,hi}. Because only
// strings present in the dictionary are swapped, USER-WRITTEN CONTENT (letters,
// names, transcripts) is never translated — it isn't in the dictionary.
//
// Dynamic counts ("3 of 6") are handled by normalizing digit-runs to '#' and
// re-substituting the real numbers into the translated template at runtime.
//
// window.__I18N_DICT__ is prepended at build time (see build-i18n.js).
// ════════════════════════════════════════════════════════════════════════
(function () {
  var DICT = window.__I18N_DICT__ || {};
  var LANGS = { en: 'English', fr: 'Français', es: 'Español', pt: 'Português', hi: 'हिन्दी' };
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1 };

  var lang = 'en';
  try {
    lang = localStorage.getItem('lm_lang') || (navigator.language || 'en').slice(0, 2).toLowerCase();
  } catch (e) {}
  if (!LANGS[lang]) lang = 'en';

  var applying = false;

  function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function tmplKey(s) { return s.replace(/[\d,]+/g, '#'); }

  // Translate a normalized English string into the current language.
  function translate(en) {
    if (lang === 'en' || !en) return null;
    var entry = DICT[en], nums = null;
    if (!entry) {
      var tk = tmplKey(en);
      if (tk !== en && DICT[tk]) { entry = DICT[tk]; nums = en.match(/[\d,]+/g); }
    }
    if (!entry || !entry[lang]) return null;
    var tr = entry[lang];
    if (nums) { var i = 0; tr = tr.replace(/#/g, function () { return i < nums.length ? nums[i++] : '#'; }); }
    return tr;
  }

  function inSkip(node) {
    var p = node.parentNode;
    while (p && p.nodeType === 1) {
      if (SKIP_TAGS[p.tagName]) return true;
      if (p.hasAttribute && p.hasAttribute('data-no-i18n')) return true;
      p = p.parentNode;
    }
    return false;
  }

  function doTextNode(node) {
    var v = node.nodeValue;
    if (!v) return;
    var trimmed = norm(v);
    if (!trimmed || !/[A-Za-zऀ-ॿ]/.test(trimmed)) return;
    if (inSkip(node)) return;
    if (node.__lmEn === undefined) node.__lmEn = trimmed; // capture English source once
    var en = node.__lmEn;
    var lead = v.match(/^\s*/)[0], trail = v.match(/\s*$/)[0];
    if (lang === 'en') {
      if (norm(v) !== en) node.nodeValue = lead + en + trail;
      return;
    }
    var tr = translate(en);
    if (tr != null && norm(v) !== tr) node.nodeValue = lead + tr + trail;
  }

  var ATTRS = ['placeholder', 'title', 'aria-label'];
  function doElement(el) {
    if (el.hasAttribute && el.hasAttribute('data-no-i18n')) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      var key = '__lmAttr_' + a;
      if (el[key] === undefined) el[key] = norm(el.getAttribute(a));
      var en = el[key];
      if (lang === 'en') { el.setAttribute(a, en); continue; }
      var tr = translate(en);
      if (tr != null) el.setAttribute(a, tr);
    }
    // button/input value labels
    if ((el.tagName === 'BUTTON' || el.tagName === 'INPUT') && el.value && /[A-Za-z]/.test(el.value)) {
      if (el.type === 'button' || el.type === 'submit' || el.tagName === 'BUTTON') {
        if (el.__lmVal === undefined) el.__lmVal = norm(el.value);
        if (lang === 'en') el.value = el.__lmVal;
        else { var tv = translate(el.__lmVal); if (tv != null) el.value = tv; }
      }
    }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doTextNode(root); return; }
    if (root.nodeType !== 1) return;
    if (SKIP_TAGS[root.tagName]) return;
    if (root.hasAttribute && root.hasAttribute('data-no-i18n')) return;
    doElement(root);
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    var n;
    while ((n = tw.nextNode())) {
      if (n.nodeType === 3) doTextNode(n);
      else doElement(n);
    }
  }

  function fullPass() {
    applying = true;
    try { if (document.body) walk(document.body); } finally { applying = false; }
  }

  // ─── Observer: translate anything the app renders ───
  var observer = new MutationObserver(function (records) {
    if (applying) return;
    applying = true;
    try {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'childList') {
          for (var j = 0; j < r.addedNodes.length; j++) walk(r.addedNodes[j]);
        } else if (r.type === 'characterData') {
          doTextNode(r.target);
        } else if (r.type === 'attributes' && r.target.nodeType === 1) {
          doElement(r.target);
        }
      }
    } finally { applying = false; }
  });
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  } catch (e) {}

  // ─── Language switcher ───
  function buildSwitcher() {
    if (document.getElementById('lmLangSwitch')) return;
    var wrap = document.createElement('div');
    wrap.id = 'lmLangSwitch';
    wrap.setAttribute('data-no-i18n', '');
    var sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Language');
    Object.keys(LANGS).forEach(function (code) {
      var o = document.createElement('option');
      o.value = code; o.textContent = LANGS[code];
      if (code === lang) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () { setLang(sel.value); };
    var globe = document.createElement('span');
    globe.textContent = '🌐'; globe.style.cssText = 'font-size:13px;line-height:1';
    wrap.appendChild(globe); wrap.appendChild(sel);

    var top = document.querySelector('.top');
    if (top) { wrap.className = 'lm-lang-inline'; top.appendChild(wrap); }
    else { wrap.className = 'lm-lang-fixed'; document.body.appendChild(wrap); }
  }

  function setLang(code) {
    if (!LANGS[code]) return;
    lang = code;
    try { localStorage.setItem('lm_lang', code); } catch (e) {}
    document.documentElement.lang = code;
    fullPass();
  }
  window.LM_setLang = setLang;
  window.LM_lang = function () { return lang; };

  function injectStyle() {
    if (document.getElementById('lmLangStyle')) return;
    var s = document.createElement('style');
    s.id = 'lmLangStyle';
    s.textContent =
      '#lmLangSwitch{display:inline-flex;align-items:center;gap:5px}' +
      '#lmLangSwitch select{font:inherit;font-size:12px;font-weight:700;color:#0A2A4A;background:#fff;border:1px solid #CDD9E5;border-radius:8px;padding:6px 8px;cursor:pointer}' +
      '.lm-lang-inline{margin-left:12px}' +
      '.lm-lang-fixed{position:fixed;top:12px;right:12px;z-index:9999;background:#fff;border-radius:10px;padding:4px 8px;box-shadow:0 2px 12px rgba(10,42,74,.18)}';
    (document.head || document.documentElement).appendChild(s);
  }

  function init() {
    injectStyle();
    buildSwitcher();
    document.documentElement.lang = lang;
    fullPass();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
