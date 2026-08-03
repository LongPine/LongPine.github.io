#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
~/notes 博客发布工具
====================
用法：
    python publish.py posts/2024-07-22-xxx.md    # 发布 / 更新一篇文章
    python publish.py --rebuild                  # 根据 posts/ 目录重建所有页面
    python publish.py --help                     # 帮助

流程：写 Markdown → 运行本脚本 → git add . && git commit && git push
脚本会自动：生成文章详情页，并同步更新首页、归档、分类、标签、RSS、侧栏。
"""
import io, os, re, sys, json, datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
POSTS_DIR = BASE / 'posts'
TEMPLATE = BASE / 'post-template.html'
DATA_FILE = BASE / 'data.json'

CATEGORY_IDS = {  # 分类名 → 锚点 id（新增分类可在此追加）
    '分布式系统': 'distributed', '论文阅读': 'papers',
    '工具链': 'tools', '读研日常': 'life', '读书笔记': 'reading',
}
AUTHOR = 'TAO'
SITE = 'https://LongPine.github.io/'

# ============================================================
# Markdown → HTML（极简转换器，支持常用语法）
# ============================================================

def inline(text):
    """行内格式化：`code`、**粗体**、*斜体*、[链接](url)、![图](url)"""
    text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'<em>\1</em>', text)
    text = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', r'<div class="figure"><div class="box"><span class="big">🖼</span>[图片：\1]</div><figcaption>\1</figcaption></div>', text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2" target="_blank" rel="noopener">\1</a>', text)
    return text

def code_block(lang, code):
    code = code.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    lang = lang or 'text'
    return ('<div class="code-wrap"><div class="code-head">'
            '<span class="lang"><i class="dot"></i><i class="dot"></i><i class="dot"></i> %s</span>'
            '<button class="copy" type="button">⧉ 复制</button></div>'
            '<pre>%s</pre></div>') % (lang, code)

def slugify(text):
    text = re.sub(r'[^\w\u4e00-\u9fff]+', '-', text).strip('-')
    return text or 'section'

def md_to_html(md_text):
    """返回 (html, headings)。headings: [(level, text, id)]"""
    lines = md_text.splitlines()
    out, headings = [], []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        # 代码块
        m = re.match(r'^```(\w*)', line)
        if m:
            lang, buf = m.group(1), []
            i += 1
            while i < n and not lines[i].startswith('```'):
                buf.append(lines[i]); i += 1
            i += 1
            out.append(code_block(lang, '\n'.join(buf))); continue
        # 标题 ## / ###
        m = re.match(r'^(#{2,3})\s+(.*)', line)
        if m:
            level = len(m.group(1)); text = m.group(2)
            sid = slugify(text)
            sid = sid if sid not in [h[2] for h in headings] else sid + '-' + str(len(headings))
            headings.append((level, text, sid))
            tag = 'h2' if level == 2 else 'h3'
            out.append('<%s id="%s">%s</%s>' % (tag, sid, inline(text), tag))
            i += 1; continue
        # 引用
        if line.startswith('>'):
            buf = []
            while i < n and lines[i].startswith('>'):
                buf.append(inline(lines[i][1:].strip())); i += 1
            out.append('<blockquote><p>' + '<br>'.join(buf) + '</p></blockquote>'); continue
        # 无序列表
        if re.match(r'^[-*]\s+', line):
            buf = []
            while i < n and re.match(r'^[-*]\s+', lines[i]):
                buf.append('<li>' + inline(re.sub(r'^[-*]\s+', '', lines[i])) + '</li>'); i += 1
            out.append('<ul>' + ''.join(buf) + '</ul>'); continue
        # 有序列表
        if re.match(r'^\d+\.\s+', line):
            buf = []
            while i < n and re.match(r'^\d+\.\s+', lines[i]):
                buf.append('<li>' + inline(re.sub(r'^\d+\.\s+', '', lines[i])) + '</li>'); i += 1
            out.append('<ol>' + ''.join(buf) + '</ol>'); continue
        # 表格
        if '|' in line and i + 1 < n and re.match(r'^\s*\|?[\s:|-]+\|?\s*$', lines[i + 1]):
            def cells(r):
                r = r.strip().strip('|')
                return [c.strip() for c in r.split('|')]
            header, i = cells(line), i + 2
            rows = []
            while i < n and '|' in lines[i]:
                rows.append(cells(lines[i])); i += 1
            thead = ''.join('<th>%s</th>' % inline(c) for c in header)
            tbody = ''.join('<tr>%s</tr>' % ''.join('<td>%s</td>' % inline(c) for c in r) for r in rows)
            out.append('<table><thead><tr>%s</tr></thead><tbody>%s</tbody></table>' % (thead, tbody)); continue
        # 空行
        if not line.strip():
            i += 1; continue
        # 段落
        buf = [line]; i += 1
        while i < n and lines[i].strip() and not re.match(r'^(#{2,3}\s|```|>|[-*]\s|\d+\.\s)|\|', lines[i]):
            buf.append(lines[i]); i += 1
        out.append('<p>' + inline(' '.join(buf)) + '</p>')
    return '\n'.join(out), headings

# ============================================================
# 文章解析
# ============================================================

def parse_md(path):
    text = Path(path).read_text(encoding='utf-8')
    m = re.match(r'^---\s*\n(.*?)\n---\s*\n?(.*)$', text, re.S)
    if not m:
        raise SystemExit('❌ 缺少 frontmatter（文件头部的 --- 区块）: %s' % path)
    fm, body = m.groups()
    meta = {'file': Path(path).name, 'slug': Path(path).stem}
    for line in fm.splitlines():
        if ':' in line:
            k, v = line.split(':', 1)
            k = k.strip().lower(); v = v.strip().strip('"\'')
            if k == 'tags':
                meta['tags'] = [t.strip().strip('[]"\'') for t in v.split(',') if t.strip()]
            else:
                meta[k] = v
    meta.setdefault('title', meta['slug'])
    meta.setdefault('date', datetime.date.today().isoformat())
    meta.setdefault('category', '读研日常')
    meta.setdefault('tags', [])
    meta.setdefault('summary', body.strip().splitlines()[0][:80] if body.strip() else '')
    meta['id'] = CATEGORY_IDS.get(meta['category'], 'cat-' + str(len(CATEGORY_IDS) + 1))
    return meta, body

def load_posts():
    posts = []
    for p in sorted(POSTS_DIR.glob('*.md')):
        meta, body = parse_md(p)
        meta['body'] = body
        meta['link'] = 'post-' + meta['slug'] + '.html'
        try:
            meta['featured'] = int(str(meta.get('featured', '0') or '0').strip() or 0)
        except ValueError:
            meta['featured'] = 0
        posts.append(meta)
    posts.sort(key=lambda x: x['date'], reverse=True)
    return posts

# ============================================================
# 区块渲染
# ============================================================

def cat_link(page, cat_id, name, count):
    href = '#' + cat_id if page == 'category' else 'category.html#' + cat_id
    return '    <a class="nav" href="%s">%s <small>%d</small></a>' % (href, name, count)

def render_sidecats(posts, page):
    counts = {}
    for p in posts:
        counts[p['category']] = counts.get(p['category'], 0) + 1
    cats = [(c, CATEGORY_IDS.get(c, 'cat-x')) for c in counts]
    cats.sort(key=lambda x: -counts[x[0]])
    return '\n'.join(cat_link(page, cid, c, counts[c]) for c, cid in cats)

def render_post_item(p, featured=False):
    badge = ' <span class="badge badge-new">NEW</span>' if featured else ''
    tags = ''.join('<span class="tg">%s</span>' % t for t in p['tags'][:2])
    tm = max(2, len(p.get('body', '')) // 400)
    return ('      <a class="post" href="%s">\n'
            '        <div class="row1"><span>%s</span>%s</div>\n'
            '        <h3>%s</h3>\n'
            '        <p class="ex">%s</p>\n'
            '        <div class="row2">%s<span class="tm">⏱ %d min</span><span class="read-more">阅读 →</span></div>\n'
            '      </a>' % (p['link'], p['date'], badge, p['title'], p['summary'], tags, tm))

def render_featured(posts):
    feats = [p for p in posts if p.get('featured', 0)]
    feats.sort(key=lambda x: x['featured'])
    if not feats:
        return ('      <a class="feat-card feat-empty" href="admin.html"><span class="feat-no">+</span>'
                '<b>设置主编推荐</b>'
                '<p>在写作台表单的「首页推荐」下拉中，为文章选择 1/2/3 推荐位</p></a>')
    out = []
    for i, p in enumerate(feats[:3], 1):
        read_min = max(2, len(p.get('body', '')) // 400)
        out.append('      <a class="feat-card" href="%s"><span class="feat-no">0%d</span><span class="feat-cat">%s</span>'
                   '<h3>%s</h3><p>%s</p><span class="feat-meta">%s · %d 分钟</span></a>'
                   % (p['link'], i, p['category'], p['title'], p['summary'], p['date'], read_min))
    return '\n'.join(out)

def render_recent(posts, n=4):
    return '\n'.join('        <a class="item" href="%s"><span class="d">%s</span>%s</a>' %
                     (p['link'], p['date'][5:], p['title'][:12] + ('…' if len(p['title']) > 12 else ''))
                     for p in posts[:n])

def render_stats(posts):
    tags = len(set(t for p in posts for t in p['tags']))
    cats = len(set(p['category'] for p in posts))
    days = 0
    if posts:
        d0 = datetime.date.fromisoformat(posts[-1]['date'])
        days = (datetime.date.today() - d0).days
    items = [
        ('%d' % len(posts), '篇文章'),
        ('%d' % cats, '个分类'),
        ('%d' % tags, '个标签'),
        ('%d' % days, '持续更新天数'),
    ]
    return '\n'.join('      <div class="s"><b>%s</b><span>%s</span></div>' % (v, l) for v, l in items)

def render_topics(posts):
    counts = {}
    for p in posts:
        counts[p['category']] = counts.get(p['category'], 0) + 1
    colors = {'分布式系统': '#2563eb', '论文阅读': '#7c3aed', '工具链': '#0891b2', '读研日常': '#d97706', '读书笔记': '#059669'}
    out = []
    for c, cnt in sorted(counts.items(), key=lambda x: -x[1]):
        cid = CATEGORY_IDS.get(c, 'cat-x')
        color = colors.get(c, '#64748b')
        out.append('      <a class="topic" href="category.html#%s"><span class="t-ic" style="background:%s">%s</span><b>%s</b><p>%s</p><span class="n">%d 篇 →</span></a>'
                   % (cid, color, c[0], c, '相关文章', cnt))
    return '\n'.join(out)

def render_archive(posts):
    years = {}
    for p in posts:
        y, m = p['date'][:4], p['date'][5:7]
        years.setdefault(y, {}).setdefault(m, []).append(p)
    out = []
    for y in sorted(years, reverse=True):
        months = years[y]
        total = sum(len(v) for v in months.values())
        out.append('    <div class="y">%s <small>%d 篇</small></div>' % (y, total))
        for m in sorted(months, reverse=True):
            out.append('    <div class="archive-month"><div class="m">%s月 · %d 篇</div><div class="items">' %
                       (m, len(months[m])))
            for p in months[m]:
                tag = '<span class="tg">%s</span>' % p['category']
                out.append('      <a class="item" href="%s"><span class="d">%s</span><b>%s</b>%s</a>' %
                           (p['link'], p['date'][5:], p['title'], tag))
            out.append('    </div></div>')
    return '\n'.join(out)

def render_category(posts):
    counts = {}
    for p in posts:
        counts.setdefault(p['category'], []).append(p)
    icons = {'分布式系统': '🗄️', '论文阅读': '📄', '工具链': '🛠️', '读研日常': '☕', '读书笔记': '📚'}
    out = []
    for c, plist in sorted(counts.items(), key=lambda x: -len(x[1])):
        cid = CATEGORY_IDS.get(c, 'cat-x')
        out.append('    <section class="tag-section" id="%s">' % cid)
        out.append('      <div class="t"><span class="hash">%s</span>%s <small>%d 篇</small></div>' % (icons.get(c, '📝'), c, len(plist)))
        out.append('      <div class="list">')
        for p in plist:
            out.append('        <a href="%s"><span class="d">%s</span><b>%s</b></a>' % (p['link'], p['date'][5:], p['title']))
        out.append('      </div>')
        out.append('    </section>')
    return '\n'.join(out)

def render_tags(posts):
    tag_map = {}
    for p in posts:
        for t in p['tags']:
            tag_map.setdefault(t, []).append(p)
    ordered = sorted(tag_map.items(), key=lambda x: -len(x[1]))
    sizes = ['s4', 's3', 's3', 's2', 's2', 's1']
    out = ['    <div class="cloud">']
    for idx, (t, plist) in enumerate(ordered):
        out.append('      <a class="%s" href="#%s">#%s <small>%d</small></a>' % (sizes[min(idx, 5)], slugify(t), t, len(plist)))
    out.append('    </div>')
    for t, plist in ordered:
        out.append('    <section class="tag-section" id="%s">' % slugify(t))
        out.append('      <div class="t"><span class="hash">#</span>%s <small>%d 篇</small></div>' % (t, len(plist)))
        out.append('      <div class="list">')
        for p in plist:
            out.append('        <a href="%s"><span class="d">%s</span><b>%s</b></a>' % (p['link'], p['date'][5:], p['title']))
        out.append('      </div>')
        out.append('    </section>')
    return '\n'.join(out)

def render_feed(posts):
    out = []
    for p in posts[:10]:
        d = datetime.date.fromisoformat(p['date'])
        rfc = d.strftime('%a, %d %b %Y 10:00:00 +0800')
        out.append('    <item>')
        out.append('      <title>%s</title>' % p['title'])
        out.append('      <link>%s%s</link>' % (SITE, p['link']))
        out.append('      <guid>%s%s#%s</guid>' % (SITE, p['link'], p['date']))
        out.append('      <pubDate>%s</pubDate>' % rfc)
        out.append('      <description>%s</description>' % p['summary'])
        out.append('    </item>')
    return '\n'.join(out)

def render_toc(headings):
    out = ['      <div class="toc-title">本页目录</div>']
    for level, text, sid in headings:
        cls = ' class="l2"' if level == 3 else ''
        out.append('      <a%s href="#%s">%s</a>' % (cls, sid, text))
    return '\n'.join(out)

def render_rail_tags(posts):
    tag_map = {}
    for p in posts:
        for t in p['tags']:
            tag_map[t] = tag_map.get(t, 0) + 1
    top = sorted(tag_map.items(), key=lambda x: -x[1])[:6]
    return '\n'.join('        <a href="tags.html#%s">#%s</a>' % (slugify(t), t) for t, _ in top)

def render_related(posts, cur, n=3):
    out = []
    for p in posts:
        if p is cur: continue
        if p['category'] == cur['category'] or set(p['tags']) & set(cur['tags']):
            out.append('        <a href="%s"><span class="d">%s</span><b>%s</b><small>%s →</small></a>' %
                       (p['link'], p['date'], p['title'], p['category']))
            if len(out) == n: break
    while len(out) < n and len(out) < len(posts) - 1:
        for p in posts:
            if p is cur or any(p['title'] == o.split('</b>')[0][-len(p['title']):] for o in out): continue
            out.append('        <a href="%s"><span class="d">%s</span><b>%s</b><small>%s →</small></a>' %
                       (p['link'], p['date'], p['title'], p['category']))
            if len(out) == n: break
    return '\n'.join(out)

def render_pager(posts, cur):
    idx = posts.index(cur)
    prev, nxt = '', ''
    if idx < len(posts) - 1:
        p = posts[idx + 1]
        prev = ('      <a class="prev" href="%s"><span class="lbl">← 上一篇</span><div class="t">%s</div></a>' % (p['link'], p['title']))
    if idx > 0:
        p = posts[idx - 1]
        nxt = ('      <a class="next" href="%s"><span class="lbl">下一篇 →</span><div class="t">%s</div></a>' % (p['link'], p['title']))
    if prev and nxt: return prev + '\n' + nxt
    return prev + '\n' + nxt if (prev or nxt) else '      <a class="prev" href="archive.html"><span class="lbl">← 返回归档</span><div class="t">查看文章列表</div></a>'

def render_post_page(posts, meta, body_html, headings):
    tpl = TEMPLATE.read_text(encoding='utf-8')
    tags_html = '\n'.join('        <a href="tags.html#%s">#%s</a>' % (slugify(t), t) for t in meta['tags'])
    words = len(re.sub(r'\s', '', meta.get('body', '')))
    read_min = max(2, words // 400)
    subs = {
        '{{TITLE}}': meta['title'],
        '{{DESC}}': meta['summary'],
        '{{DATE}}': meta['date'],
        '{{EDIT_DATE}}': meta['date'],
        '{{CATEGORY}}': meta['category'],
        '{{CONTENT}}': body_html,
        '{{TOC}}': render_toc(headings),
        '{{TAGS_HTML}}': tags_html,
        '{{RELATED}}': render_related(posts, meta),
        '{{PAGER}}': render_pager(posts, meta),
        '{{SIDEBAR_CATS}}': render_sidecats(posts, 'post'),
        '{{RAIL_TAGS}}': render_rail_tags(posts),
        '{{READ_MIN}}': str(read_min),
        '{{POST_COUNT}}': str(len(posts)),
        '{{RECENT_UPDATE}}': meta['date'],
    }
    for k, v in subs.items():
        tpl = tpl.replace(k, v)
    return tpl

# ============================================================
# 页面更新（按标记替换）
# ============================================================

def update_blocks(path, blocks):
    if not Path(path).exists():
        return  # 文件不存在则跳过（如已删除的 post.html）
    s = Path(path).read_text(encoding='utf-8')
    for marker, content in blocks.items():
        begin, end = '<!-- %s:BEGIN -->' % marker, '<!-- %s:END -->' % marker
        if begin in s and end in s:
            s = re.sub(re.escape(begin) + r'.*?' + re.escape(end),
                       begin + '\n' + content + '\n' + end, s, flags=re.S)
        else:
            print('⚠️  跳过 %s（缺少 %s 标记）' % (path, marker))
    Path(path).write_text(s, encoding='utf-8')

def rebuild_all(posts):
    print('📄 共 %d 篇文章' % len(posts))

    # 先重建全部文章详情页，确保索引中的每个链接都有实际页面。
    # 旧实现只刷新聚合页，--rebuild 后仍可能留下缺失的 post-*.html。
    for meta in posts:
        body_html, headings = md_to_html(meta.get('body', ''))
        page = BASE / meta['link']
        page.write_text(render_post_page(posts, meta, body_html, headings), encoding='utf-8')
    print('✅ %d 篇文章页已生成' % len(posts))

    # index.html
    update_blocks('index.html', {
        'POSTS': '\n'.join(render_post_item(p, i == 0) for i, p in enumerate(posts[:8])),
        'FEATURED': render_featured(posts),
        'STATS': render_stats(posts),
        'TOPICS': render_topics(posts),
    })
    # archive / category / tags
    update_blocks('archive.html', {'ARCHIVE': render_archive(posts), 'RECENT': render_recent(posts), 'SIDECATS': render_sidecats(posts, 'archive')})
    update_blocks('category.html', {'CATEGORY': render_category(posts), 'RECENT': render_recent(posts), 'SIDECATS': render_sidecats(posts, 'category')})
    update_blocks('tags.html', {'TAGS': render_tags(posts), 'RECENT': render_recent(posts), 'SIDECATS': render_sidecats(posts, 'tags')})
    update_blocks('about.html', {'RECENT': render_recent(posts), 'SIDECATS': render_sidecats(posts, 'about')})
    update_blocks('post.html', {'SIDECATS': render_sidecats(posts, 'post')})
    # feed.xml
    update_blocks('feed.xml', {'ITEMS': render_feed(posts)})
    # 页脚统计（正则）
    for f in ['index.html', 'archive.html', 'category.html', 'tags.html', 'about.html']:
        s = Path(f).read_text(encoding='utf-8')
        s = re.sub(r'共 \d+ 篇', '共 %d 篇' % len(posts), s)
        s = re.sub(r'最近更新[^<]*', '最近更新 ' + posts[0]['date'] if posts else '最近更新', s)
        Path(f).write_text(s, encoding='utf-8')
    print('✅ 首页 / 归档 / 分类 / 标签 / 侧栏 已更新')

def publish(md_path):
    posts = load_posts()
    # 从索引中找到带 link 的 meta（含 slug / link 字段）
    meta = next((p for p in posts if p['file'] == Path(md_path).name), None)
    if meta is None:
        raise SystemExit('❌ 文章不在 posts/ 目录中: %s' % md_path)
    # rebuild_all 会生成当前文章以及所有已有文章，避免模板升级后旧页面样式不同步。
    rebuild_all(posts)
    print('🎉 发布完成！接下来：')
    print('    git add . && git commit -m "发布: %s" && git push' % meta['title'])

# ============================================================
# 入口
# ============================================================

if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help'):
        print(__doc__)
        sys.exit(0)
    if sys.argv[1] == '--rebuild':
        posts = load_posts()
        rebuild_all(posts)
        print('🎉 重建完成')
    else:
        target = Path(sys.argv[1])
        if not target.exists():
            raise SystemExit('❌ 找不到文件: %s' % target)
        if not POSTS_DIR.exists():
            POSTS_DIR.mkdir()
        if target.parent != POSTS_DIR:
            dest = POSTS_DIR / target.name
            dest.write_text(target.read_text(encoding='utf-8'), encoding='utf-8')
            target = dest
        publish(target)
