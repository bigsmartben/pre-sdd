# 快速开始

## 1. 安装

```bash
uv tool install git+https://github.com/bigsmartben/pre-sdd.git
```

## 2. 初始化目标目录

```bash
mkdir my-design
cd my-design
sdd-pre init .
```

目录必须已经存在，且不能是文件或符号链接。若目录中已有与模板冲突的顶层路径，初始化会拒绝写入；发生复制或提交失败时会回滚，不留下半成品。

## 3. 明确开始当前领域

初始化工作区不会自动开始 Product Design（产品设计）、MockCase 或 Architecture Design（架构设计）。请直接用自然语言告诉本地 Agent 当前目标，例如：

- “我想做一个家庭账本，请开始产品设计并梳理 Use Cases（用例）。”
- “先不做产品设计，独立开始架构设计。”
- “只分析现有用例的 MockCase，先不要写文件。”

Agent 只处理明确请求的当前产物，不会自动扩展到其他阶段、发布或下游实现。它会读取 `psp.project.yaml` 和对应的 Domain Skill（领域技能），在后台完成初始化、原子写入、投影和验证；你不需要运行项目内部命令。

## 4. 完成产品与视觉交付

产品设计从 `01-product-design/` 开始，先建立 Product Use Cases 和 Functional Delivery Baseline（功能交付基线）。可以按以下顺序继续与 Agent 对话：

1. “根据这些产品想法整理 Use Cases，并记录尚未确定的信息。”
2. “把当前功能逐项声明为 VISUAL（视觉）或 USER_PATH（用户路径）。”
3. “如果存在 USER_PATH，先建立 Test Case Catalog（测试用例目录）；再生成 Visual Spec Checklist（视觉规格清单）。”
4. “把清单绑定到这份 Figma 设计证据，并列出缺失项。”
5. “为 USER_PATH 生成 User Path Plan（用户路径计划）和 Mock Fixture（固定测试数据），然后在唯一 `lib/ui/**` 中实现 Flutter L1 和所需 L2。”
6. “在 Android 上构建并打开真实 Flutter UI Preview；我验收后生成 UI-SPEC-MANIFEST。”

`VISUAL` 要求 Flutter L1 覆盖视觉项；`USER_PATH` 同时包含 L1 和 L2，并且还需要 Test Case Catalog（测试用例目录）、User Path Plan（用户路径计划）与 Mock Fixture（固定测试数据）。只有 Functional Delivery Baseline 声明了 `USER_PATH`，Agent 才会进入这些额外步骤。

完整主链为：

`Product Use Cases → Functional Delivery Baseline → Optional Test Case Catalog → Visual Spec Checklist → Figma Evidence → Flutter L1 → Optional Flutter L2 → Flutter UI Preview(target) → Human Acceptance → UI-SPEC-MANIFEST`

Preview 必须显式选择 `android | ios | web`，不得根据本机环境猜测。人类只验收所选目标；Review/Test 可以使用 Mock，但所有模式共享同一份 `lib/ui/**`，最终 Manifest 锁定源码、依赖、Asset、Font、Token、Motion、Coverage、Preview 与 Finding 闭包。

## 5. 工作区生命周期

Product Design、MockCase 与 Architecture Design 的生命周期彼此独立。生成后的工作区不兼容旧视觉载体，也不提供更新、升级、同步、迁移、双读或回退；重新安装或更新全局工具只影响未来创建的工作区。
