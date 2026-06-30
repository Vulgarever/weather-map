# WebGL 气象地图引擎改造 — 阶段 1 设计（GPU 填色）

> 总目标：参照 `weather/pgm/new.html` demo 的 Canvas + GPU 着色器渲染逻辑，将现有基于 Leaflet 的气象地图改造为纯 WebGL 渲染，**不丢失现有气象效果**。分 6 阶段交付。
>
> **阶段 0（WebGL 地图引擎地基）已完成**：[gl-engine.js](../../../weather/pgm/gl-engine.js) + [gl-proj.js](../../../weather/pgm/gl-proj.js) 已实现底图 + Plate Carrée 投影 + 拖拽/滚轮/双击交互 + 底图 alpha 裁剪 + resize + `addLayer` 图层挂载点，并通过 `gl-stage.html` 验收。
>
> 本 spec 仅覆盖**阶段 1（GPU 填色）**——把 demo 渲染管线最核心的"色彩映射 + 与底图混合 + alpha 裁剪"搬上 GPU，喂真实 cmiss 站点数据。后续阶段（光流/粒子/等压线/叠加层）各自走 spec → plan → 实现迭代。

## 1. 背景与定位

### 1.1 demo 与现有系统的核心差异（填色维度）

| 维度 | demo (new.html) | 现有系统 (map.js) | 阶段 1 取法 |
| --- | --- | --- | --- |
| 色彩映射 | `getColorMap(t)` 着色器内硬编码 6 段彩虹 | 9 要素各自 LUT 色带（`METEO_CONFIG`） | **借 demo 的"着色器查 LUT"管线，喂现有 9 要素 LUT** |
| 数据来源 | 程序化 fbm 噪声（假数据） | 真实 cmiss 站点 + IDW 插值（240 列网格） | **保留真实 IDW，不上 GPU**（仅色彩映射上 GPU） |
| 与底图混合 | `mix(mapColor, weatherColor, 0.7)` | `mixBlendMode: multiply` 叠加 | **复刻现有 multiply**，保证视觉一致 |
| 裁剪 | 底图 alpha 通道 | GeoJSON clipPath | **沿用阶段 0 的底图 alpha 裁剪**（已验收） |

**关键原则**：demo 的气象是假噪声，**绝不能照抄噪声着色器**——否则气象效果当场丢失。阶段 1 借的是 demo 的**渲染管线**（全屏 quad + 片元着色器做 LUT 查色 + 混合 + 裁剪），数据仍走真实 IDW。

### 1.2 不丢效果的保证机制

- **并行验证，不替换**：阶段 1 在 `gl-stage.html` 内验证，**现有 `index.html` / `map.js` / `index.js` 一律不改**。旧页面照常运行，新 GPU 效果在验证页逐步证明。
- **资产移植**：现有 `METEO_CONFIG` / `computeFloatGrid` / `getFastLUT` / `getIdwColor` / `extractPointsFromContours` / `resolveMeteoType` 为纯函数，**临时复制**到 `gl-meteo.js`。阶段 5 退役 `map.js` 时消除重复。
- **视觉对齐靠肉眼**：阶段 1 的验收由用户对比 `gl-stage.html` 与现有 `index.html` 的填色效果确认。（本轮约束：不读取任何图片资源，含自生成。）

### 1.3 已确认的决策

1. **范围**：仅阶段 1（GPU 填色），不做光流/粒子/等压线/叠加层。
2. **方案**：方案 A（不碰 stage0，新建 layer 注入；IDW 留 CPU，色彩映射/混合/裁剪上 GPU）。
3. **混合**：复刻现有 `multiply`，不做 demo 的 `mix(0.7)`。
4. **不碰 stage0**：`gl-engine.js` / `gl-proj.js` 不改，仅通过 `addLayer` 注入填色层。
5. **现有页面零改动**。

## 2. 范围

### 2.1 范围内

- 9 要素 GPU 填色：temp / rain / snow / windSpeed / pressure / humidity / radiation / cloud，及 isobar 的 pressure 底色（等压线矢量线本身属阶段 4）。
- IDW → 数据纹理 → LUT 色带着色器 → 与底图 multiply 混合 → alpha 裁剪。
- 图例同步（切要素时图例标题/渐变/刻度更新）。
- `gl-stage.html` 接线：底图 + 填色层 + 9 要素切换 UI + 加载 cmiss/qinghai 数据。

### 2.2 范围外（后续阶段）

- 光流平流播放（阶段 2）：本阶段仅渲染单时间步，不插值。
- 雨/雪/风粒子（阶段 3）。
- 等压线矢量线 + H/L 高低中心（阶段 4）：本阶段 isobar 仅显示 pressure 底色热力。
- 场站 / 地名 / 边界线 / popup / 加载遮罩（阶段 5）。
- 现有 `index.html` / `map.js` / `index.js` 的任何修改。

