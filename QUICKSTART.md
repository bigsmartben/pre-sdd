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

### Harness Standard v3 的三个不同结论

| 结论 | 含义 | 例子 |
|---|---|---|
| 工程检查通过（Validation PASS） | 当前 Profile（配置档）登记的检查已通过 | PR checkpoint 通过，但不会自动发布 |
| 用户允许推进（Handoff confirmed） | 用户看过固定来源、检查结果与风险，并允许指定消费者使用该版本 | 确认 Use Cases → Visual Spec 的 Handoff Receipt（移交收据） |
| 允许发布（Release credential） | 显式 Release 工作流的全仓门禁通过 | 形成 `validated-scaffold-change`，仍不自动打标签或发布 |

Handoff 只在用户明确请求后运行 preflight（预检）。预检会展示来源版本、内容哈希、验证结果、风险和确认 token；用户随后明确确认或拒绝。确认生成的 Receipt 始终记录 `downstreamAction: NOT_RUN`，不会初始化、修改或执行下游。例如：

```text
请预检 Use Cases 到 Visual Spec 的 Handoff，只展示结果和风险，不执行下游。
```

查看预检后再单独确认；若要接受某项领域风险，必须逐项说清楚。结构或安全 blocker（阻断项）不能通过确认绕过。

## 1. 产品设计 SOP

### 1.1 Use Cases（用例）

```text
请根据以下信息开始 Use Cases。
产品名称：反馈管家。
产品想法：为小型团队按项目汇总、去重并跟踪客户反馈。
本轮只完成原子用例：产品行为、正式 Interaction Flow 和内部 Low-Fi UI Blueprint；不要开始 UI HTML 或架构设计。
```

评审 `01-product-design/UC.md`：逐个确认主场景、备选/异常场景、用户动作、系统响应、失败/重试/恢复/返回，以及 Low-Fi 页面建议。Low-Fi 只作内部参考，不约束最终 UI HTML 的页面组织或像素布局。

### 1.2 建立 Visual Spec（视觉规格）

```text
请根据已确认的 Use Cases 建立 provider-neutral Visual Spec。
运行环境：电脑网页；本轮不做其他版本。
请明确页面、每个视口与正式状态的渲染、布局尺寸与间距、排版、颜色与效果、组件状态与 Variant，以及每个资源的路径、来源版本、用途和 SHA-256。
本轮不要生成 UI HTML。
```

评审 `01-product-design/Visual-Spec.md`。无论输入来自 Figma、Design System、资源文件还是文字确认，正式产物都使用相同结构；缺少 Use Cases 或正式状态时必须阻断，不能由视觉规格补写产品行为。

### 1.3 没有 Figma：生成 UI HTML

```text
请根据已确认的 Use Cases、正式 Interaction Flow 和已就绪 Visual Spec 开始 Canonical UI Prototype。Low-Fi UI Blueprint 仅作内部建议，可按可用性重组页面；视觉细节以 Visual Spec 为准。
运行环境：电脑网页；本轮不做其他版本。
```

每个参与者对应 `Canonical-UI-Prototypes/<ACTOR-ID>/` 中一个完全独立的 UI 应用。页面可运行后，智能代理必须启动该参与者的 HTTP 服务、验证并提供 UI HTML 地址；严格检查继续执行，未通过项不能阻塞地址。

## 2. 按 Figma 实现 UI HTML

先提供：Figma 链接与 Frame、Team / Project、副本名、页面范围、运行环境、视觉目标和权限。

技能顺序：`product-design`、`apply-repository-harness` → `organize-figma-assets` → `figma-component-from-design` → `capture-figma-design-source` → `implement-figma-lit-page` → `repair-canonical-ui`。

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
2. 按正式 Interaction Flow 点击、输入、返回和恢复。
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

HTML、CSS、Lit、组件渲染或来源视觉 Repair Packet 使用 `repair-canonical-ui`；业务状态或交互逻辑问题交给 `product-design`。Figma 需要修改时回到 2.2；来源过期时回到 2.3。

当前页面通过后发送：

```text
当前页面、状态和交互已确认。结束当前任务，不要自动开始其他页面或设备。
```

## 3. 架构设计 SOP

架构设计拥有独立生命周期，不要求先初始化、完成或发布 Product Design，也不要求 UI HTML。默认使用 Architecture 本地输入；如果希望复用 Use Cases，必须在 Architecture Package 中选择 `reference` 模式并固定只读版本。

```text
请独立开始 Architecture Design，使用我在本轮提供的架构输入。
依次完成系统边界、概念模型、必要技术验证和架构总览。
Architecture Package 使用 productDesignInput.mode: independent。
信息不足时列出 Architecture gap，不要读取或修改产品设计。
本轮只完成架构设计，不要开始开发。
```

需要复用现有 Use Cases 时，可改为：

```text
请开始 Architecture Design，并只读引用 Product Design capabilities 版本 1.2.3。
Architecture Package 使用 productDesignInput.mode: reference，记录 artifact、固定版本和 access: read-only。
不要执行 Product Design readiness、handoff、发布或状态转换；版本不匹配时只报告引用阻断。
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
