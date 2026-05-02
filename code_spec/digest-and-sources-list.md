# RSS Digest 审阅页面 + Sources 列表化

## Context

RSS summarizer 现在能正常产出话题摘要了，但直接以 `inbox/seed` Note 存入知识库，没有审阅环节。用户需要一个 Digest 页面来审阅话题摘要，选择性地存为知识卡片或忽略。另外 SourcesPage 用卡片展示量大时太乱，改为列表。

---

## Phase 1: Schema — 添加 `digest` note_type

**`src/pkg/schemas/note.py`**

NoteCreate (line 12) 和 NoteUpdate (line 58) 的 pattern 都加 `digest`：
```
^(architecture|case-study|concept|digest|how-to|inbox|remember)$
```

前端 NotesPage 的 type filter 列表也要加 `"digest"`（但 Digest 有独立页面，Notes 页不需要显示 digest 类型，所以 NotesPage 的查询可以排除 digest）。

---

## Phase 2: Summarizer 输出改为 digest/pending_review

**`src/pkg/services/rss_summarizer.py`** (line 172-180)

```python
NoteCreate(
    title=f"RSS: {topic.topic} - {today}",
    note_type="digest",          # was "inbox"
    category_id=default_cat_id,
    content=topic.summary,
    status="pending_review",      # was "seed"
    tags=["rss-summary", "auto-generated"],
    domains=["rss"],
    source_ids=article_ids,
)
```

---

## Phase 3: 新建 DigestPage — 列表审阅

**新建 `web/src/pages/DigestPage.tsx`**

查询：`notesApi.list({ note_type: "digest", limit: 100 })`

列表布局（不是卡片），每行：
```
┌──────────────────────────────────────────────────────────────────┐
│ [话题标题]                           [2025-05-02]  [3 sources]   │
│ 摘要前两行预览...                                                │
│                                    [Save as knowledge] [Dismiss] │
└──────────────────────────────────────────────────────────────────┘
```

- 点击行 → 跳转 `/notes/:id` 查看完整内容
- **Save as knowledge**: `notesApi.update(id, { note_type: "concept", status: "seed" })` → 进入正式知识库
- **Dismiss**: `notesApi.delete(id)`
- 用 `useMutation` + `invalidateQueries` 刷新列表
- 两个 tab 或 filter：`pending_review`（待审阅）和 `dismissed`（已处理的，或只显示 pending）

简化起见只显示 `pending_review` 状态的，accepted/dismissed 后从列表消失。

---

## Phase 4: 路由 + 导航

**`web/src/App.tsx`**
- import DigestPage
- 添加 `<Route path="/digest" element={<DigestPage />} />`

**`web/src/components/Layout.tsx`** (navItems array, line 31-39)
- 添加 `{ to: "/digest", icon: Newspaper, label: "Digest" }`
- import `Newspaper` from lucide-react

---

## Phase 5: SourcesPage 卡片 → 列表

**`web/src/pages/SourcesPage.tsx`**

把 `SourceCard` (card grid) 改为行列表：
- 去掉 `<Card>` 组件，改为 `<div>` 行
- 每行：类型 badge + 标题 + URL (truncated) + 日期 + RSS badge（如有）
- 布局从 `grid md:grid-cols-2` 改为 `space-y-1`
- 点击行跳转详情不变

```tsx
function SourceRow({ source, onClick }: { source: Source; onClick: () => void }) {
  const isRss = source.source_type === "web" && source.metadata_?.rss_enabled === "true";
  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:border-border hover:bg-accent/50 cursor-pointer transition-colors"
      onClick={onClick}
    >
      <Badge variant="source" className="shrink-0">{source.source_type}</Badge>
      {isRss && <Rss className="h-3.5 w-3.5 text-orange-500 shrink-0" />}
      <span className="text-sm font-medium truncate flex-1">{source.title}</span>
      {source.url && <span className="text-xs text-muted-foreground truncate max-w-[200px] hidden md:block">{source.url}</span>}
      <span className="text-xs text-muted-foreground shrink-0">{new Date(source.ingested_at).toLocaleDateString()}</span>
    </div>
  );
}
```

Group 内部也从 `grid gap-3 md:grid-cols-2` 改为 `space-y-1`。

---

## Files

| File | Change |
|------|--------|
| `src/pkg/schemas/note.py` | note_type pattern 加 `digest` |
| `src/pkg/services/rss_summarizer.py` | note_type → `digest`, status → `pending_review` |
| `web/src/pages/DigestPage.tsx` | **新建** — 列表审阅页 |
| `web/src/App.tsx` | 加 `/digest` 路由 |
| `web/src/components/Layout.tsx` | 加 Digest 导航项 |
| `web/src/pages/SourcesPage.tsx` | 卡片 → 列表行 |

## Verification

1. 手动触发 `POST /api/sources/rss/summarize` → 产出 `note_type="digest"`, `status="pending_review"` 的 Note
2. `/digest` 页面显示话题列表
3. 点击 "Save as knowledge" → note_type 变 concept、status 变 seed → 该条从 digest 列表消失，出现在 Notes 页
4. 点击 "Dismiss" → Note 被删除
5. 点击行 → 跳转到 NoteDetailPage 看完整内容
6. `/sources` 页面改为列表展示，量大时更清晰