## 3. 方案选型（数据纹理技术分叉）

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **A（选定）** | 新建 `gl-fill.js` 作为 GLEngine layer；IDW 留 CPU（移植 `computeFloatGrid`），结果**归一化为 RGBA8 数据纹理**（255 级，免 float 扩展，最稳）；着色器内**手动双线性**采样（不依赖 `OES_texture_float_linear`）→ LUT 纹理查色 → multiply 混合 → alpha 裁剪 | GLEngine 一行不改，stage0 零回归；零 WebGL 扩展依赖，兼容性最广 |
| B | 升级 WebGL2，R32F 原生双线性 | 最干净，但动了 stage0 已验证代码，需重跑 stage0 全部验收 |
| C | IDW 也搬 GPU（站点传纹理，逐像素算 IDW） | 最"demo 极致"，但 R=5° 半径 × ~448 站逐像素开销大，YAGNI |

**选 A 的理由**：风险最低、不动已验收的 stage0、与 spec"逐步移植资产"一致。RGBA8 归一化对各要素的精度损失可接受（见 §10 风险表）。

## 4. 架构与文件

### 4.1 文件

- 新建 `weather/pgm/gl-meteo.js` — 移植现有纯函数：`METEO_CONFIG` / `computeFloatGrid` / `getFastLUT` / `getIdwColor` / `extractPointsFromContours` / `resolveMeteoType` / `windToUV`（零 DOM/GL 依赖，可独立测）。**临时复制**，阶段 5 消除重复。
- 新建 `weather/pgm/gl-fill.js` — GLEngine layer，实现 `render(gl, view, api)` + `setElement(type, timeIndex)` + `setData(cmiss)`。
- 扩展 `weather/pgm/gl-stage.html` — 接线底图 + 填色层 + 9 要素切换 UI + 图例 + 数据加载。
- `gl-engine.js` / `gl-proj.js` / `index.html` / `map.js` / `index.js` **不改**。

### 4.2 模块边界

- `gl-meteo.js`：纯气象数学/色带，零 GL/DOM 依赖。输入 cmiss contours → 输出 IDW Float32 网格 / LUT Uint8 数组。
- `gl-fill.js`：GL layer。持有数据纹理 + LUT 纹理 + 着色器程序；每帧由 GLEngine 调 `render(gl, view, api)`。依赖 `gl-meteo.js`。
- `GLEngine`：不感知气象，仅提供 `addLayer` / `project` / `unproject` / view uniform / 事件。

## 5. 数据流

```
CMISS_DATA
  → extractPointsFromContours(type, contours[timeIndex])     [gl-meteo, CPU]
  → computeFloatGrid(points, type, 240 cols, ...)             [gl-meteo, CPU]
  → 归一化 (val-min)/(max-min) clamp[0,1] → RGBA8 数据纹理      [gl-fill, CPU 上传]
  → LUT 纹理（由 getFastLUT 预生成，按 type 切换）              [gl-fill, CPU 上传]
  → 片元着色器：
      NDC→px→lng/lat（复用 stage0 投影 uniform）
      → 网格 UV（按 bounds 线性映射）
      → 数据纹理手动双线性采样 → 归一化值
      → LUT 纹理查色（含 alpha）
      → 与底图 multiply 混合
      → 底图 alpha<0.1 落深色背景（裁剪，复用 stage0）
```

## 6. 渲染管线（着色器）

### 6.1 全屏 quad + 顶点着色器

复用 stage0 的全屏 quad。填色层作为独立 layer，绘制自己的全屏 quad（与底图 quad 分离，便于按需开关/替换）。

### 6.2 片元着色器（填色 + 混合 + 裁剪）

