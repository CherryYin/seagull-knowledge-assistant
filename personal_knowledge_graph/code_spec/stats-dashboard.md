# Stats → Dashboard 改造

## Context

当前 StatsPage 只有一个知识使用排行表。改为 Dashboard 布局：顶部概览数字 → 中间趋势图+分布图 → 底部保留排行表。需要新增后端统计端点和前端 recharts 图表。

---

## Phase 1: 后端 — 新增 `/knowledge/dashboard` 端点

**`src/pkg/api/knowledge.py`** — 添加一个端点返回所有 dashboard 数据：

```python
@router.get("/dashboard")
async def get_dashboard(user: User = Depends(get_current_user)):
```

返回结构：
```json
{
  "counts": {
    "notes": 42,
    "sources": 15,
    "chats": 8,
    "digest_pending": 3
  },
  "trends": [
    {"date": "2026-04-26", "notes": 2, "sources": 1, "chats": 3},
    {"date": "2026-04-27", "notes": 0, "sources": 3, "chats": 1},
    ...  // 最近7天
  ],
  "category_distribution": [
    {"name": "AI", "display_name": "AI", "notes": 12, "sources": 5},
    {"name": "general", "display_name": "General", "notes": 8, "sources": 3},
    ...
  ],
  "note_type_distribution": [
    {"type": "concept", "count": 15},
    {"type": "inbox", "count": 10},
    ...
  ]
}
```

查询逻辑（都在一个端点内，避免多次 round-trip）：
- **counts**: 4 个 `SELECT COUNT(*)` 查询
- **trends**: `SELECT DATE(created_at), COUNT(*) FROM notes WHERE created_at >= now()-7days GROUP BY DATE(created_at)` (notes/sources/chats 分别查)
- **category_distribution**: `SELECT c.name, c.display_name, COUNT(*) FROM notes JOIN categories ... GROUP BY ...`
- **note_type_distribution**: `SELECT note_type, COUNT(*) FROM notes WHERE user_id = ? GROUP BY note_type`

**`src/pkg/schemas/knowledge.py`** — 添加 response models：
- `DashboardCounts`, `DashboardTrendDay`, `CategoryDistribution`, `NoteTypeDistribution`, `DashboardResponse`

---

## Phase 2: 前端 — 安装 recharts

```bash
cd web && npm install recharts
```

---

## Phase 3: 前端 — 重写 StatsPage

**`web/src/pages/StatsPage.tsx`**

布局（从上到下）：

### 3.1 顶部 — 概览数字卡片（4 列）
```
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ 📝 Notes │ │ 📄 Sources│ │ 💬 Chats │ │ 📰 Digest│
│   42     │ │   15     │ │    8     │ │    3     │
└──────────┘ └──────────┘ └──────────┘ └──────────┘
```
用 shadcn Card，每个显示图标 + label + 数字。

### 3.2 中间 — 两列图表
```
┌────────────────────────────┐ ┌────────────────────────────┐
│ 7-Day Activity             │ │ Category Distribution      │
│ [BarChart: notes/sources/  │ │ [BarChart horizontal:      │
│  chats stacked per day]    │ │  category → count]         │
└────────────────────────────┘ └────────────────────────────┘
```

- 左：recharts `<BarChart>` stacked，3 种颜色 (notes/sources/chats)
- 右：recharts `<BarChart layout="vertical">` 显示每个 category 的总量

### 3.3 下方 — 保留排行表
现有的 knowledge stats 表保持不变，只是从页面主体变成 dashboard 的一部分。加个标题 "Knowledge Rankings"。

---

## Phase 4: API 类型 + 调用

**`web/src/lib/api.ts`**

```typescript
export interface DashboardData {
  counts: {
    notes: number;
    sources: number;
    chats: number;
    digest_pending: number;
  };
  trends: Array<{
    date: string;
    notes: number;
    sources: number;
    chats: number;
  }>;
  category_distribution: Array<{
    name: string;
    display_name: string;
    notes: number;
    sources: number;
  }>;
  note_type_distribution: Array<{
    type: string;
    count: number;
  }>;
}

// knowledgeApi 里加：
dashboard: () => request<DashboardData>("/knowledge/dashboard"),
```

---

## Files

| File | Change |
|------|--------|
| `src/pkg/api/knowledge.py` | 新增 `GET /knowledge/dashboard` |
| `src/pkg/schemas/knowledge.py` | 新增 dashboard response models |
| `web/package.json` | 添加 `recharts` 依赖 |
| `web/src/lib/api.ts` | 添加 `DashboardData` 类型 + `knowledgeApi.dashboard()` |
| `web/src/pages/StatsPage.tsx` | 重写为 dashboard 布局 |

## Verification

1. `GET /api/knowledge/dashboard` 返回正确的 counts/trends/distribution 数据
2. StatsPage 显示概览卡片、趋势图、分布图、排行表
3. 趋势图显示最近 7 天数据
4. 排行表的过滤/排序/分页功能保留
