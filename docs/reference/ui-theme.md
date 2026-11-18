# UI 主题 Token

本文面向迁移或新增 Hoox Web、Admin Web 界面的开发者，说明当前共享主题的事实源、语义角色、
消费方式和已经完成的迁移边界。实施顺序见
[Hoox UI 重构实施计划](../plans/20260901-hoox-ui-refactor.md)，
品牌与操作颜色职责见
[品牌资产](brand-assets.md)。

## 当前事实源

`runtime-ts/packages/ui-theme/theme.css` 是 Light 主题原始刻度与语义映射的唯一事实源。
`@hoox/ui-theme/theme.css` 不包含业务组件或领域状态。Web 与 Admin Web 都在本地应用样式前导入它，
因此应用样式可以引用同一组 CSS 自定义属性。

共享层拥有：

- 暖中性色阶、单一品牌绿、三态操作色和信息、成功、警告、错误色阶；
- `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64px` 间距刻度；
- 固定字号、400/600 字重和 UI/等宽字体栈；
- 圆角、三档阴影、透明度和动效时长；
- 表面、文字、边框、操作、焦点与状态语义角色。

应用层继续拥有业务组件、路由、布局组合和领域状态机。共享主题不得读取账号、Tenant、Thread、
Run 或请求级数据。

## 消费规则

功能样式应引用语义角色：

```css
.primary-action {
  color: var(--action-primary-text);
  background: var(--action-primary);
}

.form-control {
  border: 1px solid var(--border-strong);
  color: var(--text-primary);
  background: var(--surface-raised);
}
```

`--brand-green`、`--neutral-*` 与状态原始色阶只在主题映射和明确的品牌资产或装饰中使用。品牌绿
只承担 Logo、favicon、品牌图和经过审阅的签名式强调，不映射主要操作、选中态、焦点或状态。功能
组件不得在运行期调用 `lighten()`、`darken()` 或无约束的 `color-mix()` 生成近似色。装饰分隔线使用
`--border-subtle`，依靠轮廓识别的输入框、复选框和类似控件使用 `--border-strong`。

主要操作使用固定低饱和深灰绿三态，选中态使用暖中性色，键盘焦点使用信息色。禁用、错误、成功和
运行中状态不能只改变颜色。控件应同时提供图形、文案、形状或禁用语义；
禁用主要操作使用专用背景与文字 Token，不对整个按钮统一降低透明度。键盘焦点使用
`--focus-color` 与 `--focus-ring`，不得移除可见 Focus 后不提供替代。

## 当前迁移边界

Web 已迁移侧栏、顶栏、导航、通用按钮、Composer、运行状态徽标和主要页面表面。对话正文、功能
中心、登录入口和部分浮层仍保留旧样式，迁移时不得让其字面量覆盖已迁移外壳的语义角色。

Admin Web 已加载共享主题，现有 Ant Design `ConfigProvider` 和管理页局部样式尚未完成语义映射；
管理台当前外观仍以应用代码为准。暗色模式尚未实现，消费者不得假定存在 Dark 映射。

## 验证

`runtime-ts/packages/ui-theme/theme.test.ts` 从实际 CSS 解析颜色，校验必需角色、普通文字和状态文字
至少 4.5:1、功能边框至少 3:1。应用切片还必须运行受影响包测试、Typecheck 和 Vite 构建，并在
关键页面补充 1440px、1024px、390px 与 320px 的视觉检查。
