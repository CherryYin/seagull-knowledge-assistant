# Experiment 08: Experiment Design — 可执行评估协议

把已确认的 RQ 转成可复现的实验矩阵、指标、基线和停止条件。

## 前置输入

- Experiment 07 的 RQ Design Artifact
- 可用模型、数据、解析器或其他被测方法
- 成本、时间、隐私和人工评审预算

## Prompt 模板

```text
为当前 Session 中已确认的主 RQ 设计实验。

1. 定义 treatment、baseline、控制变量和数据切分。
2. 设计最小但足以回答 RQ 的实验矩阵，避免无目的地枚举组合。
3. 为每个指标定义计算方式、方向、最低可接受阈值和人工评审规则。
4. 记录随机性、重复次数、失败处理、停止条件和资源预算。
5. 输出 Experiment Protocol Artifact，等待用户批准后再执行。
```

## 阶段产物

```markdown
## Research Question
## Experimental Units
## Methods and Baselines
## Experiment Matrix
## Metrics and Rubric
## Data and Sampling
## Reproducibility Controls
## Failure and Stop Conditions
## Execution Checklist
## Stage Decision
```

## 完成门槛

- [ ] 每个实验单元都对应主 RQ 或子问题
- [ ] 指标定义可计算或可按 rubric 复核
- [ ] baseline、控制变量和样本选择明确
- [ ] 失败与停止条件明确
- [ ] 用户批准协议后才进入 Experiment 09
