# Experiment 03: Wiki Refresh — 知识消费→产出闭环

测试 agent 从已有 wiki + 新 knowledge 中识别更新点并起草 refresh proposal。

## 目的

- 测试"消费已有稳定知识 + 获取新证据 → 产出更新草案"的闭环
- 验证 agent 是否能正确区分 stable wiki 和 draft proposal

## Prompt 模板

```
请帮我检查 PKG 中是否有一页 wiki 需要刷新。

步骤：
1. 用 pkg_search 搜 "wiki"，或者用 pkg_knowledge_stats 了解当前知识库状态
2. 选择一页 wiki，用 pkg_search 搜索该 wiki 主题的最新 notes 和 sources
3. 阅读 wiki 内容和新证据
4. 起草 refresh proposal：

## Current Wiki Summary
## New Evidence
## Proposed Updates
## Open Questions
## Apply Recommendation

完成后输出 proposal，不要写入 PKG；由用户 review 后在 Seagull 显式保存或发布。
```

## 实验变量

| 变量 | Variant A | Variant B |
|------|-----------|-----------|
| 证据广度 | 只看 notes | notes + sources + memory |

## 评估维度

- [ ] 是否正确识别了需要刷新的 wiki
- [ ] 新证据是否被正确关联到 wiki 内容
- [ ] proposal 是否可操作（不是模糊建议）
- [ ] 是否区分了"事实"和"推断"
