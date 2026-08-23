# Experiment 09: Execute and Evaluate — 运行、记录与判定

按已批准协议执行实验，保留失败与偏差，并依据预先定义的指标回答 RQ。

## 前置输入

- 用户批准的 Experiment Protocol Artifact
- 可用工具、模型、数据和运行环境
- 结果记录位置为当前 Harness Session

## Prompt 模板

```text
按当前 Session 中已批准的 Experiment Protocol 执行实验。

1. 执行前复述协议版本、矩阵和停止条件；未经确认不得静默改变设计。
2. 每个 run 记录输入、方法、参数、输出摘要、指标、耗时和异常。
3. 失败 run 不得删除；标注失败类型以及是否重试。
4. 聚合结果时区分观察结果、解释和推断，不用单个案例替代总体结论。
5. 如协议无法执行，暂停并输出 deviation request。
6. 输出 Evaluation Artifact，不自动写入 PKG。
```

## 阶段产物

```markdown
## Protocol Version
## Run Ledger
## Deviations
## Metric Results
## Qualitative Findings
## Error Analysis
## RQ Answer
## Threats to Validity
## Reproduction Notes
## Stage Decision
```

## 完成门槛

- [ ] 实际 run 与实验矩阵可逐项对应
- [ ] 失败、重试和协议偏差完整保留
- [ ] 结论依据预定义指标，而不是事后挑选案例
- [ ] 明确内在、外在和构念效度威胁
- [ ] 用户确认结果后才进入 Experiment 10
