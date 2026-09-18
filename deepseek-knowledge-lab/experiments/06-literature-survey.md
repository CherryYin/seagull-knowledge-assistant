# Experiment 06: Literature Survey — 证据地图

从已有 PKG 知识出发，建立可追溯的文献证据地图，并明确哪些缺口值得进入研究问题设计。

## 输入

- 研究主题或初始问题
- 可选范围：时间、领域、方法、对象
- 可选种子 Source、Note 或 Wiki ID

## Prompt 模板

```text
请为「{TOPIC}」完成文献调研阶段。

1. 先用 pkg_search 检索 PKG 中已有的 Source、Note 和 Wiki。
2. 用 pkg_read_source / pkg_read_note 阅读最相关证据，不要只依据搜索摘要。
3. 按研究子问题对材料编码，区分共识、冲突、方法差异和证据缺口。
4. PKG 没有证据的内容必须标为缺口；只有用户要求且外部工具可用时才补充外部检索。
5. 输出 Literature Survey Artifact，不要自动写入 PKG。
```

## 阶段产物

```markdown
## Scope
## Search Log
## Evidence Map
## Consensus
## Conflicts
## Method Gaps
## Candidate Research Gaps
## Sources Consulted
## Stage Decision
```

`Evidence Map` 每项至少包含：claim、evidence object ID、evidence type、confidence、limitations。

## 完成门槛

- [ ] 至少阅读 2 个相关对象，或明确记录 PKG 证据不足
- [ ] 所有关键判断可追溯到对象 ID 或明确标为推断
- [ ] 至少形成 1 个可验证的研究缺口
- [ ] 用户确认后才进入 Experiment 07
- [ ] 阶段产物留在 Harness Session；仅通过 Seagull 显式保存
