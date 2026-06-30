# WebGL 气象地图引擎改造 — 阶段 0 设计

> 总目标：参照 `weather/pgm/new.html` demo 的 Canvas + GPU 着色器渲染逻辑，将现有基于 Leaflet 的气象地图改造为纯 WebGL 渲染，**不丢失现有气象效果**。
>
> 由于"纯 WebGL 重写 + 保留完整地图交互 + 全 WebGL 极致"是超大工程，按 6 阶段分步交付。本 spec 仅覆盖**阶段 0（WebGL 地图引擎地基）**。后续阶段各自走 spec → plan → 实现迭代。

## 1. 背景与约束

### 1.1 demo 与现有系统的本质差异

| 维度 | demo (new.html) | 现有系统 (map.js) |
| --- | --- | --- |
| 渲染框架 | 单 WebGL 全屏画布 | Leaflet + Canvas 叠加层 |
| 气象数据 | 程序化 fbm 噪声（假数据） | 真实 cmiss 站点数据 |
| 插值 | 无 | IDW 反距离加权（240 列网格，cosLat 修正） |
| 要素种类 | 仅温度（6 段彩虹） | 9 种要素各自 LUT 色带 |
| 流动效果 | u_time 驱动噪声流动（假流动） | 基于真实数据时间序列的光流平流变形 |
| 等值线 | fract(val*12) 程序化条纹 | marching squares 等压线 + H/L 高低中心 |
| 粒子 | 无 | 雨滴下落 + 雪花 + 风场流线 |
| 裁剪 | 底图 alpha 通道 | GeoJSON 矢量多边形 clipPath |

**借鉴目标**：demo 的 "GPU 着色器做色彩映射 + 与底图混合 + alpha 裁剪" 渲染管线，替换现有 `computeFrameRGBA → putImageData` 的 CPU 逐像素光流计算 + LUT 上色。

**保留资产**：现有 9 要素 LUT 色带 (`METEO_CONFIG`)、IDW 插值 (`computeFloatGrid`)、光流平流思路、雨/雪/风粒子视觉、等压线 + H/L、场站/地名/popup/时间轴等，在后续阶段逐步移植到新引擎宿主。

### 1.2 已确认的决策

1. **改造深度**：抛弃 Leaflet，纯 WebGL 重写。
2. **地图交互**：保留完整缩放/平移/拖拽/滚轮/双击交互。
3. **引擎架构**：全 WebGL 极致（填色 + 粒子 + 等压线全部 GPU 化，后续阶段落地）。
4. **交付节奏**：分 6 阶段；本次仅做阶段 0。

### 1.3 阶段分解（全景）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 0 地基 | WebGL canvas + 投影 + 交互 + 底图 + 裁剪 + resize | 可交互的青海底图，裁剪正确 |
| 1 填色 | cmiss → IDW → R32F 数据纹理 → LUT 色带着色器 + 与底图混合；9 要素 + 图例 | 9 要素填色与现有色带一致 |
| 2 光流 | from/to 双数据纹理 → GPU 光流位移 + 插值；时间轴对接 | 播放有物理推移感 |
| 3 粒子 | 雨/雪/风粒子 GPU 化 + mask | 粒子视觉对齐 |
| 4 等压线 | marching squares → GPU 画线 + H/L | 等压线一致 |
| 5 叠加层 | 场站/地名/边界/popup/加载遮罩对接 | 交互一致 |

---

## 2. 阶段 0 范围

### 2.1 范围内

- WebGL canvas 初始化与 resize / devicePixelRatio 适配
- Plate Carrée 经纬度投影与 view 状态
- 缩放 / 平移 / 拖拽 / 滚轮（光标为中心）/ 双击交互
- 边界约束（minZoom 4 / maxZoom 12，平移不飞出青海太远）
- 青海底图纹理加载与渲染
- 底图 alpha 通道裁剪（demo 方式：省外深色背景）
- 对外 API（为阶段 1–5 预留挂载点）
- 阶段验证页 `gl-stage.html`

### 2.2 范围外（后续阶段）

- 气象填色、光流、粒子、等压线、场站、地名、popup、加载遮罩的实际渲染
- 现有 index.html / map.js / index.js 的任何修改（阶段 5 全部就绪后再集成替换）

---

## 3. 架构与文件组织

### 3.1 文件

