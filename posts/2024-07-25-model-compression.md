---
title: 模型轻量化入门：从剪枝到量化
date: 2024-07-25
category: 论文阅读
tags: [模型压缩, 量化]
summary: 一次读完模型轻量化的核心方法：结构化剪枝、权重量化与知识蒸馏，附常用工具清单。
---
## 为什么需要轻量化

边缘设备算力有限，模型直接部署太慢。**模型轻量化**就是在精度损失可控的前提下，让模型更小、更快。

## 三种核心方法

- **剪枝**：去掉不重要的权重/通道，稀疏化后压缩
- **量化**：FP32 → INT8，推理速度提升 3-4 倍
- **知识蒸馏**：大模型教小模型，小模型学到"暗知识"

## 常用工具

```python
# PyTorch 量化示例
model.qconfig = torch.quantization.get_default_qconfig('fbgemm')
q_model = torch.quantization.prepare(model, inplace=True)
q_model = torch.quantization.convert(q_model, inplace=True)
```

> 实践建议：先量化再剪枝，精度恢复更容易。
