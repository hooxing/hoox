# 品牌资产

本文面向修改工作台、管理台、站点图标和对外材料的开发者与维护者，说明 Hoox
品牌资产的当前真源、使用场景和必须保持的图形关系。

## 资产真源与衍生关系

品牌 PNG 统一位于 `runtime-ts/public/brand/`。Web 与 Admin Web 的 Vite 配置将
`runtime-ts/public/` 作为共享静态目录，组件基于各自 `BASE_URL` 生成
`brand/<文件名>` 地址；应用不得在各自目录复制或派生另一套品牌文件。

| 源文件 | 画布 | 用途 |
| --- | --- | --- |
| `hoox-primary-horizontal.png` | 1916 × 821，暖白底 | README、浅色背景的完整横版标识 |
| `hoox-symbol.png` | 1254 × 1254，暖白底 | 不需要文字的独立黑绿标志 |
| `hoox-app-icon.png` | 1254 × 1254，深色底 | 账号入口、Admin Web 和固定尺寸图标的生成输入 |
| `hoox-reversed-horizontal.png` | 1925 × 817，深色底 | 深色背景的单色反白横版标识 |

四个源文件是高分辨率 RGB PNG，不是可无损缩放的 SVG。它们保持原路径与像素不变，并作为以下
栅格衍生物的构图和像素输入：

| 衍生文件 | 画布与模式 | 当前用途 |
| --- | --- | --- |
| `hoox-horizontal-transparent.png` | 1916 × 821，RGBA | Web 侧栏、内容空状态及浅色或自定义背景的完整横版 |
| `hoox-symbol-transparent.png` | 1254 × 1254，RGBA | 不需要文字的透明独立标志 |
| `hoox-monochrome-black.png` | 1916 × 821，RGBA | 浅色背景单色横版 |
| `hoox-monochrome-white.png` | 1916 × 821，RGBA | 深色背景单色横版 |
| `favicon-16.png`、`favicon-32.png`、`favicon-48.png` | 对应固定尺寸，RGB | Web 与 Admin Web 浏览器入口 |
| `apple-touch-icon-180.png` | 180 × 180，RGB | Apple Touch Icon |
| `pwa-icon-192.png`、`pwa-icon-512.png` | 对应固定尺寸，RGB | Web PWA 普通图标 |
| `pwa-icon-maskable-512.png` | 512 × 512，RGB | Web PWA Maskable 图标 |
| `hoox-open-graph.png` | 1200 × 630，RGB 纸白画布 | Open Graph 横版图 |

Web 与 Admin Web 使用目标尺寸 favicon 和 Apple Touch 文件，不再让浏览器实时缩放 1254px
源图。Web 的 `manifest.webmanifest` 引用 192/512px 与 Maskable 图标。账号入口与 Admin Web
侧栏仍使用深色底 App 图标；Web 会话侧栏和内容空状态使用透明横版，同一视口不再额外拼接文字版
Hoox 与标语。完整横版不得压缩成 favicon 或固定小尺寸入口图标。

透明资产从暖白底估算 Alpha，并按背景混色方程恢复抗锯齿前景，不能用单一色键重新生成。单色
资产沿透明横版 Alpha mask 着纯黑或纯白。小尺寸图标从 App 图标按目标尺寸分别缩放和锐化；
Maskable 前景必须位于中心 80% 安全圆内。当前 PWA 512px 与 Maskable 文件像素相同，但承担
不同 manifest 语义，不能合并路径。

当前栅格衍生物的公开契约由
[固定品牌栅格衍生资产与入口尺寸](../decisions/20260901110046-raster-brand-derivative-contract.md)
记录。生成过程可追溯到上述源文件和像素算法，但仓库尚未固化跨平台、固定 PNG 编码参数的生成器；
在生成器通过现有像素契约前，不得批量覆盖衍生文件。

## 矢量审阅资产

以下 SVG 是依据现有 PNG 手工重建的几何审阅候选，不嵌入栅格、字体或可视文字轮廓。它们使用少量
`path` 和 `use` 元素表达双钩、字标和断笔关系，并采用 UI 方案中的碳黑 `#19191A` 与翡翠绿
`#177654`：

| 文件 | 画布 | 审阅用途 |
| --- | --- | --- |
| `hoox-symbol.svg` | `0 0 1254 1254` | 透明背景彩色独立标志 |
| `hoox-horizontal.svg` | `0 0 1916 821` | 透明背景彩色横版标识 |
| `hoox-horizontal-reversed.svg` | `0 0 1925 817` | 透明背景纯白横版标识 |
| `hoox-horizontal-black.svg` | `0 0 1925 817` | 与反白版同几何的透明背景碳黑横版标识 |
| `hoox-symbol-monochrome.svg` | `0 0 1254 1254` | 透明背景碳黑独立标志 |

这些文件当前只用于几何和视觉审阅，Web、Admin Web、README、favicon、PWA 与 Open Graph 仍引用
既有 PNG。品牌方接受双钩线宽与圆角、两个 `O` 的相向水平开口以及 `X` 的真实断笔后，才能通过
[手工几何重建品牌矢量候选](../decisions/20260901114930-hand-rebuilt-brand-vector-candidates.md)
把它们提升为正式矢量真源并切换应用引用。

## 图形不变量

- 黑绿双钩通过负空间形成 `H`，两侧线宽、圆角和对角咬合关系必须保持。
- 字标的两个 `O` 开口相向：第一个 `O` 仅右侧开口，第二个 `O` 仅左侧开口。
- `X` 的左上到右下笔画连续位于上层；左下到右上笔画在交汇处真正断开，不使用覆盖在完整 `X` 上的白色装饰线模拟断口。
- 小尺寸图标必须保持清楚轮廓；不得新增机器人、脑、电路、聊天气泡、立方体或其他 Provider 专属图形。

## 更新规则

更换品牌资产时应一次性检查四个源文件、十二个衍生文件、两个 Vite 构建、Web 与 Admin
favicon、Apple Touch、PWA manifest、Web 透明横版侧栏与空状态，以及账号和 Admin App 图标引用。资产文件名
属于当前静态接口；如需改名，必须同步修改 HTML、manifest、组件、测试和本文。设计过程文件、
截图标注和生成器临时输出不得进入品牌真源目录。当前五个 SVG 仍是审阅候选；只有在原始矢量交付
或手工几何复核通过后才能认定为正式真源，不得把自动描摹结果声明为真源。
