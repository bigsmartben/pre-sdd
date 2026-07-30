# Figma + UC 到 Mapping 的输入责任

| 输入 | 只拥有 | 不拥有 | 示例 |
|---|---|---|---|
| UC | Actor、目标、规则、主/备选/异常流程、业务结果 | 颜色、布局、组件视觉状态 | “提交失败后允许重试” |
| Figma Acquisition Packet | 节点、组件、Variant、布局、视觉属性、Asset、来源版本 | 业务结果、权限、重试规则 | `Busy` Variant 只是候选 Component State |
| 用户澄清 | 消解 Figma 与 UC 的歧义 | 源码路径或内部任务排序 | 确认 `Busy` 表示提交中的组件反馈 |
| `Mapping.html` | 可感知概念、关系、来源、gap 和精确确认 | 类名、Lit Tag、函数、DOM Selector | `COMPONENT-PAY` 发出“请求支付”语义事件 |
| `src/ui/` | 真实 Lit/TypeScript 实现 | Figma 审计与用户确认生命周期 | `pay-button.ts` 定义 Property 与 CustomEvent |

所有问题必须绑定稳定 `conceptId`。来源或 Mapping 内容变化后，旧确认失效并回到澄清。
