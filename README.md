# ~/notes 技术笔记 — 博客系统

作者：TAO · 研究方向：模型轻量化与边缘计算

一套完整的静态博客系统：**写作台（浏览器发文章）→ GitHub Actions 自动构建 → GitHub Pages 发布**。
零服务器、零成本、零框架。

## 快速开始

### 第 1 步：替换占位信息

部署前全局替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `YOUR-USERNAME` | 你的 GitHub 用户名（出现在 `feed.xml` / `sitemap.xml` / `robots.txt`） |
| `you@example.com` | 你的邮箱（订阅输入框 placeholder） |

### 第 2 步：创建仓库并推送

```bash
# 仓库名必须是 <你的用户名>.github.io（个人主页仓库）
git init
git add .
git commit -m "init: 博客系统"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<你的用户名>.github.io.git
git push -u origin main
```

### 第 3 步：开启 GitHub Pages

1. 仓库 **Settings → Pages**
2. Source 选择 **Deploy from a branch** → 分支选 **`gh-pages`**（部署工作流自动生成）→ Save
3. 等 1-2 分钟，访问 `https://<你的用户名>.github.io/`

> ⚠️ 注意：部署工作流（`.github/workflows/deploy.yml`）会在每次 push 后自动
> 运行 `publish.py --rebuild` 重建全站并部署到 `gh-pages` 分支，所以 Pages 源选 **gh-pages**。

## 写作台（发布文章）

打开 `https://<你的用户名>.github.io/admin.html`，在浏览器里完成所有写作：

| 功能 | 位置 |
|------|------|
| 新建 / 编辑 / 删除文章 | 左侧文章列表 + 编辑区 |
| 分类、标签、摘要、日期 | 表单区 |
| **首页推荐位（1/2/3）** | 表单「首页推荐」下拉 |
| 实时预览 | 正文右侧 |
| 发布到 GitHub | 右下角「保存到 GitHub」 |

**首次使用**：点击顶栏「未连接 GitHub」→ 填用户名 / 仓库名 / Personal Access Token（`repo` 权限）→ 保存。发布后 GitHub Actions 自动构建，1-2 分钟线上生效。

## 目录结构

```
├── index.html          首页（Hero + 主编推荐 3 块 + 文章流）
├── admin.html          写作台（浏览器发文章）
├── archive.html        归档
├── category.html       分类
├── tags.html           标签
├── about.html          关于我
├── posts/*.md          文章源文件（Markdown + frontmatter）
├── post-template.html  文章页模板
├── publish.py          发布脚本（本地可选）
├── feed.xml / sitemap.xml / robots.txt
├── assets/             style.css · app.js · admin.js
└── .github/workflows/deploy.yml   自动构建部署
```

## 写新文章（两种方式）

**方式 A：写作台（推荐）** — `admin.html` 直接写，点「保存到 GitHub」。

**方式 B：命令行** — 在 `posts/` 写 Markdown：

```markdown
---
title: 文章标题
date: 2024-07-23
category: 读研日常          # 5 个分类之一
tags: [算法题]
summary: 一句话摘要
featured: 1               # 可选：首页推荐位 1/2/3
---
正文（支持 ## 标题、代码块、表格、引用…）
```

然后：

```bash
python publish.py posts/xxx.md
git add . && git commit -m "发布: xxx" && git push
```

## 自定义

- 站点名 / 作者：全局搜索「notes」「TAO」
- 配色：`assets/style.css` 顶部的设计变量（`--accent` 等）
- 分类：写作台「设置 → 分类管理」
- 标签：写作台「设置 → 标签管理」（发布带标签的文章后自动聚合到博客）
