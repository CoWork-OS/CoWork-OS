# Production（生成 · 验证 · 排错）

这份文档覆盖 kami 的工程执行：从 HTML / Node 幻灯片模板到 PDF / PPTX 成品的完整流程。分四部分：**HTML -> PDF** · **Node -> PPTX/PDF** · **验证与调试** · **15 条踩坑**。

---

## Part 1 · HTML -> PDF（WeasyPrint）

### 安装

```bash
pip install weasyprint pypdf --break-system-packages --quiet
```

Linux 初次使用可能需要：

```bash
apt install -y libpango-1.0-0 libpangoft2-1.0-0 fonts-noto-cjk
```

### 生成

```python
from weasyprint import HTML
HTML('doc.html').write_pdf('output.pdf')
```

**CWD 很重要**：HTML 里 `@font-face { src: url("xxx.ttf") }` 使用相对路径，必须在**字体文件所在目录**执行。

```bash
cd /path/to/html-and-font
python3 -c "from weasyprint import HTML; HTML('doc.html').write_pdf('out.pdf')"
```

### 字体处理

**最稳的方式**：字体文件和 HTML 同目录，`@font-face` 用相对路径。

```html
<style>
  @font-face {
    font-family: "TsangerJinKai02";
    src: url("TsangerJinKai02-W04.ttf");
  }
  body {
    font-family: "TsangerJinKai02", serif;
  }
</style>
```

**商业字体不可得时**，fallback 链已内嵌在所有模板中：

```css
font-family:
  "TsangerJinKai02", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Georgia, serif;
```

**字体 fallback 影响页数**：换字体必须重新跑页数验证。溢出时优先调 `font-size`，再调 margin，最后砍内容。

### 页面规格

```css
@page {
  size: A4; /* 或 210mm 297mm / A4 landscape / 13in 10in */
  margin: 20mm 22mm;
  background: #f5f4ed; /* 背景延伸到 margin 外，避免打印白边 */
}
```

### 页眉页脚

```css
@page {
  @top-right {
    content: counter(page);
    font-family: serif;
    font-size: 9pt;
    color: #87867f;
  }
  @bottom-center {
    content: "{{文档名}} · {{作者}}";
    font-size: 8.5pt;
    color: #87867f;
  }
}

@page:first {
  @top-right {
    content: "";
  }
  @bottom-center {
    content: "";
  }
}
```

### WeasyPrint 支持矩阵

| 支持良好                               | 支持有限                       | 不支持                |
| -------------------------------------- | ------------------------------ | --------------------- |
| CSS Grid / Flexbox                     | CSS filter / transform（部分） | JavaScript            |
| `@page` 规则                           | inline SVG（部分属性）         | `position: sticky`    |
| `@font-face`                           | gradient（性能差，少用）       | CSS 动画 / transition |
| `break-before` / `break-inside: avoid` |                                |                       |
| CSS 变量 `var(--name)`                 |                                |                       |
| 伪元素 `::before` `::after`            |                                |                       |

---

## Part 2 · Node -> PPTX/PDF（`pptxgenjs` + Playwright）

幻灯片现在走内置 Node 运行时，不再依赖 `python-pptx`。源文件是声明式 `.mjs`，由 `scripts/render_slides.mjs` 统一生成 PPTX，并在可用时生成 PDF。

### 运行时

PPTX 使用内置的 `pptxgenjs` 依赖。在本地开发环境里，这来自：

```bash
npm install
```

幻灯片 PDF 所需：

- 运行时内可用的 `playwright`
- 本机 Chromium 系浏览器可执行文件（Chrome、Chromium、Edge 或 Brave）

检查当前机器：

```bash
bash resources/skills/kami/scripts/setup.sh
node resources/skills/kami/scripts/render_slides.mjs --check
```

### 尺寸

- **16:9 宽屏**（推荐）：13.33 × 7.5 inch
- **4:3 传统**：10 × 7.5 inch
- **安全区**：四周 0.5 inch 不放内容，底部额外 0.3 inch 给页码

### 色板（1:1 对应 design.md）

```js
const theme = {
  parchment: "#f5f4ed",
  ivory: "#faf9f5",
  brand: "#1B365D",
  text: "#141413",
  darkWarm: "#3d3d3a",
  olive: "#5e5d59",
  stone: "#87867f",
  border: "#e8e6dc",
  tagBg: "#eef2f7",
};
```

### 字号（屏幕投影优先易读性，比 PDF 大）

| 角色      | 字号 | 字体      |
| --------- | ---- | --------- |
| Title     | 44pt | Serif 500 |
| Subtitle  | 24pt | Sans 400  |
| H2 章节   | 32pt | Serif 500 |
| H3 小标题 | 20pt | Serif 500 |
| Body      | 18pt | Sans 400  |
| Caption   | 14pt | Sans 400  |
| Footer    | 12pt | Sans 400  |

