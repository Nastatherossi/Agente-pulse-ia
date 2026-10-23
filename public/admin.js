/* Pulse · central de gestão. Só melhora a página: sem este arquivo, tudo funciona por links e formulários. */
(function () {
  var root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('js');
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* armazenamento indisponível */ } },
  };
  if (store.get('pulse-admin-side') === 'min') root.classList.add('side-collapsed');

  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }

  ready(function () {
    /* ---- menu recolhível */
    var collapse = document.querySelector('[data-collapse]');
    function syncCollapse() {
      if (!collapse) return;
      var min = root.classList.contains('side-collapsed');
      collapse.setAttribute('aria-expanded', String(!min));
      collapse.setAttribute('aria-label', min ? 'Expandir menu' : 'Recolher menu');
    }
    syncCollapse();
    if (collapse) collapse.addEventListener('click', function () {
      root.classList.toggle('side-collapsed');
      store.set('pulse-admin-side', root.classList.contains('side-collapsed') ? 'min' : 'full');
      syncCollapse();
    });
    document.querySelectorAll('.side .nav-link').forEach(function (a) {
      var label = a.querySelector('.label');
      if (label) a.setAttribute('title', label.textContent);
    });

    /* ---- tooltip único */
    var tip = document.getElementById('tip');
    function showTip(text, x, y) {
      if (!tip || !text) return;
      var lines = text.split('\n');
      tip.textContent = '';
      var b = document.createElement('b');
      b.textContent = lines.shift();
      tip.appendChild(b);
      tip.appendChild(document.createTextNode(lines.join('\n')));
      tip.hidden = false;
      var w = tip.offsetWidth, h = tip.offsetHeight, vw = window.innerWidth;
      var left = Math.min(Math.max(8, x - w / 2), vw - w - 8);
      var top = y - h - 12;
      if (top < 8) top = y + 18;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }
    function hideTip() { if (tip) tip.hidden = true; }
    function anchor(el) { var r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top]; }

    document.querySelectorAll('.info[data-tip]').forEach(function (el) {
      var show = function () { var a = anchor(el); showTip(el.getAttribute('data-tip'), a[0], a[1]); };
      el.addEventListener('mouseenter', show);
      el.addEventListener('focus', show);
      el.addEventListener('click', show);
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('blur', hideTip);
    });

    /* ---- gráficos: passar o mouse ou usar as setas */
    document.querySelectorAll('[data-chart]').forEach(function (chart) {
      var cols = Array.prototype.slice.call(chart.querySelectorAll('.col'));
      var plot = chart.querySelector('.plot');
      var active = -1;
      function mark(i, viaKey) {
        cols.forEach(function (c, j) { c.classList.toggle('on', j === i); });
        active = i;
        if (i < 0) return hideTip();
        var r = cols[i].getBoundingClientRect(), p = plot.getBoundingClientRect();
        showTip(cols[i].getAttribute('data-tip'), r.left + r.width / 2, viaKey ? p.top : p.top + 8);
      }
      cols.forEach(function (c, i) {
        c.addEventListener('mouseenter', function () { mark(i); });
      });
      plot.addEventListener('mouseleave', function () { mark(-1); });
      chart.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          var n = e.key === 'Home' ? 0 : e.key === 'End' ? cols.length - 1 : active < 0 ? cols.length - 1 : active + (e.key === 'ArrowRight' ? 1 : -1);
          mark(Math.max(0, Math.min(cols.length - 1, n)), true);
        } else if (e.key === 'Escape') mark(-1);
      });
      chart.addEventListener('blur', function () { mark(-1); });
    });
    window.addEventListener('scroll', hideTip, { passive: true });

    /* ---- botões em carregamento */
    function busy(form) {
      var btn = form.querySelector('button[type=submit]');
      if (!btn) return;
      btn.setAttribute('aria-busy', 'true');
      var label = form.getAttribute('data-busy');
      if (label) btn.textContent = label;
    }
    document.querySelectorAll('form[data-busy]:not([data-confirm])').forEach(function (form) {
      form.addEventListener('submit', function () { busy(form); });
    });

    /* ---- confirmação de ações de impacto */
    var dlg = document.getElementById('confirm');
    var canDialog = dlg && typeof dlg.showModal === 'function';
    document.querySelectorAll('form[data-confirm]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        if (form.dataset.confirmed === '1') return;
        e.preventDefault();
        var title = form.getAttribute('data-confirm-title'), text = form.getAttribute('data-confirm');
        if (!canDialog) {
          if (window.confirm(title + '\n\n' + text)) { form.dataset.confirmed = '1'; busy(form); form.submit(); }
          return;
        }
        var danger = form.getAttribute('data-tone') === 'danger';
        dlg.querySelector('[data-confirm-title]').textContent = title;
        dlg.querySelector('[data-confirm-text]').textContent = text;
        var ok = dlg.querySelector('[data-confirm-ok]');
        ok.textContent = form.getAttribute('data-confirm-ok');
        ok.className = 'btn ' + (danger ? 'danger' : 'primary');
        var ico = dlg.querySelector('[data-confirm-ico]');
        ico.className = 'confirm-ico' + (danger ? ' danger' : '');
        var trigger = form.querySelector('button[type=submit]');
        ico.innerHTML = trigger && trigger.querySelector('svg') ? trigger.querySelector('svg').outerHTML : (danger ? '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>' : '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>');
        dlg.returnValue = '';
        dlg.showModal();
        dlg.addEventListener('close', function onClose() {
          dlg.removeEventListener('close', onClose);
          if (dlg.returnValue === 'ok') { form.dataset.confirmed = '1'; busy(form); form.submit(); }
          else if (trigger) trigger.focus();
        });
      });
    });

    /* ---- usuários: busca, filtro e ordenação sobre os dados já carregados */
    var table = document.querySelector('[data-table]');
    if (table) {
      var tbody = table.tBodies[0];
      var rows = Array.prototype.slice.call(tbody.rows);
      var search = document.querySelector('[data-search]');
      var empty = document.querySelector('[data-noresults]');
      var filter = 'all';
      function apply() {
        var q = (search && search.value || '').trim().toLowerCase().replace(/[\s()+-]/g, '');
        var shown = 0;
        rows.forEach(function (r) {
          var hay = (r.getAttribute('data-name') || '').replace(/[\s()+-]/g, '');
          var okQ = !q || hay.indexOf(q) >= 0;
          var okF = filter === 'all' || (filter === 'err' ? r.getAttribute('data-err') === '1' : r.getAttribute('data-status') === filter);
          r.hidden = !(okQ && okF);
          if (!r.hidden) shown++;
        });
        if (empty) empty.hidden = shown > 0;
      }
      if (search) search.addEventListener('input', apply);
      document.querySelectorAll('[data-filter]').forEach(function (b) {
        b.addEventListener('click', function () {
          filter = b.getAttribute('data-filter');
          document.querySelectorAll('[data-filter]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          apply();
        });
      });
      table.querySelectorAll('[data-sort]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var th = btn.closest('th'), key = btn.getAttribute('data-sort'), num = btn.hasAttribute('data-num');
          var dir = th.getAttribute('aria-sort') === (num ? 'descending' : 'ascending') ? (num ? 'ascending' : 'descending') : (num ? 'descending' : 'ascending');
          table.querySelectorAll('th[aria-sort]').forEach(function (x) { x.setAttribute('aria-sort', 'none'); });
          th.setAttribute('aria-sort', dir);
          var sign = dir === 'ascending' ? 1 : -1;
          rows.sort(function (a, b) {
            var va = a.getAttribute('data-s-' + key), vb = b.getAttribute('data-s-' + key);
            return sign * (num ? Number(va) - Number(vb) : va.localeCompare(vb, 'pt-BR'));
          });
          rows.forEach(function (r) { tbody.appendChild(r); });
        });
      });
    }

    /* ---- problemas: filtro por tipo */
    var kinds = document.querySelectorAll('[data-kind-filter]');
    if (kinds.length) {
      var none = document.querySelector('[data-noresults]');
      kinds.forEach(function (b) {
        b.addEventListener('click', function () {
          var k = b.getAttribute('data-kind-filter');
          kinds.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          var total = 0;
          document.querySelectorAll('[data-group]').forEach(function (g) {
            var n = 0;
            g.querySelectorAll('.incident').forEach(function (inc) {
              var on = k === 'all' || inc.getAttribute('data-kind') === k;
              inc.hidden = !on;
              if (on) n++;
            });
            g.hidden = n === 0;
            total += n;
          });
          if (none) none.hidden = total > 0;
        });
      });
    }
  });
})();
