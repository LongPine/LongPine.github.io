/* ============================================================
   notes · 写作台逻辑 v8
   - 文章管理：列表 / 搜索 / 新建 / 编辑 / 删除
   - 状态条：模式 + 保存状态实时绑定
   - 表单：分类=原生下拉（只选）· 标签=纯选择器（只选）
   - 设置弹窗：发布设置 / 分类管理 / 标签管理（Tab，可扩展）
   - 一键发布到 GitHub（Contents API）
   ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var SETTINGS_KEY = 'notes_gh_settings';
  var DRAFT_KEY = 'notes_draft_v1';
  var CATS_KEY = 'notes_cats';

  var state = { mode: 'new', path: null, sha: null, list: [], filter: '', featured: 0 };

  /* ================ 工具 ================ */
  function getSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function b64decode(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function nowHM() {
    var d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function slugOf(d) {
    var t = (d.title || 'untitled').replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return (d.date || today()) + '-' + (t || 'untitled');
  }
  function gh(settings, path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({
      Authorization: 'token ' + settings.token,
      Accept: 'application/vnd.github+json'
    }, opts.headers || {});
    return fetch('https://api.github.com' + path, opts);
  }
  function ghError(res) {
    if (res.status === 403 || res.status === 429) return 'API 限流或 Token 权限不足（检查 repo 权限）';
    if (res.status === 401) return 'Token 无效或已过期';
    if (res.status === 404) return '文件未找到';
    return 'HTTP ' + res.status;
  }

  /* ================ 状态提示 ================ */
  var statusEl = $('status'), statusTimer = null;
  function setStatus(text, cls, html) {
    statusEl.innerHTML = html ? text : esc(text);
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
    if (statusTimer) clearTimeout(statusTimer);
    if (cls !== 'err') statusTimer = setTimeout(function () { statusEl.innerHTML = ''; statusEl.className = 'status'; }, 8000);
  }
  function setSaveState(text, cls) {
    $('save-state').className = 'save-state' + (cls ? ' ' + cls : '');
    $('save-text').textContent = text;
  }

  /* ================ Markdown 渲染 ================ */
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<figure class="preview-img"><img src="$2" alt="$1" loading="lazy"><figcaption>$1</figcaption></figure>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }
  function renderMd(md) {
    var lines = md.split('\n'), out = [], i = 0, n = lines.length;
    while (i < n) {
      var line = lines[i];
      var m = line.match(/^```(\w*)/);
      if (m) {
        var buf = []; i++;
        while (i < n && lines[i].indexOf('```') !== 0) { buf.push(lines[i]); i++; }
        i++;
        out.push('<div class="code-wrap"><div class="code-head"><span class="lang"><i class="dot"></i><i class="dot"></i><i class="dot"></i> ' +
          (m[1] || 'text') + '</span><button class="copy" type="button">⧉ 复制</button></div><pre>' + esc(buf.join('\n')) + '</pre></div>');
        continue;
      }
      m = line.match(/^(#{2,3})\s+(.*)/);
      if (m) {
        var tag = m[1].length === 2 ? 'h2' : 'h3';
        out.push('<' + tag + '>' + inline(m[2]) + '</' + tag + '>');
        i++; continue;
      }
      if (line.indexOf('>') === 0) {
        var q = [];
        while (i < n && lines[i].indexOf('>') === 0) { q.push(inline(lines[i].slice(1).trim())); i++; }
        out.push('<blockquote><p>' + q.join('<br>') + '</p></blockquote>'); continue;
      }
      if (/^[-*]\s+/.test(line)) {
        var ul = [];
        while (i < n && /^[-*]\s+/.test(lines[i])) { ul.push('<li>' + inline(lines[i].replace(/^[-*]\s+/, '')) + '</li>'); i++; }
        out.push('<ul>' + ul.join('') + '</ul>'); continue;
      }
      if (/^\d+\.\s+/.test(line)) {
        var ol = [];
        while (i < n && /^\d+\.\s+/.test(lines[i])) { ol.push('<li>' + inline(lines[i].replace(/^\d+\.\s+/, '')) + '</li>'); i++; }
        out.push('<ol>' + ol.join('') + '</ol>'); continue;
      }
      if (line.indexOf('|') !== -1 && i + 1 < n && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
        var cells = function (r) { return r.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); }); };
        var th = cells(line), i2 = i + 2, rows = [];
        while (i2 < n && lines[i2].indexOf('|') !== -1) { rows.push(cells(lines[i2])); i2++; }
        out.push('<table><thead><tr>' + th.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>');
        i = i2; continue;
      }
      if (!line.trim()) { i++; continue; }
      var p = [line]; i++;
      while (i < n && lines[i].trim() && !/^(#{2,3}\s|```|>|[-*]\s|\d+\.\s)|\|/.test(lines[i])) { p.push(lines[i]); i++; }
      out.push('<p>' + inline(p.join(' ')) + '</p>');
    }
    return out.join('\n');
  }

  /* ================ frontmatter ================ */
  function parseMd(text) {
    var m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return null;
    var meta = {}, body = m[2];
    m[1].split('\n').forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) {
        var k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim().replace(/^"|"$/g, '');
        if (k === 'tags') meta.tags = v.replace(/[\[\]"]/g, '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
        else meta[k] = v;
      }
    });
    return { meta: meta, body: body };
  }
  function makeMarkdown(d) {
    var fm = '---\ntitle: ' + d.title + '\ndate: ' + d.date + '\ncategory: ' + d.category +
      '\ntags: [' + d.tags.join(', ') + ']\nsummary: ' + d.summary + '\n';
    if (d.featured) fm += 'featured: ' + d.featured + '\n';
    fm += '---\n';
    return fm + d.body.replace(/^\n+/, '');
  }
  function collect() {
    return {
      title: $('f-title').value.trim(),
      date: $('f-date').value || today(),
      category: $('f-category').value,
      tags: $('f-tags').value.split(/[,，\s]+/).filter(Boolean),
      summary: $('f-summary').value.trim(),
      body: $('f-body').value,
      featured: parseInt($('f-featured').value, 10) || 0
    };
  }
  function fillForm(p) {
    $('f-title').value = p.title || '';
    $('f-date').value = p.date || today();
    if (p.category && [].slice.call($('f-category').options).some(function (o) { return o.value === p.category; })) $('f-category').value = p.category;
    setTags(p.tags || []);
    $('f-summary').value = p.summary || '';
    $('f-body').value = p.body || '';
  }

  /* ================ 标签（表单纯选择） ================ */
  var tagPool = [];
  var tagChips = [];
  var tagSel = $('tag-sel'), tagSelPanel = $('tag-sel-panel'), tagSelList = $('tag-sel-list');
  var TAGS_KEY = 'notes_tags';
  function loadTagPool() {
    var extra = [];
    try { extra = JSON.parse(localStorage.getItem(TAGS_KEY) || '[]'); } catch (e) {}
    extra.forEach(function (t) { if (t && tagPool.indexOf(t) === -1) tagPool.push(t); });
  }
  function syncTagsStorage() {
    localStorage.setItem(TAGS_KEY, JSON.stringify(tagPool));
  }
  function setTags(list) {
    tagChips = (list || []).slice();
    syncTagSel();
  }
  function syncTagSel() {
    var el = $('tag-sel-value');
    if (!tagChips.length) {
      el.innerHTML = '<span class="ts-ph">未选择</span>';
    } else {
      el.innerHTML = tagChips.map(function (t) {
        return '<span class="chip" data-t="' + esc(t) + '">' + esc(t) +
          '<svg class="chip-x" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></span>';
      }).join('');
      el.querySelectorAll('.chip').forEach(function (chip) {
        chip.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleTag(chip.getAttribute('data-t'));
        });
      });
    }
    $('f-tags').value = tagChips.join(', ');
  }
  function toggleTag(t) {
    var i = tagChips.indexOf(t);
    if (i === -1) tagChips.push(t); else tagChips.splice(i, 1);
    syncTagSel();
    markDirty();
  }
  function renderTagSelList() {
    if (!tagPool.length) {
      tagSelList.innerHTML = '<div class="ts-item empty">暂无标签，可在「设置 → 标签管理」添加</div>';
      return;
    }
    tagSelList.innerHTML = tagPool.map(function (t) {
      var on = tagChips.indexOf(t) !== -1;
      return '<div class="ts-item' + (on ? ' on' : '') + '" data-t="' + esc(t) + '">' +
        '<svg class="check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>' + esc(t) + '</div>';
    }).join('');
    tagSelList.querySelectorAll('.ts-item[data-t]').forEach(function (item) {
      item.addEventListener('click', function () {
        toggleTag(item.getAttribute('data-t'));
        renderTagSelList();
      });
    });
  }
  function openTagSel() {
    renderTagSelList();
    tagSelPanel.hidden = false;
    tagSel.classList.add('open');
  }
  function closeTagSel() {
    tagSelPanel.hidden = true;
    tagSel.classList.remove('open');
  }
  tagSel.addEventListener('click', function () { tagSelPanel.hidden ? openTagSel() : closeTagSel(); });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#tag-sel')) closeTagSel();
  });
  function updateTagPool() {
    tagPool = [];
    state.list.forEach(function (p) { (p.tags || []).forEach(function (t) { if (tagPool.indexOf(t) === -1) tagPool.push(t); }); });
    loadTagPool();
  }

  /* ================ 分类（原生下拉 + 持久化） ================ */
  var catSelect = $('f-category');
  function catOptions() { return [].slice.call(catSelect.options); }
  function loadCats() {
    var extra = [];
    try { extra = JSON.parse(localStorage.getItem(CATS_KEY) || '[]'); } catch (e) {}
    extra.forEach(function (c) {
      if (c && !catOptions().some(function (o) { return o.value === c; })) {
        var opt = document.createElement('option');
        opt.value = c; opt.textContent = c;
        catSelect.appendChild(opt);
      }
    });
  }
  function syncCatsStorage() {
    localStorage.setItem(CATS_KEY, JSON.stringify(catOptions().map(function (o) { return o.value; })));
  }

  /* ================ 工具栏 ================ */
  var bodyTa = $('f-body');
  function insertAtCursor(before, after, placeholder) {
    var start = bodyTa.selectionStart, end = bodyTa.selectionEnd;
    var sel = bodyTa.value.slice(start, end) || placeholder || '';
    var text = before + sel + (after || '');
    bodyTa.value = bodyTa.value.slice(0, start) + text + bodyTa.value.slice(end);
    var pos = start + before.length + (placeholder && !bodyTa.value.slice(start, end) ? 0 : sel.length);
    bodyTa.focus();
    bodyTa.setSelectionRange(pos, pos);
    markDirty();
  }
  var CMDS = {
    bold: ['**', '**', '加粗文字'],
    italic: ['*', '*', '斜体文字'],
    code: ['`', '`', 'code'],
    h2: ['## ', '', '二级标题'],
    h3: ['### ', '', '三级标题'],
    link: ['[', '](https://example.com)', '链接文字'],
    image: ['![', '](图片地址)', '图片描述'],
    quote: ['> ', '', '引用内容'],
    ul: ['- ', '', '列表项'],
    ol: ['1. ', '', '列表项'],
    table: ['\n| 列1 | 列2 |\n| --- | --- |\n| 内容 | 内容 |\n', '', ''],
    codeblock: ['\n```lang\n', '\n```\n', '代码']
  };
  $('toolbar').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-cmd]');
    if (btn && CMDS[btn.getAttribute('data-cmd')]) insertAtCursor.apply(null, CMDS[btn.getAttribute('data-cmd')]);
  });
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveDraft(); }
    if (mod && e.key.toLowerCase() === 'b' && document.activeElement === bodyTa) { e.preventDefault(); insertAtCursor.apply(null, CMDS.bold); }
    if (mod && e.key.toLowerCase() === 'k' && document.activeElement === bodyTa) { e.preventDefault(); insertAtCursor.apply(null, CMDS.link); }
    if (e.key === 'Escape') closeTagSel();
  });
  bodyTa.addEventListener('keydown', function (e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      var start = this.selectionStart;
      this.value = this.value.slice(0, start) + '    ' + this.value.slice(this.selectionEnd);
      this.setSelectionRange(start + 4, start + 4);
      markDirty();
    }
  });

  /* ================ 图片上传 ================ */
  $('f-image').addEventListener('change', function () {
    var file = this.files[0];
    this.value = '';
    if (!file) return;
    var s = getSettings();
    if (!s.owner || !s.repo || !s.token) {
      setStatus('请先在「设置」配置 GitHub', 'err');
      $('btn-settings').click();
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var base64 = reader.result.split(',')[1];
      var name = Date.now() + '-' + file.name.replace(/[^\w.\u4e00-\u9fff]+/g, '-');
      var path = 'images/' + name;
      setStatus('正在上传图片…');
      gh(s, '/repos/' + s.owner + '/' + s.repo + '/contents/' + path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '上传图片: ' + name, content: base64 })
      }).then(function (res) {
        if (!res.ok) throw new Error(ghError(res));
        insertAtCursor('\n![图片](images/' + name + ')\n', '', '');
        setStatus('图片已上传到 images/ 并插入正文', 'ok');
      }).catch(function (e) {
        setStatus('图片上传失败：' + e.message, 'err');
      });
    };
    reader.readAsDataURL(file);
  });

  /* ================ 设置弹窗：Tab + 管理 ================ */
  function showSettings(tab) {
    var s = getSettings();
    $('s-owner').value = s.owner || '';
    $('s-repo').value = s.repo || '';
    $('s-token').value = s.token || '';
    switchTab(tab || 'publish');
    if (tab === 'cats') renderMgrCats();
    if (tab === 'tags') renderMgrTags();
    if (tab === 'tl') loadTimeline();
    $('settings-mask').classList.add('show');
  }
  function switchTab(tab) {
    document.querySelectorAll('.settings-tabs button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-stab') === tab);
    });
    ['publish', 'cats', 'tags', 'tl'].forEach(function (t) {
      $('stab-' + t).hidden = t !== tab;
    });
  }
  document.querySelectorAll('.settings-tabs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var tab = btn.getAttribute('data-stab');
      switchTab(tab);
      if (tab === 'cats') renderMgrCats();
      if (tab === 'tags') renderMgrTags();
      if (tab === 'tl') loadTimeline();
    });
  });
  $('btn-settings').addEventListener('click', function () { showSettings('publish'); });
  $('conn').addEventListener('click', function () { showSettings('publish'); });
  $('btn-close').addEventListener('click', function () { $('settings-mask').classList.remove('show'); });
  $('settings-mask').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });
  $('btn-save-settings').addEventListener('click', function () {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      owner: $('s-owner').value.trim(),
      repo: $('s-repo').value.trim(),
      token: $('s-token').value.trim()
    }));
    $('settings-mask').classList.remove('show');
    setStatus('设置已保存，正在加载文章列表…');
    loadArticles();
  });

  // 分类管理
  function renderMgrCats() {
    var list = $('mgr-cat-list');
    if (!catOptions().length) {
      list.innerHTML = '<div class="mgr-empty">暂无分类，添加一个吧</div>';
      return;
    }
    list.innerHTML = catOptions().map(function (o) {
      return '<div class="mgr-item" data-v="' + esc(o.value) + '">' + esc(o.value) +
        '<span class="del" title="删除">×</span></div>';
    }).join('');
    list.querySelectorAll('.mgr-item .del').forEach(function (del) {
      del.addEventListener('click', function () {
        var v = del.closest('.mgr-item').getAttribute('data-v');
        if (!window.confirm('删除分类「' + v + '」？')) return;
        var idx = catOptions().findIndex(function (o) { return o.value === v; });
        if (idx >= 0) catSelect.remove(idx);
        if (catSelect.value === v) catSelect.selectedIndex = 0;
        syncCatsStorage();
        renderMgrCats();
      });
    });
  }
  function addCategory() {
    var input = $('mgr-cat-new');
    var v = input.value.trim();
    input.value = '';
    if (!v) return;
    if (!catOptions().some(function (o) { return o.value === v; })) {
      var opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      catSelect.appendChild(opt);
      syncCatsStorage();
    }
    renderMgrCats();
  }
  $('mgr-cat-add').addEventListener('click', addCategory);
  $('mgr-cat-new').addEventListener('keydown', function (e) { if (e.key === 'Enter') addCategory(); });

  // 标签管理
  function renderMgrTags() {
    var list = $('mgr-tag-list');
    if (!tagPool.length) {
      list.innerHTML = '<div class="mgr-empty">暂无标签，添加一个吧（可先发布带标签的文章）</div>';
      return;
    }
    list.innerHTML = tagPool.map(function (t) {
      return '<div class="mgr-item" data-t="' + esc(t) + '">' + esc(t) +
        '<span class="del" title="删除">×</span></div>';
    }).join('');
    list.querySelectorAll('.mgr-item .del').forEach(function (del) {
      del.addEventListener('click', function () {
        var t = del.closest('.mgr-item').getAttribute('data-t');
        if (!window.confirm('删除标签「' + t + '」？')) return;
        tagPool = tagPool.filter(function (x) { return x !== t; });
        tagChips = tagChips.filter(function (x) { return x !== t; });
        syncTagsStorage();
        syncTagSel();
        renderMgrTags();
      });
    });
  }
  function addTagPool() {
    var input = $('mgr-tag-new');
    var v = input.value.trim();
    input.value = '';
    if (!v) return;
    if (tagPool.indexOf(v) === -1) tagPool.push(v);
    syncTagsStorage();
    renderMgrTags();
  }
  $('mgr-tag-add').addEventListener('click', addTagPool);
  $('mgr-tag-new').addEventListener('keydown', function (e) { if (e.key === 'Enter') addTagPool(); });

  /* ================ 关于时间线管理 ================ */
  var tlItems = [];
  var TL_PATH = 'data/timeline.json';
  function loadTimeline() {
    var s = getSettings();
    if (!s.owner || !s.repo || !s.token) return;
    gh(s, '/repos/' + s.owner + '/' + s.repo + '/contents/' + TL_PATH)
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        if (d && d.content) {
          try { tlItems = JSON.parse(b64decode(d.content)); } catch (e) { tlItems = []; }
          if (!Array.isArray(tlItems)) tlItems = [];
          state.tlSha = d.sha;
        } else {
          tlItems = [];
        }
        renderTlList();
      })
      .catch(function () { tlItems = []; renderTlList(); });
  }
  function renderTlList() {
    var el = $('mgr-tl-list');
    if (!tlItems.length) {
      el.innerHTML = '<div class="mgr-empty">暂无时间线条目，添加一个吧</div>';
      return;
    }
    el.innerHTML = tlItems.map(function (it, i) {
      return '<div class="mgr-item"><b style="color:var(--blue);font-family:var(--mono);font-size:11px;width:72px;flex-shrink:0">' + esc(it.date || '') + '</b>' +
        '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>' + esc(it.title || '') + '</b>' +
        (it.desc ? '<span style="color:var(--faint);font-size:11px"> · ' + esc(it.desc) + '</span>' : '') + '</span>' +
        '<span class="del" title="删除" data-i="' + i + '">×</span></div>';
    }).join('');
    el.querySelectorAll('.del[data-i]').forEach(function (del) {
      del.addEventListener('click', function () {
        tlItems.splice(+del.getAttribute('data-i'), 1);
        renderTlList();
      });
    });
  }
  function addTimelineItem() {
    var d = $('tl-date').value.trim(), t = $('tl-title').value.trim(), de = $('tl-desc').value.trim();
    if (!d || !t) { setStatus('请填写日期和标题', 'err'); return; }
    tlItems.push({ date: d, title: t, desc: de });
    $('tl-date').value = ''; $('tl-title').value = ''; $('tl-desc').value = '';
    renderTlList();
  }
  function saveTimeline() {
    var s = getSettings();
    if (!s.owner || !s.repo || !s.token) { setStatus('请先完成「设置」配置', 'err'); showSettings('publish'); return; }
    var btn = $('tl-save'), old = btn.textContent;
    btn.disabled = true; btn.textContent = '保存中…';
    var body = { message: '更新: 关于时间线', content: b64encode(JSON.stringify(tlItems, null, 2)) };
    if (state.tlSha) body.sha = state.tlSha;
    gh(s, '/repos/' + s.owner + '/' + s.repo + '/contents/' + TL_PATH, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error(ghError(res))); })
      .then(function (d) {
        state.tlSha = d.content.sha;
        return gh(s, '/repos/' + s.owner + '/' + s.repo + '/actions/workflows/deploy.yml/dispatches', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'main' })
        });
      })
      .then(function (res) {
        setStatus(res.ok || res.status === 204 ? '时间线已保存，正在重建博客（1-2 分钟）' : '时间线已保存，但触发重建失败（可手动去 Actions 跑一次）', 'ok', true);
      })
      .catch(function (e) { setStatus('保存失败：' + e.message, 'err'); })
      .then(function () { btn.disabled = false; btn.textContent = old; });
  }
  $('tl-add').addEventListener('click', addTimelineItem);
  $('tl-title').addEventListener('keydown', function (e) { if (e.key === 'Enter') addTimelineItem(); });
  $('tl-save').addEventListener('click', saveTimeline);

  /* ================ 预览 / 字数 ================ */
  function updatePreview() {
    var body = $('f-body').value.trim();
    $('preview-desktop').innerHTML = body
      ? '<article class="prose">' + renderMd(body) + '</article>'
      : '<div class="empty"><div class="big"><svg class="ic" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg></div>输入内容后，这里实时显示效果</div>';
    countWords();
  }
  function countWords() {
    var chars = $('f-body').value.replace(/\s/g, '').length;
    var min = Math.max(1, Math.round(chars / 400));
    $('word-count').textContent = '约 ' + chars + ' 字 · ' + min + ' 分钟';
  }
  function markDirty() {
    setSaveState('未保存', 'dirty');
    updatePreview();
  }
  ['f-title', 'f-date', 'f-category', 'f-tags', 'f-summary', 'f-body'].forEach(function (id) {
    $(id).addEventListener('input', markDirty);
  });

  /* ================ 移动端 编辑/预览 ================ */
  document.querySelectorAll('.view-tabs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.view-tabs button').forEach(function (b) { b.classList.toggle('active', b === btn); });
      var isEdit = btn.getAttribute('data-view') === 'edit';
      var editCol = document.querySelector('.edit-col');
      var previewCol = document.querySelector('.preview-col');
      if (editCol) editCol.style.display = isEdit ? '' : 'none';
      if (previewCol) previewCol.style.display = isEdit ? 'none' : '';
    });
  });

  /* ================ 文章管理 ================ */
  function renderConn(s) {
    var c = $('conn');
    if (s.owner && s.repo) { c.className = 'conn on'; $('conn-text').textContent = s.owner + '/' + s.repo; }
    else { c.className = 'conn off'; $('conn-text').textContent = '未连接 GitHub'; }
  }
  async function loadArticles() {
    var s = getSettings();
    renderConn(s);
    var list = $('article-list');
    if (!s.owner || !s.repo || !s.token) {
      list.innerHTML = '<li class="list-empty"><div class="big"><svg class="ic" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></div><b>先配置 GitHub</b><p>点击右上角「未连接」完成设置</p></li>';
      return;
    }
    list.innerHTML = '<li class="list-loading">正在读取文章…</li>';
    try {
      var res = await gh(s, '/repos/' + s.owner + '/' + s.repo + '/contents/posts');
      if (res.status === 404) { state.list = []; renderFiltered(); return; }
      if (!res.ok) throw new Error(ghError(res));
      var files = await res.json();
      state.list = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (!f.name.endsWith('.md')) continue;
        var item = { name: f.name, path: f.path, sha: f.sha, title: f.name, date: '', category: '', tags: [] };
        try {
          var parsed = parseMd(f.content ? b64decode(f.content) : '');
          if (parsed) {
            item.title = parsed.meta.title || f.name;
            item.date = parsed.meta.date || '';
            item.category = parsed.meta.category || '';
            item.tags = parsed.meta.tags || [];
            item.featured = parseInt(parsed.meta.featured || '0', 10) || 0;
          }
        } catch (e) {}
        state.list.push(item);
      }
      state.list.sort(function (a, b) { return b.date < a.date ? -1 : b.date > a.date ? 1 : 0; });
      updateTagPool();
      renderFiltered();
    } catch (e) {
      list.innerHTML = '<div class="list-empty"><div class="big"><svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg></div><b>拉取失败</b><p>' + esc(e.message) + '</p></div>';
    }
  }
  function renderFiltered() {
    $('list-count').textContent = state.list.length;
    var kw = state.filter.toLowerCase();
    var items = state.list.filter(function (p) { return !kw || p.title.toLowerCase().indexOf(kw) !== -1 || (p.tags || []).join(' ').toLowerCase().indexOf(kw) !== -1; });
    var list = $('article-list');
    if (!items.length) {
      var emptyIcon = '<svg class="ic" viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
      list.innerHTML = '<li class="list-empty"><div class="big">' + emptyIcon + '</div>' +
        '<b>' + (kw ? '没有匹配「' + esc(kw) + '」的文章' : '还没有文章') + '</b>' +
        (kw ? '<p>换个关键词试试</p>' : '<p>发布你的第一篇博客</p>') +
        (kw ? '' : '<button class="btn btn-primary" id="btn-empty-new"><svg class="ic" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>新建文章</button>') +
        '</li>';
      var emptyBtn = $('btn-empty-new');
      if (emptyBtn) emptyBtn.addEventListener('click', startNew);
      return;
    }
    list.innerHTML = items.map(function (p) {
      var meta = [p.date, p.category].filter(Boolean).join(' · ');
      var active = state.mode === 'edit' && state.path === p.path ? ' active' : '';
      return '<li class="row' + active + '" data-path="' + esc(p.path) + '">' +
        '<div class="info"><b>' + esc(p.title) + '</b><small>' + esc(meta) + '</small></div>' +
        '<div class="ops">' +
        '<button data-action="edit" title="编辑"><svg class="ic" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>' +
        '<button class="del" data-action="del" title="删除"><svg class="ic" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg></button>' +
        '</div></li>';
    }).join('');
    list.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var path = btn.closest('.row').getAttribute('data-path');
        if (btn.getAttribute('data-action') === 'edit') loadPost(path);
        else deletePost(path);
      });
    });
  }
  $('filter').addEventListener('input', function () {
    state.filter = this.value.trim();
    renderFiltered();
  });

  /* ================ 编辑 / 删除 ================ */
  async function loadPost(path) {
    var s = getSettings();
    setStatus('正在加载文章…');
    try {
      var res = await gh(s, '/repos/' + s.owner + '/' + s.repo + '/contents/' + path);
      if (!res.ok) throw new Error(ghError(res));
      var f = await res.json();
      var parsed = parseMd(b64decode(f.content));
      if (!parsed) throw new Error('无法解析 frontmatter');
      fillForm(parsed.meta);
      $('f-body').value = parsed.body.replace(/^\n+/, '');
      state.mode = 'edit'; state.path = path; state.sha = f.sha;
      state.featured = parseInt(parsed.meta.featured || '0', 10) || 0;
      $('f-featured').value = state.featured || '0';
      setMode('edit', parsed.meta.title || path);
      setSaveState('已载入', 'saved');
      updatePreview();
      renderFiltered();
      setStatus('已载入《' + (parsed.meta.title || path) + '》，改完点「保存到 GitHub」', 'ok');
    } catch (e) {
      setStatus('加载失败：' + e.message, 'err');
    }
  }
  $('btn-reset').addEventListener('click', function () {
    if (state.mode !== 'edit' || !state.path) return;
    if (!window.confirm('放弃当前修改，重新加载线上版本？')) return;
    loadPost(state.path);
  });
  async function deletePost(path) {
    var s = getSettings();
    var item = state.list.find(function (p) { return p.path === path; });
    if (!item) return;
    if (!window.confirm('确定删除《' + item.title + '》？此操作无法撤销。')) return;
    try {
      var res = await gh(s, '/repos/' + s.owner + '/' + s.repo + '/contents/' + path, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '删除: ' + item.title, sha: item.sha })
      });
      if (!res.ok) throw new Error(ghError(res));
      setStatus('已删除《' + item.title + '》，构建进行中', 'ok');
      loadArticles();
    } catch (e) {
      setStatus('删除失败：' + e.message, 'err');
    }
  }

  /* ================ 模式 / 新建 / 保存 ================ */
  function setMode(mode, title) {
    var badge = $('mode-badge');
    badge.className = 'mode-badge ' + (mode === 'edit' ? 'edit' : 'new');
    $('mode-text').textContent = mode === 'edit' ? '编辑中' : '新建文章';
    $('btn-reset').style.display = mode === 'edit' ? '' : 'none';
    badge.title = mode === 'edit' && title ? '正在编辑：' + title : '';
  }
  function resetForm() {
    ['f-title', 'f-tags', 'f-summary', 'f-body'].forEach(function (id) { $(id).value = ''; });
    $('f-date').value = today();
    $('f-category').value = '分布式系统';
    setTags([]);
    state.mode = 'new'; state.path = null; state.sha = null; state.featured = 0;
    $('f-featured').value = '0';
    setMode('new');
    setSaveState('就绪', '');
    updatePreview();
    renderFiltered();
  }
  function startNew() {
    if (!window.confirm('开始新文章？当前表单内容会清空（已保存的草稿不受影响）。')) return;
    resetForm();
    setStatus('新建模式，填写内容后点「保存到 GitHub」');
    $('f-title').focus();
  }
  $('btn-new').addEventListener('click', startNew);

  async function saveToGithub() {
    var d = collect();
    if (!d.title) { setStatus('请先填写标题', 'err'); return; }
    if (!d.body.trim()) { setStatus('正文不能为空', 'err'); return; }
    var s = getSettings();
    if (!s.owner || !s.repo || !s.token) {
      setStatus('请先点击「设置」完成配置', 'err');
      showSettings('publish');
      return;
    }
    var isEdit = state.mode === 'edit';
    var path = isEdit ? state.path : 'posts/' + slugOf(d) + '.md';
    var btn = $('btn-publish'), old = btn.textContent;
    btn.disabled = true; btn.textContent = '保存中…';
    setSaveState('保存中…', 'saving');
    try {
      var body = { message: (isEdit ? '更新: ' : '发布: ') + d.title, content: b64encode(makeMarkdown(d)) };
      if (isEdit && state.sha) body.sha = state.sha;
      var res = await gh(s, '/repos/' + s.owner + '/' + s.repo + '/contents/' + path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(ghError(res));
      var data = await res.json();
      state.mode = 'edit'; state.path = path; state.sha = data.content.sha;
      setMode('edit', d.title);
      setSaveState('已保存 ' + nowHM(), 'saved');
      localStorage.removeItem(DRAFT_KEY);
      $('draft-time').textContent = '';
      var link = 'https://' + s.owner + '.github.io/' + (path.replace('posts/', '').replace('.md', '.html'));
      setStatus((isEdit ? '文章已更新' : '文章已发布') +
        '，构建约需 1-2 分钟 · <a href="' + link + '" target="_blank" rel="noopener">查看线上文章</a>', 'ok', true);
      loadArticles();
    } catch (e) {
      setSaveState('保存失败', 'err');
      setStatus('保存失败：' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  }

  /* ================ 草稿 ================ */
  function saveDraft() {
    var d = collect();
    if (!d.title && !d.body) { setStatus('还没有内容可保存'); return; }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    $('draft-time').textContent = '草稿 ' + nowHM();
    setSaveState('草稿已存 ' + nowHM(), 'saved');
    setStatus('草稿已保存到本地浏览器');
  }
  function loadDraft() {
    try {
      var d = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (d && (d.title || d.body)) {
        fillForm(d);
        setSaveState('草稿已恢复', 'saved');
      }
    } catch (e) {}
  }

  /* ================ 预览复制 ================ */
  $('preview-desktop').addEventListener('click', function (e) {
    var btn = e.target.closest('.copy');
    if (!btn) return;
    var wrap = btn.closest('.code-wrap');
    var code = wrap ? wrap.querySelector('pre') : null;
    if (!code) return;
    var text = code.innerText;
    var done = function () {
      btn.textContent = '已复制';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = '⧉ 复制'; btn.classList.remove('copied'); }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
    else done();
  });

  /* ================ 预览发布效果（本地生成完整文章页） ================ */
  function extractHeadings(md) {
    var list = [];
    md.split('\n').forEach(function (line) {
      var m = line.match(/^(#{2,3})\s+(.*)/);
      if (m) list.push({ level: m[1].length, text: m[2].trim() });
    });
    return list;
  }
  function slugifyMd(t) {
    return t.replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function renderPostPage(d) {
    var headings = extractHeadings(d.body);
    var toc = headings.map(function (h, i) {
      var sid = slugifyMd(h.text) || 's' + i;
      return '<a' + (h.level === 3 ? ' class="l2"' : '') + ' href="#' + esc(sid) + '">' + esc(h.text) + '</a>';
    }).join('');
    var bodyHtml = renderMd(d.body);
    var words = d.body.replace(/\s/g, '').length;
    var min = Math.max(1, Math.round(words / 400));
    var tagsHtml = (d.tags || []).map(function (t) { return '<span class="pv-tag">#' + esc(t) + '</span>'; }).join('');
    var related = state.list.filter(function (p) {
      return p.title !== d.title && (p.category === d.category || (p.tags || []).some(function (t) { return d.tags.indexOf(t) !== -1; }));
    }).slice(0, 3).map(function (p) {
      return '<a class="pv-rel" href="#"><b>' + esc(p.title) + '</b><small>' + esc(p.date) + '</small></a>';
    }).join('') || '<p class="pv-muted">暂无相关文章</p>';
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>' + esc(d.title) + ' · 预览</title>' +
      '<style>' + PREVIEW_CSS + '</style></head><body>' +
      '<div class="pv-top"><span class="pv-mark">~</span><b>发布效果预览</b><span class="pv-badge">本地预览 · 尚未发布</span></div>' +
      '<div class="pv-layout">' +
      '<main class="pv-main">' +
      '<a class="pv-cat">' + esc(d.category || '未分类') + '</a>' +
      '<h1>' + esc(d.title) + '</h1>' +
      '<div class="pv-meta">阿澈 · ' + esc(d.date) + ' · 约 ' + min + ' 分钟</div>' +
      '<div class="prose">' + bodyHtml + '</div>' +
      '<div class="pv-tags">' + tagsHtml + '</div>' +
      '<div class="pv-related"><h3>相关文章</h3>' + related + '</div>' +
      '</main>' +
      (toc ? '<aside class="pv-toc"><div class="pv-toc-t">本页目录</div>' + toc + '</aside>' : '') +
      '</div>' +
      '<div class="pv-foot">由写作台生成的本地预览 · 确认效果后点击「保存到 GitHub」发布</div>' +
      '</body></html>';
  }
  var PREVIEW_CSS = '\
*{margin:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;color:#1f2328;line-height:1.85;background:#eef0f3}.pv-top{display:flex;align-items:center;gap:10px;padding:12px 24px;background:#fff;border-bottom:1px solid #e5e7eb}.pv-mark{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px}.pv-badge{margin-left:auto;font-size:11px;color:#15803d;background:#dcfce7;border-radius:20px;padding:3px 12px;font-weight:700}.pv-layout{display:flex;gap:24px;max-width:1080px;margin:26px auto;padding:0 24px;align-items:flex-start}.pv-main{flex:1;max-width:780px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px 36px;box-shadow:0 2px 8px rgba(0,0,0,.05)}.pv-cat{display:inline-block;font-size:12px;font-weight:700;color:#1d4ed8;background:#eff6ff;border-radius:20px;padding:3px 14px}.pv-main h1{font-size:30px;font-weight:800;letter-spacing:-.5px;line-height:1.4;margin:14px 0 8px}.pv-meta{font-size:13px;color:#6b7280;padding-bottom:18px;border-bottom:1px solid #e5e7eb;margin-bottom:10px}.prose{padding-top:8px}.prose h2{font-size:22px;font-weight:800;margin:42px 0 14px}.prose h3{font-size:18px;font-weight:700;margin:28px 0 10px}.prose p{margin:16px 0;font-size:16px}.prose strong{color:#111}.prose code{background:#f3f4f6;border-radius:5px;padding:2px 7px;font-size:13.5px;font-family:Consolas,Menlo,monospace;color:#0f766e}.prose pre{background:#0f172a;color:#e2e8f0;padding:18px 20px;overflow-x:auto;border-radius:10px;font-size:13.5px;line-height:1.75;font-family:Consolas,Menlo,monospace;white-space:pre}.prose blockquote{border-left:4px solid #2563eb;background:#eff6ff;padding:14px 20px;margin:22px 0;border-radius:0 8px 8px 0}.prose blockquote p{margin:6px 0}.prose ul,.prose ol{margin:16px 0 16px 26px;font-size:15.5px}.prose li{margin:7px 0}.prose table{width:100%;border-collapse:collapse;margin:20px 0;font-size:14px}.prose th,.prose td{border:1px solid #e5e7eb;padding:9px 14px;text-align:left}.prose th{background:#f8fafc}.prose img{max-width:100%;border-radius:8px}.pv-tags{margin-top:26px;padding-top:18px;border-top:1px solid #e5e7eb;display:flex;gap:8px;flex-wrap:wrap}.pv-tag{font-size:12px;color:#1d4ed8;background:#eff6ff;border-radius:20px;padding:4px 14px;font-weight:600}.pv-related{margin-top:28px}.pv-related h3{font-size:15px;font-weight:800;margin-bottom:12px}.pv-rel{display:block;text-decoration:none;color:inherit;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin-bottom:8px;transition:.12s}.pv-rel:hover{border-color:#2563eb}.pv-rel b{display:block;font-size:14px;color:#1f2328}.pv-rel small{font-size:11.5px;color:#9ca3af}.pv-muted{color:#9ca3af;font-size:13px}.pv-toc{position:sticky;top:20px;width:200px;flex-shrink:0;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px}.pv-toc-t{font-size:11px;font-weight:800;color:#6b7280;letter-spacing:1px;margin-bottom:10px}.pv-toc a{display:block;font-size:12.5px;color:#6b7280;text-decoration:none;padding:5px 0 5px 10px;border-left:2px solid #e5e7eb}.pv-toc a.l2{padding-left:20px;font-size:12px}.pv-foot{text-align:center;padding:24px;color:#9ca3af;font-size:12px}';
  $('btn-preview').addEventListener('click', function () {
    var d = collect();
    if (!d.title) { setStatus('请先填写标题', 'err'); return; }
    if (!d.body.trim()) { setStatus('正文不能为空', 'err'); return; }
    var html = renderPostPage(d);
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    setStatus('已在新窗口打开发布效果预览（本地生成，未推送）');
  });

  /* ================ 下载 ================ */
  $('btn-download').addEventListener('click', function () {
    var d = collect();
    if (!d.title) { setStatus('请先填写标题', 'err'); return; }
    var blob = new Blob([makeMarkdown(d)], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = slugOf(d) + '.md';
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('已导出 ' + a.download);
  });

  /* ================ 语法速查 ================ */
  $('btn-cheat').addEventListener('click', function (e) { e.preventDefault(); $('cheat-mask').classList.add('show'); });
  $('btn-cheat-close').addEventListener('click', function () { $('cheat-mask').classList.remove('show'); });
  $('cheat-mask').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });

  /* ================ 绑定 ================ */
  $('btn-publish').addEventListener('click', saveToGithub);
  $('btn-save').addEventListener('click', saveDraft);
  $('btn-refresh').addEventListener('click', loadArticles);

  /* ================ 初始化 ================ */
  if (!$('f-date').value) $('f-date').value = today();
  loadCats();
  loadDraft();
  updatePreview();
  renderConn(getSettings());
  loadArticles();
})();
