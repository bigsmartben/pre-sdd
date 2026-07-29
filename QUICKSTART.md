# 快速开始

## 1. 安装

```bash
uv tool install git+https://github.com/bigsmartben/pre-sdd.git
```

## 2. 初始化一个空目录

```bash
mkdir my-design
cd my-design
sdd-pre init .
```

目录必须已经存在，且不能是文件或符号链接。若目录中已有与模板冲突的顶层路径，初始化会拒绝写入。

## 3. 与 Agent 对话

例如：

- “我想做一个家庭账本，请先开始产品设计并梳理用例。”
- “先不做产品设计，独立开始架构设计。”
- “分析现有用例的 MockCase，但先不要写文件。”

Agent 会在后台选择领域 Skill、写入相应产物并执行验证。你不需要运行项目内部脚本。
