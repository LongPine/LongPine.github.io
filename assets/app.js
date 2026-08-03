/* ~/notes — shared interactions v3 */
(function () {
  'use strict';

  var root = document.documentElement;
  var body = document.body;

  function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        fallbackCopy(text); done();
      });
    } else {
      fallbackCopy(text); done();
    }
  }

  function fallbackCopy(text) {
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    body.appendChild(textarea);
    textarea.select();
    try { document.execCommand('copy'); } catch (error) {}
    textarea.remove();
  }

  /* Theme switcher */
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('notes-theme'); } catch (error) {}
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var initialTheme = savedTheme || (prefersDark ? 'dark' : 'light');
  root.setAttribute('data-theme', initialTheme);

  var topRight = document.querySelector('.top-right');
  var writeLink = document.querySelector('.btn-sub');
  if (writeLink) {
    writeLink.href = 'admin.html';
    writeLink.textContent = '写作台';
    writeLink.title = '进入网页写作台';
  }
  if (topRight) {
    var themeToggle = document.createElement('button');
    themeToggle.type = 'button';
    themeToggle.className = 'theme-toggle';
    themeToggle.setAttribute('aria-label', initialTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
    themeToggle.title = themeToggle.getAttribute('aria-label');
    themeToggle.textContent = initialTheme === 'dark' ? '☀' : '◐';
    topRight.insertBefore(themeToggle, writeLink || topRight.querySelector('.nav-toggle'));
    themeToggle.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      themeToggle.textContent = next === 'dark' ? '☀' : '◐';
      themeToggle.setAttribute('aria-label', next === 'dark' ? '切换到浅色模式' : '切换到深色模式');
      themeToggle.title = themeToggle.getAttribute('aria-label');
      try { localStorage.setItem('notes-theme', next); } catch (error) {}
    });
  }

  /* Search: instant filtering on home, redirect elsewhere */
  var searchInput = document.querySelector('.search input');
  if (searchInput) {
    var posts = Array.prototype.slice.call(document.querySelectorAll('.post'));
    var hint = document.querySelector('.search-hint');
    var noResults = document.querySelector('.no-results');

    function doSearch(query) {
      var q = (query || '').trim().toLowerCase();
      var shown = 0;
      posts.forEach(function (post) {
        var hit = !q || (post.textContent || '').toLowerCase().indexOf(q) !== -1;
        post.style.display = hit ? '' : 'none';
        if (hit) shown += 1;
      });
      if (noResults) noResults.style.display = q && shown === 0 ? 'block' : 'none';
      if (hint) {
        hint.style.display = q ? 'block' : 'none';
        hint.innerHTML = q
          ? '检索到 <b>' + shown + '</b> 篇与「' + escapeHtml(q) + '」相关的记录 <span class="clear" id="search-clear">清除</span>'
          : '';
        var clear = document.getElementById('search-clear');
        if (clear) clear.addEventListener('click', function () {
          searchInput.value = '';
          doSearch('');
          searchInput.focus();
        });
      }
    }

    searchInput.addEventListener('input', function () {
      if (posts.length) doSearch(this.value);
    });
    searchInput.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { this.value = ''; doSearch(''); this.blur(); }
      if (event.key === 'Enter' && posts.length === 0) {
        var q = this.value.trim();
        window.location.href = 'index.html' + (q ? '?q=' + encodeURIComponent(q) : '#posts');
      }
    });
    var params = new URLSearchParams(window.location.search);
    if (params.get('q') && posts.length) {
      searchInput.value = params.get('q');
      doSearch(params.get('q'));
      setTimeout(function () { document.getElementById('posts').scrollIntoView({ behavior: 'smooth' }); }, 50);
    }
    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); searchInput.focus(); searchInput.select();
      }
    });
  }

  /* Honest, working RSS subscription control */
  document.querySelectorAll('.subscribe .form').forEach(function (form) {
    var input = form.querySelector('input');
    var button = form.querySelector('button');
    if (!input || !button) return;
    var feedUrl = new URL('feed.xml', window.location.href).href;
    input.type = 'text';
    input.value = feedUrl;
    input.readOnly = true;
    input.setAttribute('aria-label', 'RSS 订阅地址');
    button.textContent = '复制 RSS';
    button.type = 'button';
    button.addEventListener('click', function () {
      copyText(feedUrl, function () {
        button.textContent = '✓ 已复制';
        setTimeout(function () { button.textContent = '复制 RSS'; }, 1600);
      });
    });
  });

  /* Code copy buttons */
  document.querySelectorAll('.code-head .copy').forEach(function (button) {
    button.addEventListener('click', function () {
      var pre = button.closest('.code-wrap') && button.closest('.code-wrap').querySelector('pre');
      if (!pre) return;
      copyText(pre.innerText, function () {
        button.textContent = '✓ 已复制';
        button.classList.add('copied');
        setTimeout(function () {
          button.textContent = '⧉ 复制';
          button.classList.remove('copied');
        }, 1600);
      });
    });
  });

  /* TOC active state */
  var toc = document.querySelector('.toc');
  var headings = document.querySelectorAll('.prose h2, .prose h3');
  if (toc && headings.length && 'IntersectionObserver' in window) {
    var tocLinks = {};
    toc.querySelectorAll('a').forEach(function (link) {
      var href = link.getAttribute('href');
      if (href && href.charAt(0) === '#') tocLinks[href] = link;
    });
    var tocObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var current = '#' + entry.target.id;
        Object.keys(tocLinks).forEach(function (key) {
          tocLinks[key].classList.toggle('active', key === current);
        });
      });
    }, { rootMargin: '-90px 0px -65% 0px', threshold: 0 });
    headings.forEach(function (heading) { tocObserver.observe(heading); });
  }

  /* Mobile navigation */
  var navToggle = document.querySelector('.nav-toggle');
  var mobileNav = document.querySelector('.mobile-nav');
  if (navToggle && mobileNav) {
    navToggle.addEventListener('click', function () {
      var open = mobileNav.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.textContent = open ? '×' : '☰';
    });
  }

  /* Reading progress */
  var progress = null;
  if (body.classList.contains('page-post')) {
    progress = document.createElement('div');
    progress.className = 'reading-progress';
    progress.setAttribute('aria-hidden', 'true');
    body.appendChild(progress);
  }

  /* Back to top and scroll state */
  var backTop = document.createElement('button');
  backTop.className = 'back-top';
  backTop.type = 'button';
  backTop.textContent = '↑';
  backTop.setAttribute('aria-label', '返回顶部');
  body.appendChild(backTop);
  var ticking = false;
  function updateScrollState() {
    backTop.classList.toggle('show', window.scrollY > 480);
    if (progress) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = (max > 0 ? Math.min(100, window.scrollY / max * 100) : 0) + '%';
    }
    ticking = false;
  }
  window.addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(updateScrollState); }
  }, { passive: true });
  updateScrollState();
  backTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  /* Calm, staggered content reveals */
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var revealItems = document.querySelectorAll('.featured, .post, .topic, .tag-section, .archive-year, .info-card, .subscribe');
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -5% 0px', threshold: .08 });
    revealItems.forEach(function (item, index) {
      item.classList.add('reveal');
      item.style.transitionDelay = Math.min(index % 4 * 55, 165) + 'ms';
      revealObserver.observe(item);
    });
  }
})();