中文字体栈：

- Serif：`TsangerJinKai02` -> `Source Han Serif SC` -> `宋体`
- Sans：`Source Han Sans SC` -> `PingFang SC` -> `微软雅黑`

### 8 种标准版式

1. **封面页**：Parchment 底，正中大标题 + 品牌色短线 + 副标题/作者/日期
2. **目录页**：Parchment 底，左对齐 `01　章节标题`（数字 serif 品牌色）
3. **章节首页**：油墨蓝 `#1B365D` 满屏，居中白色大字--deck 里唯一的彩色满屏
4. **内容页**：小标题（sans stone）+ 核心论点（serif near-black）+ 品牌色短线 + 正文（sans dark-warm）
5. **数据页**：顶部 takeaway + 下方 2-4 张 metric 卡（大数字 serif 品牌色 + 小标签 sans olive）
6. **对比页**：左右两栏 + 中间 0.5pt 暖灰竖线
7. **引用页**：Parchment 底极简，居中大号 serif 引文 + `- 来源`
8. **结束页**：Parchment 底，居中"谢谢 / Q&A / 联系方式"

### 源文件模型

完整示例见 `assets/templates/slides.mjs` / `slides-en.mjs`。核心结构：

```js
export default {
  metadata: {
    title: "示例 deck",
    author: "CoWork OS",
  },
  theme: {
    parchment: "#f5f4ed",
    brand: "#1B365D",
    serif: "Source Han Serif SC",
    sans: "Source Han Sans SC",
  },
  slides: [
    {
      kind: "cover",
      title: "示例 deck",
      subtitle: "克制的 editorial 幻灯片系统",
    },
    {
      kind: "content",
      eyebrow: "问题",
      title: "当前流程仍然碎片化。",
      points: ["团队在文档、表格和聊天之间反复切换。", "状态同步吃掉了本应投入执行的时间。"],
    },
  ],
};
```

当前内置渲染器支持的 slide kind：

- `cover`
- `toc`
- `chapter`
- `content`
- `metrics`
- `quote`
- `ending`

### 生成

```bash
node resources/skills/kami/scripts/render_slides.mjs \
  --source path/to/slides.mjs \
  --output-dir path/to/outputs \
  --format pptx
```

同时生成 PPTX 和 PDF：

```bash
node resources/skills/kami/scripts/render_slides.mjs \
  --source path/to/slides.mjs \
  --output-dir path/to/outputs \
  --format both
```

### 幻灯片注意事项

1. **一页一个核心信息**：超过 3 段文字就拆分
2. **不用自带 Template**：PowerPoint default 是冷蓝灰，和 parchment 冲突
3. **动画**：不加。Parchment 风格是印刷品，不是 SaaS 演示。最多允许 fade
4. **PDF 由同一份 slide source 直接生成**，不再依赖 LibreOffice 把 `.pptx` 二次转换。`render_slides.mjs` 会先写出 HTML，再用 Chromium print-to-PDF，所以 PPTX 和 PDF 来自同一份内容模型。

---

## Part 3 · 验证与调试

### 必跑三步（每次改动）

```bash
# 1. 生成
python3 -c "from weasyprint import HTML; HTML('doc.html').write_pdf('out.pdf')"

# 2. 页数
python3 -c "from pypdf import PdfReader; print(len(PdfReader('out.pdf').pages))"

# 3. 视觉检查（怀疑视觉问题时）
pdftoppm -png -r 300 out.pdf inspect
```

**不验证不算改完**。

### 字体是否加载成功

```bash
pdffonts output.pdf
```

输出里如果看到 `DejaVuSerif` / `Bitstream Vera`，说明指定字体没生效，走到了系统兜底。正确应该看到 `TsangerJinKai02` 或 `Source Han Serif SC`。

### 一键生成 + 验证脚本

```python
#!/usr/bin/env python3
"""生成并验证 PDF"""
import sys
from weasyprint import HTML
from pypdf import PdfReader

html_file = sys.argv[1] if len(sys.argv) > 1 else 'doc.html'
pdf_file  = sys.argv[2] if len(sys.argv) > 2 else 'output.pdf'
max_pages = int(sys.argv[3]) if len(sys.argv) > 3 else 0

HTML(html_file).write_pdf(pdf_file)
n = len(PdfReader(pdf_file).pages)
print(f'✓ {pdf_file}, {n} pages')

if max_pages and n > max_pages:
    print(f'✗ Exceeded limit ({n} > {max_pages})')
    sys.exit(1)
```

项目脚本 `scripts/build.py` 是这段的产品化版本。

### 高分辨率视觉检查