```glsl
precision highp float;
varying vec2 v_ndc;
uniform sampler2D u_baseMap;        // 底图（与 stage0 同源）
uniform sampler2D u_data;           // IDW 归一化数据纹理（LUMINANCE 单通道，着色器取 .r）
uniform sampler2D u_lut;            // 1D LUT 色带纹理（1xN，含 RGBA）
uniform vec2 u_resolution;
uniform float u_centerLng, u_centerLat, u_pxPerDeg;   // 复用 stage0 view uniform
uniform float u_boundsWest, u_boundsEast, u_boundsSouth, u_boundsNorth;  // 底图+IDW 网格共用 bounds（= MAP_CONFIG.bounds，二者同源）
uniform float u_dataCols, u_dataRows;
uniform float u_hasData;           // 0=无当前要素（透出底图），1=有

void main() {
    vec2 px = (v_ndc * 0.5 + 0.5) * u_resolution;
    float lng = u_centerLng + (px.x - u_resolution.x * 0.5) / u_pxPerDeg;
    float lat = u_centerLat - (px.y - u_resolution.y * 0.5) / u_pxPerDeg;

    // 底图 UV：与 stage0 gl-engine.js 片元着色器同公式
    float bu = (lng - u_boundsWest) / (u_boundsEast - u_boundsWest);
    float bv = (u_boundsNorth - lat) / (u_boundsNorth - u_boundsSouth);
    vec4 mapColor = texture2D(u_baseMap, vec2(clamp(bu, 0.0, 1.0), clamp(bv, 0.0, 1.0)));
    // alpha 裁剪：省外/底图透明区直接深色背景（与 stage0 一致）
    if (mapColor.a < 0.1) { gl_FragColor = vec4(0.1, 0.1, 0.15, 1.0); return; }
    // 无当前要素：透出底图
    if (u_hasData < 0.5) { gl_FragColor = mapColor; return; }

    // 网格 UV（按 IDW bounds 线性映射）
    float gu = (lng - u_boundsWest) / (u_boundsEast - u_boundsWest);
    float gv = (u_boundsNorth - lat) / (u_boundsNorth - u_boundsSouth);
    // 越界（bounds 外）钳制，靠底图 alpha 裁剪兜底
    vec2 g = vec2(clamp(gu, 0.0, 1.0), clamp(gv, 0.0, 1.0));

    // 手动双线性采样数据纹理（NEAREST 4 角插值，不依赖 float linear 扩展）
    float tx = g.x * (u_dataCols - 1.0);
    float ty = g.y * (u_dataRows - 1.0);
    float x0 = floor(tx), y0 = floor(ty);
    float fx = tx - x0, fy = ty - y0;
    // 4 次 NEAREST 采样 + 加权
    float v00 = texture2D(u_data, vec2((x0+0.5)/u_dataCols, (y0+0.5)/u_dataRows)).r;
    float v10 = texture2D(u_data, vec2((x0+1.5)/u_dataCols, (y0+0.5)/u_dataRows)).r;
    float v01 = texture2D(u_data, vec2((x0+0.5)/u_dataCols, (y0+1.5)/u_dataRows)).r;
    float v11 = texture2D(u_data, vec2((x0+1.5)/u_dataCols, (y0+1.5)/u_dataRows)).r;
    float norm = mix(mix(v00, v10, fx), mix(v01, v11, fx), fy);

    // LUT 查色（含 alpha）
    vec4 weather = texture2D(u_lut, vec2(clamp(norm, 0.0, 1.0), 0.5));

    // multiply 混合（复刻现有 mixBlendMode:multiply，预乘 alpha 强度）
    vec3 blended = mapColor.rgb * weather.rgb;
    gl_FragColor = vec4(mix(mapColor.rgb, blended, weather.a), 1.0);
}
```

### 6.3 数据纹理

- 尺寸：240 × rows（rows 由 bounds 长宽比算出，与现有 `computeFloatGrid` 一致）。
- 格式：**WebGL1 原生 `LUMINANCE` 单通道**（归一化值 0–255，`texImage2D` 用 `LUMINANCE/UNSIGNED_BYTE`）。免 float 扩展、零 RGBA8 填充浪费；着色器内 `.r` 取值。若后续阶段需要更高精度再升级 float。
- 归一化：`norm = clamp((val - min)/(max - min), 0, 1)` → `round(norm*255)`，min/max 取自 `METEO_CONFIG[type]`（rain/snow 的 min 特殊处理为 0，对齐现有 `getFastLUT`）。
- 滤波：NEAREST（手动双线性在着色器内做，见 §6.2）。
- 上传：`setElement(type, timeIndex)` 时重算 IDW 并 `texSubImage2D` 更新。

### 6.4 LUT 纹理

- 尺寸：1 × 4096（降自现有 `getFastLUT` 的 16384，人眼不可辨差异；若 GPU 支持 16384 可沿用）。
- 格式：RGBA8，由 `getFastLUT(type).lut` 直接上传。
- 滤波：NEAREST（阶梯色带，不需要线性）。
- 切要素时按 type 重新上传。

### 6.5 投影复用

着色器内 `NDC→px→lng/lat` 与 stage0 底图着色器**同一套投影 uniform**（`u_centerLng/u_centerLat/u_pxPerDeg/u_resolution`）。fill layer 的 `render(gl, view, api)` 从 `view` 取这些值并 set uniform，保证填色与底图、与交互严格对齐。

## 7. 关键决策