- 新建 `weather/pgm/gl-engine.js` — WebGL 地图引擎模块（IIFE 风格，对齐现有 map.js）
- 新建 `weather/pgm/gl-stage.html` — 阶段验证页（基于 new.html 演进，**不引 Leaflet**）
- 现有 `index.html` / `map.js` / `index.js` 本次不改

### 3.2 对外 API

```js
var engine = GLEngine.init(container, {
    center: [96.2, 35.4],   // [lng, lat]
    minZoom: 4,
    maxZoom: 12,
});

engine.setBaseMap('../base/rs/img/qinghai_map.png', {
    bounds: [[31.5, 89.4], [39.3, 103.2]], // [[south, west], [north, east]]
});

engine.fitBounds([[31.5, 89.4], [39.3, 103.2]], {
    paddingTopLeft: [88, 60],
    paddingBottomRight: [250, 60],
});

engine.project([lng, lat]);   // → [px, py] 屏幕像素
engine.unproject([px, py]);   // → [lng, lat]

engine.on('click', function (e) { /* e: {lng, lat, px, py} */ });
engine.on('moveend', function (e) { /* e: {center, zoom} */ });

engine.getZoom();
engine.setZoom(zoom);
engine.panBy([dx, dy]);
engine.flyTo([lng, lat], zoom);

engine.showLoading();
engine.hideLoading();

engine.addLayer(glLayer);     // 阶段 1/3/4 填色/粒子/等压线层挂载点
engine.removeLayer(glLayer);

engine.destroy();
```

### 3.3 模块边界

`GLEngine` 只负责：地图投影、视图变换、交互、底图渲染、图层容器、事件分发。**不**包含任何气象要素逻辑——要素逻辑由后续阶段的 layer 对象通过 `addLayer` 注入，引擎为它们提供 `project/unproject/viewport uniform` 等能力。

---

## 4. 投影与坐标系

### 4.1 投影：Plate Carrée（线性经纬度）

- 经度线性映射 x，纬度线性映射 y。
- 实现：经纬度↔世界像素线性换算，世界像素再经 view 变换到屏幕。
- **理由**：实现简单、与经纬度数据/GeoJSON 天然兼容。
- **取舍**：高纬轻微形变；青海 31.5–39.3°N 省级区域误差 <1%，可忽略。

### 4.2 底图放置

底图 PNG 按 `bounds` 线性拉伸放置，语义对齐现有 `L.imageOverlay(url, bounds)`：
- bounds 为 `[[south, west], [north, east]]`
- 纹理 UV 直接由屏幕像素反推到 bounds 内的经纬度，再线性映射到 [0,1] UV 采样。

### 4.3 view 状态

`view = { centerLng, centerLat, zoom }`，zoom 连续值。屏幕↔经纬度通过 view 投影矩阵换算：
- 屏幕中心对应 `centerLng/centerLat`
- 每像素覆盖的经纬度跨度由 zoom 决定：zoom 越大，每像素跨度越小（即 pxPerDeg 越大，地图越放大）
- 取 `pxPerDeg = BASE_PX_PER_DEG * 2^zoom`（BASE_PX_PER_DEG 为常量，具体值在实现时标定，使 zoom=6 时青海全省约铺满视口）
- `project([lng,lat]) = 屏幕中心px + ([lng,lat] - center) * pxPerDeg`（纬度方向需处理上下翻转：屏幕 y 向下、纬度向上）

**导航类 API 行为**：`setZoom/panBy/flyTo` 均更新 view 后触发一次 moveend；`panBy([dx,dy])` 按屏幕像素增量平移；`flyTo([lng,lat], zoom)` 同时设定中心与 zoom。`destroy` 解除所有事件监听并释放 WebGL 资源。`addLayer/removeLayer` 维护图层列表，每帧遍历绘制（阶段 0 仅底图自身一个"图层"）。

---

## 5. 交互模型

### 5.1 拖拽平移

- pointerdown 记录起点，pointermove 计算 delta（屏幕像素），换算为经纬度 delta 更新 center。
- pointerup 结束。
- 边界约束见 5.5。

### 5.2 滚轮缩放（光标为中心）

- 滚轮事件：记录光标屏幕位置，缩放前 `unproject` 得到光标下的经纬度。
- 调整 zoom。
- 调整 center 使该经纬度仍落在光标下（保持光标下经纬度不变）。
- 阻止默认页面滚动。

### 5.3 双击放大

- 双击：在双击点放大一级（zoom + 1，以双击点为中心）。

### 5.4 resize / devicePixelRatio