```bash
pdftoppm -png -r 160 output.pdf preview         # 标准
pdftoppm -png -r 300 output.pdf preview         # 排查细节 bug
pdftoppm -png -r 400 output.pdf preview         # 极致细节（tag 双层等）
```

### 生成多版本

```python
for variant, vars_css in [
    ('light', '--bg: #f5f4ed;'),
    ('dark',  '--bg: #141413;'),
]:
    custom = base.replace('{{VARS}}', f':root {{ {vars_css} }}')
    HTML(string=custom).write_pdf(f'out-{variant}.pdf')
```

---

## Part 4 · 15 条踩坑

每一条都是真实踩出来的。遇到视觉异常立刻来这里查。

### 1. Tag / Badge 双层矩形 bug（最坑）

**症状**：PDF 放大看背景色 tag，出现内外两层矩形。手机预览器尤其明显。

**根因**：WeasyPrint 渲染 `rgba(..., 0.xx)` 时，**padding 区域**和**字形像素区域**分别做透明度计算，字形 anti-alias 让周围透明度叠加更深，形成视觉第二层。

**解法**：Tag 背景必须用实色 hex，禁用 rgba。

```css
/* ❌ */
.tag {
  background: rgba(201, 100, 66, 0.18);
}
/* ✅ */
.tag {
  background: #e4ecf5;
}
```

**rgba -> 实色对照表**（底 parchment `#f5f4ed` + 前景油墨蓝 `#1B365D`）：

| rgba 透明度 | 等效实色 hex         |
| ----------- | -------------------- |
| 0.08        | `#EEF2F7`            |
| 0.14        | `#E4ECF5`            |
| **0.18**    | **`#E4ECF5`** ← 默认 |
| 0.22        | `#D0DCE9`            |
| 0.30        | `#D6E1EE`            |

公式：`实色通道 = 底 + (前景 - 底) × 透明度`。其他底色要重算。

**如需"呼吸感"效果**：用 CSS linear-gradient，整张 tag 栅格化为位图，绕过逐像素合成：

```css
.tag {
  background: linear-gradient(to right, #d6e1ee, #e4ecf5 70%, #eef2f7);
}
```

**美学教训**：gradient 工程上可行，审美上往往**用力过猛**。优先级：极淡实色 `#EEF2F7` > 稍浓实色 `#E4ECF5` > 慎用 gradient。读者第一眼落在背景形状而非文字，就说明过度了。

### 2. 薄边框 + 圆角 = 双圈 bug

**症状**：`border: 0.4pt solid ...` + `border-radius: 2pt` 放大后两条平行线。

**根因**：WeasyPrint 对 < 1pt border + 圆角，分别 stroke 内外 path，薄宽度没法重合。

**解法**三选一：

1. 改用背景填充（首选，设计语言一致）
2. border ≥ 1pt
3. 去掉 border-radius

### 3. 2 页硬约束溢出

适用于 resume、one-pager 等页数受限的文档。

**常见诱因**：字体 fallback、新增内容、字号意外增大、line-height 从 1.4 -> 1.6。

**诊断**：`pdffonts output.pdf` 看实际加载字体。

**解法（按优先级）**：

1. 删冗余副词（"深入研究" -> "研究"）
2. 合并同义数据
3. 砍次要项
4. 减小 section 间距（慎用）
5. 最后手段：字号降 0.1-0.2pt

**不要**：砍掉封面/教育/Timeline 这类结构性内容，也不要删高亮，简历失去强调就没有生气了。

### 4. 字体 fallback 导致页数不一致

**症状**：本机 2 页，CI/服务器 4 页。

**根因**：字体文件没和 HTML 同目录/未系统安装。

**解法**：

```bash
# 把 .ttf 放 HTML 同目录
cp TsangerJinKai02-W04.ttf workspace/

# 或系统安装（Linux）
apt install fonts-noto-cjk
mkdir -p ~/.fonts && cp *.ttf ~/.fonts/ && fc-cache -f
```

### 5. 中英文紧贴

**症状**：`125.4k GitHub Stars` 看起来 k 和 G 太贴。

**错误解法**：手动加 `&nbsp;` / `margin-left: 2mm`（影响对齐）。

**正确解法**：独立 span + flex gap：

```html
<div class="metric">
  <span class="metric-value">125.4k</span>
  <span class="metric-label">GitHub Stars</span>
</div>
```

```css
.metric {
  display: flex;
  align-items: baseline;
  gap: 6pt;
}
```

### 6. 全角 vs 半角空格

- **中文之间**：全角空格 `　`（U+3000）+ `·` + 空格
- **英文之间**：半角空格 + `·` + 空格
- **中英混排**：flex gap 优先，不加空格

### 7. 千分位 · 百分号 · 箭头

