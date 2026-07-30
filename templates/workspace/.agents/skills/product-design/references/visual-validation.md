# Lit UI 视觉与运行验收

1. 在实现前确认 `Mapping.html` 已绑定当前 Figma、UC 和 Mapping 内容哈希。
2. 在操作系统临时工作区从 `src/ui/main.ts` 直接构建 UIHTML。
3. 对确认的每个 Figma 节点和 Viewport（视口）执行截图比较，记录差异比例和阈值。
4. 执行已确认 Route、Event 与 State 分支；验证 Motion（动效）的时序、打断和 reduced-motion（减少动效）降级。
5. 独立构建 Review Tools；工具未加载或抛错时，产品入口仍须正常运行。
6. 改动 Review、Mock 或 Case 后重新计算产品哈希；结果必须与改动前一致。
7. 扫描 UIHTML，禁止包含 Mapping、Review、Mock、Case 或集中运行模型。

具体例子：结算页确认需要 `1440×900` 视口、提交成功淡入且在减少动效时取消位移；验收报告必须同时记录 Figma 节点、视口、视觉差异、正常动效和降级结果。