- 窗口 resize：canvas 尺寸 = 容器 clientWidth/Height * devicePixelRatio，gl.viewport 同步。
- 投影计算使用 CSS 像素（clientWidth/Height），drawingBuffer 为物理像素。

### 5.5 边界约束

- zoom 钳制到 `[minZoom, maxZoom]` = [4, 12]。
- 平移约束：限制 center 保持在青海 bounds 附近，不飞出太远（允许少量边距便于操作）。

### 5.6 事件分发

- `click`：pointerdown→up 期间无明显拖拽（位移 < 阈值）视为点击，分发 `{lng, lat, px, py}`。
- `moveend`：拖拽/缩放/双击结束后分发 `{center:[lng,lat], zoom}`。
- 其余阶段（movestart/move/zoom 等）按需补充。

---

## 6. 渲染管线

### 6.1 全屏 quad + 顶点着色器

- 两个三角形覆盖 NDC 全屏。
- 顶点着色器传 UV / 屏幕坐标。

### 6.2 片元着色器（底图 + 裁剪）

复刻 demo 的 GPU 上色思路（阶段 0 仅底图与裁剪，色彩映射留给阶段 1）：

```glsl
precision highp float;
varying vec2 v_uv;          // 经投影反推的底图 UV [0,1]
uniform sampler2D u_baseMap;
uniform vec2 u_resolution;

void main() {
    vec4 mapColor = texture2D(u_baseMap, v_uv);
    if (mapColor.a < 0.1) {
        gl_FragColor = vec4(0.1, 0.1, 0.15, 1.0); // 省外深色背景（demo 方式）
        return;
    }
    gl_FragColor = mapColor;
}
```

- v_uv 由屏幕像素 → 经纬度 → bounds 内线性 UV 得到（含 view 投影与裁剪到 [0,1]）。
- UV 越界（青海省外、bounds 外）→ 底图 alpha 通道透明 → 落入深色背景分支。

### 6.3 底图纹理加载

- `Image → texImage2D(RGBA, UNSIGNED_BYTE)`
- `UNPACK_FLIP_Y_WEBGL = true`（保证地图不上下颠倒，对齐 demo）
- `CLAMP_TO_EDGE` + `LINEAR`
- 加载前占位纯黑 1x1 纹理
- 加载失败：控制台报错 + 验证页提示（对齐 demo 的 onerror 行为）

### 6.4 帧循环

- 常驻 `requestAnimationFrame`，每帧更新 view uniform 并 `drawArrays`。
- 为阶段 2 光流动画 / 阶段 3 粒子动画预留常驻渲染循环。
- 静止时仍重绘（开销极低，全屏 quad 两次 draw call）。

---

## 7. 阶段 0 验收标准

1. 打开 `gl-stage.html` 看到青海底图，省内清晰、省外深色背景（裁剪生效）。
2. 拖拽平移可用。
3. 滚轮缩放以光标为中心，缩放后光标下经纬度不变。
4. 双击放大一级可用。
5. zoom 钳制 [4,12]，平移不飞出青海太远。
6. 窗口 resize 自适应，无变形。
7. 点击地图，控制台打印点击点 `[lng, lat]`（验证 `unproject` 正确，为阶段 5 点击插值铺路）。
8. 浏览器不支持 WebGL 时给出提示（对齐 demo）。

---

## 8. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Plate Carrée 高纬形变 | 青海省级区域误差 <1%，可忽略；如后续需更精确可在阶段 1+ 切 Mercator |
| 滚轮光标为中心的数学易错 | 验收点 3 明确校验"缩放后光标下经纬度不变" |
| 边界约束过紧/过松 | 允许少量边距，参照现有 `fitBounds` 的 paddingTopLeft/BottomRight 留白语义 |
| 设备像素比/DPI 导致模糊或变形 | drawingBuffer 物理像素，投影用 CSS 像素，二者分离 |
| 与现有 Leaflet 页面并存时命名/全局冲突 | 新引擎独立 `gl-engine.js`，独立验证页，现有页面本次不改 |

---

## 9. 后续阶段衔接（非本次范围，仅说明挂载点）

- 阶段 1：通过 `engine.addLayer(fillLayer)` 注入填色层；填色层使用 `engine.project/unproject` 与 view uniform。
- 阶段 3：粒子层同样经 `addLayer`，复用 view 投影。
- 阶段 5：点击经 `engine.on('click')` 拿到 `[lng,lat]`，调用现有 `interpolatePointValue` 插值并展示 popup。
