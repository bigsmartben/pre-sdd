# pre-sdd 快速操作（Quickstart）

本文采用使用者视角（User View）。每轮只做一个任务，确认后再继续。

## 0. 安装与初始化

### 会改变状态的公共操作只有三项

| 操作 | 命令 |
|---|---|
| 安装 / 更新 | `npm install --global git+https://github.com/bigsmartben/pre-sdd.git` |
| 创建工作区 | `pre-sdd init .` |

```bash
mkdir my-product && cd my-product
git init
pre-sdd init .
```

确认存在 `01-product-design` 和 `02-architecture-design`。文件存在不等于任务完成。

## 1. 产品设计 SOP

### 1.1 Use Cases（用例）

```text
请根据以下信息开始 Use Cases。
产品名称：反馈管家。
产品想法：为小型团队按项目汇总、去重并跟踪客户反馈。
本轮只完成用例，不要开始页面流程或架构设计。
```

评审 `01-product-design/UC.md` 和 `01-product-design/PSP.md`；只要求修改 Use Cases，不单独编辑 `PSP.md`。

### 1.2 Wireflow（页面流程）

```text
请根据已确认的 Use Cases 开始 Wireflow。
覆盖入口、正常流程、空状态、失败状态、恢复和返回路径。
本轮只完成页面流程，不要开始界面原型。
```

评审 `01-product-design/wireflow-mid.md`，确认页面、操作、状态和跳转。

### 1.3 没有 Figma：生成 UI HTML

```text
请根据已确认的 Wireflow 开始 Canonical UI Prototype。
运行环境：电脑网页；本轮不做其他版本。
```

页面可运行后，智能代理必须立即启动 HTTP 服务、验证并提供 UI HTML 地址；严格检查继续执行，未通过项不能阻塞地址。

## 2. 按 Figma 实现 UI HTML

先提供：Figma 链接与 Frame、Team / Project、副本名、页面范围、运行环境、视觉目标和权限。

技能顺序：`product-design`、`apply-repository-harness` → `organize-figma-assets` → `figma-component-from-design` → `capture-figma-design-source` → `implement-figma-lit-page` → `repair-canonical-ui-visual`。

### 2.1 创建 Figma 副本

Duplicate 原稿，移动到目标 Team / Project，命名为“产品名 + UI Rebuild”；原稿保持只读。

```text
原稿：<链接>，只读。副本：<Team / Project / 名称>。
范围：项目列表、反馈详情。环境：电脑网页。目标：完全还原。
请确认范围和视觉策略；不要修改原稿或开始写代码。
```

### 2.2 按页面和组件重建结构

```text
请使用 organize-figma-assets 盘点页面、状态、Instance、已有组件和 Export/ 资源。
先给修改清单，确认后再整理命名、图层和 Auto Layout；不要创建组件、Variant 或变量。
```

需要新组件时：

```text
请使用 figma-component-from-design 提出共享组件、属性、Variant、变量、Slot 和 Event。
等我确认后再写入 Figma；不要开始采集或实现。
```

确认每个状态有独立 Frame，组件可切换，动态内容未导出为图片，整理前后视觉一致。

### 2.3 冻结节点

```text
我确认页面和组件结构。
请列出每个页面、状态和共享组件的最终 node-id 链接并冻结。
不要再修改图层、组件、Variant 或变量。
```

### 2.4 采集并登记来源

```text
请使用 capture-figma-design-source 采集冻结节点的截图、布局、字体、颜色、变量、组件和资源。
校验 Export/ 资源，再交回 product-design 登记来源、资源、组件映射和 Variant 覆盖；不要修改 Figma 或开始实现。
```

Figma 再次写入后，必须重新执行 2.3 和 2.4。

### 2.5 每个页面一个实现任务

规则：一次只实现一个页面、状态和必要组件；未提供当前 UI HTML 地址前不得开始下一页。

```text
请使用 implement-figma-lit-page。
本任务只实现电脑网页的“项目列表”页面及已确认状态。
使用已登记的最终 Figma 证据；先实现共享 Lit 组件，再组装页面。
不要实现反馈详情、手机、平板或其他页面。
页面可运行后立即验证并提供实际 UI HTML 地址，不要等待视觉修复或正式就绪。
```

执行循环：

```text
实现单页 → 提供地址 → 用户巡检 → 标记反馈 → 修改并返回地址
→ 用户结束当前页 → 用户指定下一页
```

### 2.6 打开地址巡检

1. 打开智能代理提供的实际 HTTP 地址。
2. 按 Wireflow 点击、输入、返回和恢复。
3. 检查默认、加载、空、失败和成功状态。
4. 对照 Figma 检查位置、尺寸、文字、字体、颜色和资源。
5. 发现问题后进入 2.7。

普通地址显示不一致标记工具；干净预览使用 `?annotate=0`。

### 2.7 标记反馈并迭代

点击“开始框选”，每次框一个问题；选择问题类型，复制截图（失败时下载 PNG），再发送：

```text
页面/状态：项目列表/空状态。
操作：使用空数据打开页面。
实际：插画比 Figma 向下约 12px。
预期：与冻结节点一致。
请只修复框选区域，完成后重新检查并提供当前 UI HTML 地址。
```

视觉 Repair Packet 使用 `repair-canonical-ui-visual`；文字、状态或交互问题交给 `product-design`。Figma 需要修改时回到 2.2；来源过期时回到 2.3。

当前页面通过后发送：

```text
当前页面、状态和交互已确认。结束当前任务，不要自动开始其他页面或设备。
```

## 3. 架构设计 SOP

架构设计只需要已经确认并检查通过的 Use Cases，不要求先完成 Wireflow 或 UI HTML。

```text
请根据已确认的 Use Cases 开始 Architecture Design。
依次完成系统边界、概念模型、必要技术验证和架构总览。
信息不足时列出缺口，不要修改产品设计。
本轮只完成架构设计，不要开始开发。
```

依次评审：`02-architecture-design/系统边界.md` → `概念建模.md` → `技术验证/README.md` → `README.md`。

## 4. 异常处理

| 情况 | 操作 |
|---|---|
| 上一步未通过 | 修正缺口，重检当前步骤 |
| Figma 冻结后有写入 | 重新冻结并采集来源 |
| 地址打不开 | 要求重启服务并提供实际地址 |
| 页面可运行但严格检查失败 | 保留地址，将失败项继续迭代 |
| 安装或初始化失败 | 保留完整错误，不要手工补写文件 |