1. **混合 = multiply**（复刻现有 `createPerformanceIdwLayer` 的 `mixBlendMode:'multiply'`），不做 demo 的 `mix(0.7)`。GLSL 用预乘 alpha multiply：`mix(mapColor, mapColor*weather, weather.a)`。若肉眼对比发现观感偏差，可在实现时校准公式（验收点）。
2. **IDW 留 CPU**：仅色彩映射/混合/裁剪上 GPU（demo 管线核心）。IDW 仍 240 列，与现有一致。
3. **数据纹理 RGBA8 归一化**：免 float 扩展，最稳。255 级精度各要素误差可接受（见 §10）。阶段 2 光流若需更高精度再升级 float。
4. **裁剪沿用 stage0**：底图 alpha<0.1 落深色背景。不再引入 GeoJSON clipPath（阶段 5 叠加层再视需要补充精确省界）。
5. **不碰 stage0**：GLEngine 不改，仅 `addLayer(fillLayer)`。
6. **单时间步**：阶段 1 不做光流插值，`setElement(type, idx)` 渲染该步静态填色。

## 8. 模块边界与 API

### 8.1 `gl-fill.js` layer 接口

```js
var fillLayer = GLFill.create({
    bounds: [[31.5, 89.4], [39.3, 103.2]],  // [[south, west], [north, east]]
    gridCols: 240,
});
engine.addLayer(fillLayer);

fillLayer.setData(cmissData);              // 注入 CMISS_DATA，构建 timeSeriesContours
fillLayer.setElement('temp', timeIndex);   // 切要素 + 时间步，重算 IDW + 上传数据/LUT 纹理
fillLayer.getActiveType();                 // → 'temp' | null
fillLayer.onLegendChange(function (info) { // 图例同步回调
    // info: { title: string, gradient: cssString, labels: number[] } 或 null（无要素）
    // 字段语义对齐现有 map.js 的 window.updateLegendUI 输出（legendTitle/legendGradient/legendLabels），
    // 便于阶段 5 接管 index.html 时无缝替换；gl-stage.html 本阶段独立消费。
});
fillLayer.destroy();                        // 释放纹理/程序
```

### 8.2 与 GLEngine 的契约

- layer 需实现 `render(gl, view, api)`：每帧由 GLEngine 调用，从 `view` 取投影 uniform 并 drawArrays。
- layer 可用 `api.project/unproject` 做点击命中（阶段 5 用，阶段 1 不需要）。
- 数据纹理/LUT 纹理由 layer 自管，GLEngine 不感知。

## 9. 验收标准

1. `gl-stage.html` 切换 9 要素，填色色带与现有 `index.html` 同要素一致（同 `METEO_CONFIG`/LUT）。
2. 切换要素时图例（标题/渐变/刻度）同步更新。
3. 省内填色正确，省外/底图透明区为深色背景（裁剪沿用 stage0）。
4. 拖拽 / 滚轮缩放（光标为中心）/ 双击放大下，填色正确跟随投影，与底图对齐不错位。
5. 现有 `index.html` 页面行为完全不变（零改动验证）。
6. WebGL 不支持时沿用 stage0 降级提示。

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| RGBA8 归一化精度损失 | 255 级：温度 70 跨度→0.27℃、气压 500 跨度→1.96hPa，可接受；阶段 2 光流需更高精度再升级 float |
| LUT 4096 vs 现有 16384 级差异 | 人眼不可辨；若 GPU 支持 16384 可沿用，否则 4096 |
| multiply 混合与现有 CSS `mix-blend-mode:multiply` 细微差异 | 实现时肉眼对比校准公式（验收点 1） |
| 数据纹理 240 列在放大时锯齿 | 手动双线性已平滑；若不足可上调 cols（IDW 开销随 cols² 增长，权衡） |
| `gl-meteo.js` 与 `map.js` 重复代码 | 阶段 1 临时复制，阶段 5 退役 map.js 时消除；本阶段不抽公共模块（YAGNI） |
| cmiss/qinghai 数据加载时序 | `gl-stage.html` 在数据就绪后再 `fillLayer.setData` + `setElement` |

## 11. 后续阶段衔接

- **阶段 2（光流）**：`setElement` 改为持有 from/to 两张数据纹理，着色器内做光流位移插值；时间轴对接。RGBA8 精度不足时升级 float 数据纹理。
- **阶段 3（粒子）**：雨/雪/风粒子经 `addLayer` 注入，复用 view 投影 + 数据纹理做 mask。
- **阶段 4（等压线）**：marching squares 在 CPU 算线段，GPU 画线 + H/L 文字（DOM 或 SDF）。
- **阶段 5（叠加层）**：场站/地名/popup 用 DOM 叠加层（`api.project` 定位），最终替换 `index.html`、退役 `map.js`。