| 正确     | 错误                            |
| -------- | ------------------------------- |
| `5,000+` | `5000+` / `5，000+`（全角逗号） |
| `90%`    | `90 %`（前有空格）              |
| `->`     | `->` / `-&gt;`                  |

自查：

```bash
grep -oE '->|->|⟶|⇒' doc.html | sort | uniq -c
grep -oE '[0-9]{4,}' doc.html | sort -u
```

### 8. 高亮过多 / 过少

- 一行 4-5 处蓝色强调，读者视线无处安放
- 整节没有高亮，版面一片扁平

**规则**：每行 ≤ 2 处，每节至少 1 处，只高亮**可量化的数字或独特表达**。

合理区间：文档总字数 ÷ 高亮数 ≈ 80-150 字/高亮。

### 9. `height: 100vh` 不工作

**症状**：想做满屏封面，`height: 100vh` 没效果。

**根因**：WeasyPrint 的 @page 语境下 viewport 单位不准。

**解法**：

```css
.cover {
  min-height: 257mm; /* A4 高 297 - 上下 margin 40 */
  display: flex;
  flex-direction: column;
  justify-content: center;
}
```

### 10. break-inside 在 flex 容器里失效

**解法**：给 flex item 额外包一层 block 容器：

```html
<div class="row">
  <div class="card-wrapper"><div class="card">...</div></div>
</div>
```

```css
.row {
  display: flex;
}
.card-wrapper {
  break-inside: avoid;
}
```

### 11. 首页不要页码

```css
@page:first {
  @top-right {
    content: "";
  }
}
```

### 12. 打印留白边

**症状**：打印四周有白边（即使 background 设置了）。

**根因**：默认 WeasyPrint 的 `@page background` 只延伸到 page 区域。

**解法**：

```css
@page {
  size: A4;
  margin: 20mm;
  background: #f5f4ed; /* 让背景延伸到 margin 外 */
}
```

### 13. 图片模糊

**症状**：PDF 里图片发虚。

**根因**：按原始像素渲染。A4 @ 300 dpi 需要 2480 × 3508 像素。

**解法**：嵌入图要用 2-3x 源。

### 14. 验证闭环（兜底）

```bash
python3 -c "from weasyprint import HTML; HTML('doc.html').write_pdf('out.pdf')"
python3 -c "from pypdf import PdfReader; print(len(PdfReader('out.pdf').pages))"
pdftoppm -png -r 300 out.pdf inspect    # 视觉怀疑时
```

**不验证不算改完**。

### 15. SVG marker `orient="auto"` 不生效

**症状**：SVG 里用 `<marker orient="auto">` 或 `orient="auto-start-reverse"` 的箭头，所有方向都指向右（marker 的默认绘制方向），不随路径切线旋转。

**根因**：WeasyPrint 的 SVG 渲染不支持 marker 的 `orient="auto"` 属性。Marker 永远按 0° 绘制。

**解法**：不用 `<marker>`，手动在每个箭头端点画 chevron `<path>`，方向写死。

```xml
<!-- ❌ marker 箭头：WeasyPrint 全部朝右 -->
<defs>
  <marker id="a" orient="auto" ...>
    <path d="M2 1L8 5L2 9" .../>
  </marker>
</defs>
<path d="M 440 52 Q 568 52 568 244" marker-end="url(#a)"/>

<!-- ✅ 手绘 chevron：每个方向单独写 -->
<path d="M 440 52 Q 568 52 568 244" fill="none" stroke="#5e5d59" stroke-width="1.5"/>
<path d="M 560 236 L 568 244 L 576 236" fill="none" stroke="#5e5d59" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round"/>
```

四个方向的 chevron 模板（tip 在端点，arm 长度 8px）：

| 方向 | chevron path                        |
| ---- | ----------------------------------- |
| ↓    | `M (x-8) (y-8) L x y L (x+8) (y-8)` |
| ←    | `M (x+8) (y-8) L x y L (x+8) (y+8)` |
| ↑    | `M (x-8) (y+8) L x y L (x+8) (y+8)` |
| →    | `M (x-8) (y-8) L x y L (x-8) (y+8)` |

### 16. Slide letter-spacing 减半

**症状**：照搬印刷品 letter-spacing 数值（如 `letter-spacing: 8px`）到 slide，文字看起来"散架"，字母间距过大。

**根因**：印刷品的字距是针对小字号（8-12pt）优化的。Slide 字号（48-64px）乘以相同 letter-spacing 绝对值，间距被放大到失控。

**解法**：Slide letter-spacing = 印刷值 / 2。Mono 字体除外（mono 本身是等宽，不需要额外字距调整）。

```css
/* 印刷品 eyebrow */
.eyebrow {
  letter-spacing: 6px;
}

/* ✅ Slide eyebrow */
.slide .eyebrow {
  letter-spacing: 3px;
} /* 减半 */
```
