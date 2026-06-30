# WebGL 气象地图阶段 1（GPU 填色）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 demo 的 GPU 填色管线（LUT 查色 + 与底图混合 + alpha 裁剪）接到已就绪的 GLEngine 上，喂真实 cmiss 站点数据，9 要素填色与现有色带一致。

**Architecture:** 新建 `gl-meteo.js`（纯函数，从 map.js 临时移植 IDW/LUT/色带）+ `gl-fill.js`（GLEngine layer，自持底图/数据/LUT 三张纹理，片元着色器内完成 multiply 混合与裁剪）。GLEngine 零改动，仅 `addLayer` 注入。验证在 `gl-stage.html`，现有 index.html/map.js/index.js 一律不改。

**Tech Stack:** WebGL1（LUMINANCE 单通道数据纹理，免 float 扩展）、Plate Carrée 投影（复用 gl-proj）、原生 JS（IIFE，对齐现有 map.js 风格）。

---

## 仓库提交约定（重要，每个 commit 都要遵守）

本仓库会话开始时 `weather/pgm/index.css`、`index.html`、`index.js`、`map.js` 这 4 个文件处于 **staged** 状态。直接 `git add <新文件> && git commit` 会把它们混进提交。**每个 commit 之前必须先 unstage 这 4 个文件，commit 之后再恢复 staged 状态**：

```bash
# 提交前
git reset HEAD -- weather/pgm/index.css weather/pgm/index.html weather/pgm/index.js weather/pgm/map.js
git add <本任务相关文件>
git commit -m "..."
# 提交后恢复（保持与会话开始一致的 staged 状态）
git add weather/pgm/index.css weather/pgm/index.html weather/pgm/index.js weather/pgm/map.js
```

本计划每个 "Commit" 步骤已按此展开，照抄即可。

---

## 文件结构

| 文件 | 责任 | 本计划动作 |
| --- | --- | --- |
| `weather/pgm/gl-meteo.js` | 纯气象数学：METEO_CONFIG 色带 / extractPointsFromContours / computeFloatGrid(IDW) / resolveMeteoType / getIdwColor / getFastLUT / getLegendInfo。零 DOM/GL 依赖。 | 新建 |
| `weather/pgm/gl-meteo.test.html` | gl-meteo 纯函数断言测试页（对齐 gl-proj.test.html 风格）。 | 新建 |
| `weather/pgm/gl-fill.js` | GLEngine layer：持有底图/数据/LUT 三纹理 + 着色器，`render(gl,view,api)` 每帧绘制，`setData/setElement` 更新。 | 新建 |
| `weather/pgm/gl-stage.html` | 阶段验证页：接线 GLEngine + fillLayer + 9 要素切换 UI + 图例 + cmiss 数据。 | 修改（已存在 stage0 版本） |
| `weather/pgm/gl-engine.js` / `gl-proj.js` | stage0 引擎，已验收。 | **不改** |
| `weather/pgm/index.html` / `map.js` / `index.js` | 现有 Leaflet 页面。 | **不改** |

---

## Task 1: gl-meteo.js 核心插值函数 + 纯函数测试

**Files:**
- Create: `weather/pgm/gl-meteo.js`
- Create: `weather/pgm/gl-meteo.test.html`

- [ ] **Step 1: 写失败测试页 `gl-meteo.test.html`**

创建 `weather/pgm/gl-meteo.test.html`，内容：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>gl-meteo 纯函数测试</title>
<style>
  body { font-family: monospace; padding: 20px; background:#111; color:#eee; }
  .pass { color: #6f6; }
  .fail { color: #f66; font-weight: bold; }
  #out { white-space: pre-wrap; }
</style>
</head>
<body>
<h2>gl-meteo 测试（Task 1：插值核心）</h2>
<div id="out"></div>
<script src="./gl-meteo.js"></script>
<script>
(function () {
  var out = document.getElementById('out');
  var pass = 0, fail = 0;
  function approx(a, b, eps) { eps = eps == null ? 1e-6 : eps; return Math.abs(a - b) < eps; }
  function eq(a, b) { return Array.isArray(a) ? a.length === b.length && a.every(function (x, i) { return approx(x, b[i]); }) : approx(a, b); }
  function assert(name, actual, expected) {
    var ok = eq(actual, expected);
    out.innerHTML += (ok ? '<span class="pass">✓</span> ' : '<span class="fail">✗</span> ') + name + (ok ? '' : '\n   期望: ' + JSON.stringify(expected) + '\n   实际: ' + JSON.stringify(actual)) + '\n';
    ok ? pass++ : fail++;
  }

  // resolveMeteoType 映射
  assert('resolveMeteoType wind → windSpeed', GLMeteo.resolveMeteoType('wind'), 'windSpeed');
  assert('resolveMeteoType windSpeed → windSpeed', GLMeteo.resolveMeteoType('windSpeed'), 'windSpeed');
  assert('resolveMeteoType isobar → pressure', GLMeteo.resolveMeteoType('isobar'), 'pressure');
  assert('resolveMeteoType temp → temp', GLMeteo.resolveMeteoType('temp'), 'temp');

  // extractPointsFromContours：假站点数组（28 元素，对齐 cmiss 结构）
  var fake = [
    ["id1", 100.0, 37.0, 9999, "1", 5.5, 180, "3", 950.0, 60, 700, 30, 0.2, 9999, 9999, 9999, 9999, 9999, 9999, 15.5, 9999, 9999, 9999, 9999, 9999, 9999, false, "站A"],
  ];
  var tempPts = GLMeteo.extractPointsFromContours('temp', fake);
  assert('extract temp 点数', tempPts.length, 1);
  assert('extract temp 经度', tempPts[0].lng, 100.0);
  assert('extract temp 纬度', tempPts[0].lat, 37.0);
  assert('extract temp 值(s[19])', tempPts[0].value, 15.5);
  var rainPts = GLMeteo.extractPointsFromContours('rain', fake);
  assert('extract rain 值(s[12])', rainPts[0].value, 0.2);
  var presPts = GLMeteo.extractPointsFromContours('pressure', fake);
  assert('extract pressure 值(s[8])', presPts[0].value, 950.0);
  var windPts = GLMeteo.extractPointsFromContours('windSpeed', fake);
  assert('extract windSpeed 值(s[5])', windPts[0].value, 5.5);

  // extractPointsFromContours：缺测值过滤
  var miss = [["id2", 101.0, 38.0, 9999, "1", 9999, 180, "3", 9999, 60, 700, 30, 0.2, 9999, 9999, 9999, 9999, 9999, 9999, 9999, 9999, 9999, 9999, 9999, 9999, 9999, false, "站B"]];
  assert('缺测 windSpeed 被过滤', GLMeteo.extractPointsFromContours('windSpeed', miss).length, 0);

  // computeFloatGrid：单点，格点 (gx=2,gy=2) 恰好落在站点 (37.0,100.0) 上，应取该点值
  var g = GLMeteo.computeFloatGrid([{ lat: 37.0, lng: 100.0, value: 15.5 }], 'temp', 4, 4, 99.0, 101.0, 36.0, 38.0);
  assert('computeFloatGrid cols', g.cols, 4);
  assert('computeFloatGrid rows', g.rows, 4);
  assert('computeFloatGrid west', g.west, 99.0);
  assert('computeFloatGrid north', g.north, 38.0);
  // 单点 IDW：站点恰落格点 → 该格点 sumW 极大，值=15.5；其余格点最近邻兜底也≈15.5
  assert('computeFloatGrid 站点格点≈值', approx(g.grid[2 * 4 + 2], 15.5, 1e-3), true);
  assert('computeFloatGrid 角点≈值(最近邻兜底)', approx(g.grid[0], 15.5, 1e-3), true);

  out.innerHTML += '\n' + (fail === 0 ? '<span class="pass">全部通过 ' + pass + '/' + (pass+fail) + '</span>' : '<span class="fail">失败 ' + fail + '/' + (pass+fail) + '</span>');
})();
</script>
</body>
</html>
```

- [ ] **Step 2: 运行测试，确认失败**

在浏览器打开 `gl-stage.html` 所在目录用本地服务器（如 Live Server）访问 `weather/pgm/gl-meteo.test.html`。
Expected: 页面显示 `✗` 且报 `GLMeteo is not defined`（因为 gl-meteo.js 尚未创建，浏览器 404 加载失败）。

- [ ] **Step 3: 实现 `gl-meteo.js`（核心插值部分）**

创建 `weather/pgm/gl-meteo.js`，内容：

```javascript
/**
 * GLMeteo — 气象纯函数模块（阶段 1：从 map.js 临时移植，零 DOM/GL 依赖）
 * 供 gl-fill.js 使用。阶段 5 退役 map.js 时消除重复。
 */
var GLMeteo = (function () {
    /* 直接移植 map.js 的 METEO_CONFIG（9 要素色带 + isobar 等压线配置） */
    var METEO_CONFIG = {
        temp: {
            min: -30, max: 40,
            colors: [
                { val: -30, r: 30,  g: 0,   b: 140, a: 255, hex: "rgba(30,0,140,1)" },
                { val: -20, r: 60,  g: 10,  b: 180, a: 250, hex: "rgba(60,10,180,0.98)" },
                { val: -10, r: 30,  g: 70,  b: 220, a: 248, hex: "rgba(30,70,220,0.97)" },
                { val: 0,   r: 20,  g: 180, b: 200, a: 248, hex: "rgba(20,180,200,0.97)" },
                { val: 10,  r: 80,  g: 200, b: 70,  a: 250, hex: "rgba(80,200,70,0.98)" },
                { val: 20,  r: 255, g: 220, b: 0,   a: 252, hex: "rgba(255,220,0,0.99)" },
                { val: 30,  r: 255, g: 130, b: 0,   a: 252, hex: "rgba(255,130,0,0.99)" },
                { val: 40,  r: 210, g: 0,   b: 30,  a: 255, hex: "rgba(210,0,30,1)" },
            ],
        },
        rain: {
            min: 0.1, max: 50,
            colors: [
                { val: 0.1, r: 160, g: 230, b: 130, a: 200, hex: "rgba(160,230,130,0.78)" },
                { val: 5,   r: 50,  g: 180, b: 50,  a: 245, hex: "rgba(50,180,50,0.96)" },
                { val: 15,  r: 255, g: 225, b: 0,   a: 250, hex: "rgba(255,225,0,0.98)" },
                { val: 30,  r: 255, g: 120, b: 0,   a: 252, hex: "rgba(255,120,0,0.99)" },
                { val: 50,  r: 230, g: 0,   b: 0,   a: 255, hex: "rgba(230,0,0,1)" },
            ],
        },
        snow: {
            min: 0.1, max: 30,
            colors: [
                { val: 0.1, r: 180, g: 150, b: 200, a: 230, hex: "rgba(180,150,200,0.90)" },
                { val: 2.5, r: 190, g: 120, b: 180, a: 240, hex: "rgba(190,120,180,0.94)" },
                { val: 5.0, r: 210, g: 90,  b: 160, a: 248, hex: "rgba(210,90,160,0.97)" },
                { val: 10,  r: 200, g: 40,  b: 110, a: 252, hex: "rgba(200,40,110,0.99)" },
                { val: 20,  r: 140, g: 0,   b: 70,  a: 255, hex: "rgba(140,0,70,1)" },
                { val: 30,  r: 80,  g: 0,   b: 110, a: 255, hex: "rgba(80,0,110,1)" },
            ],
        },
        windSpeed: {
            min: 0, max: 30,
            colors: [
                { val: 0,  r: 110, g: 200, b: 100, a: 0,   hex: "rgba(110,200,100,0)" },
                { val: 2,  r: 110, g: 200, b: 100, a: 215, hex: "rgba(110,200,100,0.84)" },
                { val: 5,  r: 30,  g: 160, b: 70,  a: 245, hex: "rgba(30,160,70,0.96)" },
                { val: 10, r: 255, g: 220, b: 0,   a: 246, hex: "rgba(255,220,0,0.96)" },
                { val: 15, r: 255, g: 140, b: 0,   a: 250, hex: "rgba(255,140,0,0.98)" },
                { val: 20, r: 240, g: 80,  b: 40,  a: 252, hex: "rgba(240,80,40,0.99)" },
                { val: 25, r: 200, g: 30,  b: 50,  a: 255, hex: "rgba(200,30,50,1)" },
                { val: 30, r: 120, g: 0,   b: 30,  a: 255, hex: "rgba(120,0,30,1)" },
            ],
        },
        pressure: {
            min: 500, max: 1000,
            colors: [
                { val: 500, r: 80,  g: 60,  b: 160, a: 255, hex: "rgba(80,60,160,1)" },
                { val: 600, r: 40,  g: 120, b: 180, a: 250, hex: "rgba(40,120,180,0.98)" },
                { val: 700, r: 40,  g: 150, b: 120, a: 250, hex: "rgba(40,150,120,0.98)" },
                { val: 800, r: 180, g: 200, b: 60,  a: 250, hex: "rgba(180,200,60,0.98)" },
                { val: 900, r: 250, g: 150, b: 70,  a: 252, hex: "rgba(250,150,70,0.99)" },
                { val: 1000,r: 200, g: 50,  b: 70,  a: 255, hex: "rgba(200,50,70,1)" },
            ],
        },
        humidity: {
            min: 0, max: 100,
            colors: [
                { val: 0,   r: 100, g: 50,  b: 5,   a: 250, hex: "rgba(100,50,5,0.98)" },
                { val: 25,  r: 190, g: 130, b: 60,  a: 245, hex: "rgba(190,130,60,0.96)" },
                { val: 55,  r: 220, g: 200, b: 150, a: 242, hex: "rgba(220,200,150,0.95)" },
                { val: 75,  r: 30,  g: 130, b: 125, a: 250, hex: "rgba(30,130,125,0.98)" },
                { val: 100, r: 0,   g: 80,  b: 70,  a: 252, hex: "rgba(0,80,70,0.99)" },
            ],
        },
        radiation: {
            min: 0, max: 1000,
            colors: [
                { val: 0,   r: 30,  g: 0,   b: 60,  a: 255, hex: "rgba(30,0,60,1)" },
                { val: 200, r: 120, g: 0,   b: 30,  a: 252, hex: "rgba(120,0,30,0.99)" },
                { val: 400, r: 220, g: 30,  b: 30,  a: 252, hex: "rgba(220,30,30,0.99)" },
                { val: 600, r: 250, g: 130, b: 50,  a: 252, hex: "rgba(250,130,50,0.99)" },
                { val: 800, r: 255, g: 180, b: 80,  a: 254, hex: "rgba(255,180,80,1)" },
                { val: 1000,r: 255, g: 250, b: 180, a: 255, hex: "rgba(255,250,180,1)" },
            ],
        },
        cloud: {
            min: 0, max: 100,
            colors: [
                { val: 0,   r: 180, g: 180, b: 195, a: 0,   hex: "rgba(180,180,195,0)" },
                { val: 15,  r: 180, g: 180, b: 195, a: 195, hex: "rgba(180,180,195,0.76)" },
                { val: 40,  r: 120, g: 120, b: 135, a: 225, hex: "rgba(120,120,135,0.88)" },
                { val: 70,  r: 70,  g: 70,  b: 85,  a: 245, hex: "rgba(70,70,85,0.96)" },
                { val: 100, r: 25,  g: 25,  b: 35,  a: 255, hex: "rgba(25,25,35,1)" },
            ],
        },
        isobar: {
            interval: 10,
            lineColor: "rgba(20, 20, 20, 0.95)",
            lineWidth: 1.4,
            labelColor: "#0a0a0a",
        },
    };

    function resolveMeteoType(type) {
        if (type === "wind" || type === "windSpeed") return "windSpeed";
        if (type === "isobar") return "pressure";
        return type;
    }

    /* 从一个时间步的 contours 站点数组提取指定要素的 {lat,lng,value} 点集。
       字段索引对齐 map.js extractPointsFromContours。 */
    function extractPointsFromContours(type, contours) {
        var points = [];
        if (!contours) return points;
        contours.forEach(function (s) {
            var val;
            if (type === "temp") val = s[19];
            else if (type === "rain" || type === "snow") val = s[12];
            else if (type === "pressure" || type === "isobar") val = s[8];
            else if (type === "windSpeed" || type === "wind") val = s[5];
            else if (type === "humidity") val = s[9];
            else if (type === "radiation") val = s[10];
            else if (type === "cloud") val = s[11];

            if (val === undefined || val === null || isNaN(val)) return;
            if (val === 9999 || val === 999999 || val === -9999 || val === -999 || val === -99) return;

            points.push({ lat: s[2], lng: s[1], value: val });
        });
        return points;
    }

    /* 取指定要素在指定时间步的插值点集（阶段 1 简化：wind 直接取风速点，不做 UV 网格） */
    function getLayerPointsAt(type, contours) {
        return extractPointsFromContours(resolveMeteoType(type), contours);
    }

    /* IDW 反距离加权网格（移植 map.js computeFloatGrid，240 列，cosLat 修正）。
       rain/snow 用 1/(d²+0.05)³ 强局部，其余 1/(d²+0.05)，R=5° 半径。 */
    function computeFloatGrid(points, type, cols, rows, west, east, south, north) {
        var dx = (east - west) / cols;
        var dy = (north - south) / rows;
        var cosLat = Math.cos((((south + north) / 2) * Math.PI) / 180);
        var grid = new Float32Array(cols * rows);
        var idx = 0;
        var R = 5.0, R2 = R * R, smoothing = 0.05;

        for (var gy = 0; gy < rows; gy++) {
            var lat = north - gy * dy;
            for (var gx = 0; gx < cols; gx++) {
                var lng = west + gx * dx;
                var sumV = 0, sumW = 0, closestVal = 0, minDist2 = Infinity;
                for (var i = 0; i < points.length; i++) {
                    var p = points[i];
                    var dlng = (lng - p.lng) * cosLat, dlat = lat - p.lat;
                    var d2 = dlng * dlng + dlat * dlat;
                    if (d2 < minDist2) { minDist2 = d2; closestVal = p.value; }
                    if (d2 > R2) continue;
                    var w;
                    if (type === "rain" || type === "snow") w = 1.0 / Math.pow(d2 + smoothing, 3);
                    else w = 1.0 / (d2 + smoothing);
                    sumV += p.value * w;
                    sumW += w;
                }
                grid[idx++] = sumW > 0 ? sumV / sumW : closestVal;
            }
        }
        return { grid: grid, cols: cols, rows: rows, dx: dx, dy: dy, west: west, north: north };
    }

    return {
        METEO_CONFIG: METEO_CONFIG,
        resolveMeteoType: resolveMeteoType,
        extractPointsFromContours: extractPointsFromContours,
        getLayerPointsAt: getLayerPointsAt,
        computeFloatGrid: computeFloatGrid,
    };
})();
```

- [ ] **Step 4: 运行测试，确认通过**

刷新 `gl-meteo.test.html`。
Expected: 全部 `✓`，底部显示"全部通过 N/N"。`computeFloatGrid 单点中心≈值` 这条用了 `|| true` 兜底（单点 IDW 全场最近邻填充，中心点必为该值），主要验证不抛错且网格尺寸正确。

- [ ] **Step 5: Commit**

```bash
git reset HEAD -- weather/pgm/index.css weather/pgm/index.html weather/pgm/index.js weather/pgm/map.js
git add weather/pgm/gl-meteo.js weather/pgm/gl-meteo.test.html
git commit -m "feat(gl): 新增 gl-meteo 纯函数模块（METEO_CONFIG/IDW/插值）+ 测试" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
git add weather/pgm/index.css weather/pgm/index.html weather/pgm/index.js weather/pgm/map.js
```

---

## Task 2: gl-meteo.js 色带 + LUT + 图例 + 测试

**Files:**
- Modify: `weather/pgm/gl-meteo.js`（在 IIFE 内追加色带函数，return 暴露）
- Modify: `weather/pgm/gl-meteo.test.html`（追加色带断言）

- [ ] **Step 1: 追加失败测试到 `gl-meteo.test.html`**

在 `gl-meteo.test.html` 的 `<script>` 内、`out.innerHTML += '\n' + ...` 汇总行**之前**插入：

```javascript
  // ===== Task 2: 色带 / LUT / 图例 =====
  var lut = GLMeteo.getFastLUT('temp');
  assert('getFastLUT temp steps', lut.steps, 16384);
  assert('getFastLUT temp min', lut.min, -30);
  assert('getFastLUT temp max', lut.max, 40);
  assert('getFastLUT temp lut 长度', lut.lut.length, 16384 * 4);

  var cCold = GLMeteo.getIdwColor('temp', -30);
  assert('getIdwColor temp 极冷 r', cCold.r, 30);
  assert('getIdwColor temp 极冷 a', cCold.a, 255);
  var cHot = GLMeteo.getIdwColor('temp', 40);
  assert('getIdwColor temp 极热 r', cHot.r, 210);
  var cNoRain = GLMeteo.getIdwColor('rain', 0.05);
  assert('getIdwColor rain 无雨透明', cNoRain.a, 0);

  var liWind = GLMeteo.getLegendInfo('wind');
  assert('getLegendInfo wind 标题', liWind.title, '风速能量热力场 (m/s)');
  assert('getLegendInfo wind gradient 含 rgba', liWind.gradient.indexOf('rgba') >= 0, true);
  assert('getLegendInfo wind labels 首项', liWind.labels[0], 0);
  assert('getLegendInfo wind labels 末项', liWind.labels[liWind.labels.length - 1], 30);

  var liIso = GLMeteo.getLegendInfo('isobar');
  assert('getLegendInfo isobar 标题', liIso.title, '气压 (hPa)');
  assert('getLegendInfo isobar 取 pressure 色带末值', liIso.labels[liIso.labels.length - 1], 1000);

  assert('getLegendInfo weather 无配置返回 null', GLMeteo.getLegendInfo('weather'), null);
```

- [ ] **Step 2: 运行测试，确认新断言失败**

刷新 `gl-meteo.test.html`。
Expected: 新增的 `getFastLUT`/`getIdwColor`/`getLegendInfo` 断言显示 `✗`，报 `GLMeteo.getFastLUT is not a function`（函数尚未实现）。

- [ ] **Step 3: 在 `gl-meteo.js` 追加色带实现**

在 `gl-meteo.js` 的 `return { ... };` 语句**之前**（即 `computeFloatGrid` 函数定义之后、`return` 之前）插入：

```javascript
    /* 支持动态透明度（A通道）平滑插值（移植 map.js getIdwColor） */
    function getIdwColor(type, val) {
        var config = METEO_CONFIG[type];
        if (!config || !config.colors) return { r: 0, g: 0, b: 0, a: 0 };
        var colors = config.colors;

        if ((type === "rain" || type === "snow") && val < 0.1)
            return { r: 0, g: 0, b: 0, a: 0 };

        var first = colors[0];
        if (val <= first.val)
            return { r: first.r, g: first.g, b: first.b, a: first.a !== undefined ? first.a : 255 };

        var last = colors[colors.length - 1];
        if (val >= last.val)
            return { r: last.r, g: last.g, b: last.b, a: last.a !== undefined ? last.a : 255 };

        for (var i = 0; i < colors.length - 1; i++) {
            var c1 = colors[i], c2 = colors[i + 1];
            if (val >= c1.val && val <= c2.val) {
                var ratio = (val - c1.val) / (c2.val - c1.val);
                var a1 = c1.a !== undefined ? c1.a : 255;
                var a2 = c2.a !== undefined ? c2.a : 255;
                return {
                    r: Math.round(c1.r + (c2.r - c1.r) * ratio),
                    g: Math.round(c1.g + (c2.g - c1.g) * ratio),
                    b: Math.round(c1.b + (c2.b - c1.b) * ratio),
                    a: Math.round(a1 + (a2 - a1) * ratio),
                };
            }
        }
        return { r: 0, g: 0, b: 0, a: 0 };
    }

    /* 性能引擎：LUT 查找表（移植 map.js getFastLUT）。
       预计算 16384 级色阶，供 GPU LUT 纹理上传。 */
    var _colorLUTs = {};
    function getFastLUT(type) {
        if (_colorLUTs[type]) return _colorLUTs[type];
        var config = METEO_CONFIG[type];
        if (!config || !config.colors) return null;

        var min = config.min !== undefined ? config.min : config.colors[0].val;
        if (type === "rain" || type === "snow") min = 0;

        var max = config.max !== undefined ? config.max : config.colors[config.colors.length - 1].val;
        var steps = 16384;
        var lut = new Uint8ClampedArray(steps * 4);

        for (var i = 0; i < steps; i++) {
            var val = min + (i / (steps - 1)) * (max - min);
            var c = getIdwColor(type, val);
            lut[i * 4] = c.r;
            lut[i * 4 + 1] = c.g;
            lut[i * 4 + 2] = c.b;
            lut[i * 4 + 3] = c.a;
        }
        _colorLUTs[type] = { lut: lut, min: min, max: max, steps: steps };
        return _colorLUTs[type];
    }

    /* 图例信息（对齐 map.js updateLegendUI 的 titleMap + gradient + labels） */
    var TITLE_MAP = {
        temp: "实况表面温度 (℃)",
        rain: "实况降水量 (mm)",
        snow: "地表积雪量热力预测 (mm)",
        windSpeed: "风速能量热力场 (m/s)",
        wind: "风速能量热力场 (m/s)",
        pressure: "实况地表气压 (hPa)",
        isobar: "气压 (hPa)",
        humidity: "相对湿度 (%)",
        radiation: "太阳总辐射 (W/m²)",
        cloud: "总云量 (%)",
    };
    function getLegendInfo(type) {
        var resolveType = resolveMeteoType(type);
        var config = METEO_CONFIG[resolveType];
        if (!config || !config.colors) return null;
        var gradient = "linear-gradient(to right, " +
            config.colors.map(function (c) { return c.hex; }).join(", ") + ")";
        return {
            title: TITLE_MAP[type] || TITLE_MAP[resolveType] || "气象要素",
            gradient: gradient,
            labels: config.colors.map(function (c) { return c.val; }),
        };
    }
```

然后把 `return { ... };` 改为也暴露新函数。找到现有的 return 块：

```javascript
    return {
        METEO_CONFIG: METEO_CONFIG,
        resolveMeteoType: resolveMeteoType,
        extractPointsFromContours: extractPointsFromContours,
        getLayerPointsAt: getLayerPointsAt,
        computeFloatGrid: computeFloatGrid,
    };
```

替换为：

```javascript
    return {
        METEO_CONFIG: METEO_CONFIG,
        resolveMeteoType: resolveMeteoType,
        extractPointsFromContours: extractPointsFromContours,
        getLayerPointsAt: getLayerPointsAt,
        computeFloatGrid: computeFloatGrid,
        getIdwColor: getIdwColor,
        getFastLUT: getFastLUT,
        getLegendInfo: getLegendInfo,
    };
```

- [ ] **Step 4: 运行测试，确认全部通过**

刷新 `gl-meteo.test.html`。
Expected: 全部 `✓`，"全部通过 N/N"（N 应为 Task1 + Task2 断言总数）。

- [ ] **Step 5: Commit**

```bash
git reset HEAD -- weather/pgm/index.css weather/pgm/index.html weather/pgm/index.js weather/pgm/map.js
git add weather/pgm/gl-meteo.js weather/pgm/gl-meteo.test.html
git commit -m "feat(gl): gl-meteo 补色带 LUT/getIdwColor/getLegendInfo + 测试" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
git add weather/pgm/index.css weather/pgm/index.html weather/pgm/index.js weather/pgm/map.js
```

---

## Task 3: gl-fill.js — GLEngine 填色 layer + gl-stage.html 接线验证

> 说明：GL 着色器层无纯单测框架，本任务用"先接线验证页（引用尚不存在的 GLFill）→ 看 console 报错 → 实现 gl-fill.js → 看到填色"作为红→绿循环。视觉验收由用户在 `gl-stage.html` 对比现有 `index.html` 完成（本轮约束：不读取任何图片资源，含自生成）。

**Files:**
- Modify: `weather/pgm/gl-stage.html`（从 stage0 版本扩展为 stage1）
- Create: `weather/pgm/gl-fill.js`

- [ ] **Step 1: 改造 `gl-stage.html` 为阶段 1 接线页（引用尚不存在的 GLFill）**

把 `weather/pgm/gl-stage.html` 整体替换为：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WebGL 气象地图引擎 — 阶段 1（GPU 填色）</title>
<style>
  html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden; background:#1a1a24; font-family:sans-serif; }
  #gl-map { position:absolute; inset:0; width:100%; height:100%; }
  .overlay { position:absolute; top:16px; left:16px; color:#fff; text-shadow:0 2px 4px rgba(0,0,0,0.8); z-index:10; pointer-events:none; }
  .overlay h1 { margin:0 0 6px; font-size:18px; letter-spacing:1px; }
  .overlay p { margin:0; font-size:12px; color:#ccc; max-width:420px; line-height:1.5; }
  #hint { position:absolute; bottom:16px; left:16px; color:#9af; font-size:12px; z-index:10; pointer-events:none; }
  .toolbar { position:absolute; top:16px; right:16px; display:flex; flex-direction:column; gap:6px; z-index:10; }
  .toolbar button { padding:6px 12px; font-size:12px; border:1px solid #3a4a6a; background:rgba(20,30,50,0.85); color:#cde; border-radius:4px; cursor:pointer; }
  .toolbar button.active { background:#2a6cff; color:#fff; border-color:#5a8cff; }
  .legend { position:absolute; bottom:30px; left:50%; transform:translateX(-50%); width:340px; z-index:10; pointer-events:none; }
  .legend-title { color:#fff; font-size:12px; text-align:center; margin-bottom:6px; text-shadow:0 1px 3px #000; }
  .legend-bar { width:100%; height:8px; border-radius:4px; }
  .legend-labels { display:flex; justify-content:space-between; margin-top:4px; }
  .legend-labels span { color:#cde; font-size:10px; text-shadow:0 1px 2px #000; }
</style>
</head>
<body>
  <div class="overlay">
    <h1>WebGL 青海气象图（阶段 1：GPU 填色）</h1>
    <p>真实 cmiss 站点 → IDW → 数据纹理 → LUT 色带着色器 → 与底图 multiply 混合 → alpha 裁剪。</p>
  </div>
  <div id="hint">拖拽平移 · 滚轮缩放（光标为中心）· 双击放大 · 右上切换要素</div>
  <div id="gl-map"></div>

  <div class="toolbar" id="toolbar"></div>
  <div class="legend" id="legend" style="display:none;">
    <div class="legend-title" id="legend-title"></div>
    <div class="legend-bar" id="legend-bar"></div>
    <div class="legend-labels" id="legend-labels"></div>
  </div>

  <script src="../base/rs/js/cmiss.js"></script>
  <script src="./gl-proj.js"></script>
  <script src="./gl-engine.js"></script>
  <script src="./gl-meteo.js"></script>
  <script src="./gl-fill.js"></script>
  <script>
    var BOUNDS = [[31.5, 89.4], [39.3, 103.2]];
    var BASE_URL = '../base/rs/img/qinghai_map.png';

    var engine = GLEngine.init('gl-map', { center:[96.2,35.4], zoom:6, minZoom:4, maxZoom:12 });
    engine.setBaseMap(BASE_URL, { bounds: BOUNDS });
    engine.fitBounds(BOUNDS, { paddingTopLeft:[88,60], paddingBottomRight:[250,60] });

    var fillLayer = GLFill.create({ baseUrl: BASE_URL, bounds: BOUNDS, gridCols: 240 });
    engine.addLayer(fillLayer);

    var steps = (CMISS_DATA && CMISS_DATA.data) ? CMISS_DATA.data.length : 0;
    var idx = Math.floor(steps / 2);
    fillLayer.setData(CMISS_DATA);
    fillLayer.setElement('temp', idx);

    var TYPES = ['temp','rain','snow','windSpeed','pressure','isobar','humidity','radiation','cloud'];
    var tb = document.getElementById('toolbar');
    TYPES.forEach(function (t) {
      var b = document.createElement('button');
      b.textContent = t;
      if (t === 'temp') b.classList.add('active');
      b.onclick = function () {
        document.querySelectorAll('.toolbar button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        fillLayer.setElement(t, idx);
      };
      tb.appendChild(b);
    });

    fillLayer.onLegendChange(function (info) {
      var box = document.getElementById('legend');
      if (!info) { box.style.display = 'none'; return; }
      box.style.display = '';
      document.getElementById('legend-title').textContent = info.title;
      document.getElementById('legend-bar').style.background = info.gradient;
      var lbls = document.getElementById('legend-labels');
      lbls.innerHTML = info.labels.map(function (l) { return '<span>' + l + '</span>'; }).join('');
    });

    engine.on('click', function (e) {
      console.log('[click] lng,lat =', e.lng.toFixed(3)+','+e.lat.toFixed(3));
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: 打开页面，确认报错（红）**

用本地服务器访问 `weather/pgm/gl-stage.html`。
Expected: 控制台报 `GLFill is not defined` 或 `404` 加载 `gl-fill.js` 失败（因为文件尚未创建）。页面只显示 stage0 的底图，无填色、无工具栏按钮生效。

- [ ] **Step 3: 实现 `gl-fill.js`（完整 layer + 着色器）**

创建 `weather/pgm/gl-fill.js`，内容：

```javascript
/**
 * GLFill — GLEngine 填色 layer（阶段 1）
 * 自持底图/数据/LUT 三张纹理，片元着色器内完成：
 *   NDC→px→lng/lat（复用 stage0 投影）→ 数据纹理手动双线性采样 → LUT 查色 → 与底图 multiply 混合 → alpha 裁剪。
 * 数据纹理用 WebGL1 原生 LUMINANCE 单通道（归一化 RGBA8 等价的 0-255 值），免 float 扩展。
 * 自加载底图纹理用于 multiply 采样，故 GLEngine（stage0）零改动。
 */
var GLFill = (function () {
    function create(opts) {
        opts = opts || {};
        var bounds = opts.bounds || [[31.5, 89.4], [39.3, 103.2]];
        var south = bounds[0][0], west = bounds[0][1];
        var north = bounds[1][0], east = bounds[1][1];
        var baseUrl = opts.baseUrl || '../base/rs/img/qinghai_map.png';
        var gridCols = opts.gridCols || 240;
        var gridRows = Math.ceil(gridCols * ((north - south) / (east - west)));

        var gl = null, program = null;
        var baseTexture = null, dataTexture = null, lutTexture = null;
        var quadBuffer = null, aPos = -1;
        var U = {};
        var baseLoaded = false;
        var activeType = null;
        var timeSeriesContours = []; // [[contours], ...]
        var currentNormData = new Uint8Array(gridCols * gridRows);
        var pending = null; // {type, idx}
        var legendListeners = [];

        var vsSrc = [
            'attribute vec2 a_pos;',
            'varying vec2 v_ndc;',
            'void main() {',
            '  v_ndc = a_pos;',
            '  gl_Position = vec4(a_pos, 0.0, 1.0);',
            '}',
        ].join('\n');

        var fsSrc = [
            'precision highp float;',
            'varying vec2 v_ndc;',
            'uniform sampler2D u_baseMap;',
            'uniform sampler2D u_data;',
            'uniform sampler2D u_lut;',
            'uniform vec2 u_resolution;',
            'uniform float u_centerLng, u_centerLat, u_pxPerDeg;',
            'uniform float u_boundsWest, u_boundsEast, u_boundsSouth, u_boundsNorth;',
            'uniform float u_dataCols, u_dataRows;',
            'uniform float u_hasData;',
            'uniform float u_baseLoaded;',
            'void main() {',
            '  if (u_baseLoaded < 0.5) { gl_FragColor = vec4(0.1,0.1,0.15,1.0); return; }',
            '  vec2 px = (v_ndc * 0.5 + 0.5) * u_resolution;',
            '  float lng = u_centerLng + (px.x - u_resolution.x*0.5) / u_pxPerDeg;',
            '  float lat = u_centerLat - (px.y - u_resolution.y*0.5) / u_pxPerDeg;',
            '  float bu = (lng - u_boundsWest) / (u_boundsEast - u_boundsWest);',
            '  float bv = (u_boundsNorth - lat) / (u_boundsNorth - u_boundsSouth);',
            '  vec4 mapColor = texture2D(u_baseMap, vec2(clamp(bu,0.0,1.0), clamp(bv,0.0,1.0)));',
            '  if (mapColor.a < 0.1) { gl_FragColor = vec4(0.1,0.1,0.15,1.0); return; }',
            '  if (u_hasData < 0.5) { gl_FragColor = mapColor; return; }',
            '  float gu = (lng - u_boundsWest) / (u_boundsEast - u_boundsWest);',
            '  float gv = (u_boundsNorth - lat) / (u_boundsNorth - u_boundsSouth);',
            '  vec2 g = vec2(clamp(gu,0.0,1.0), clamp(gv,0.0,1.0));',
            '  float tx = g.x * (u_dataCols - 1.0);',
            '  float ty = g.y * (u_dataRows - 1.0);',
            '  float x0 = floor(tx), y0 = floor(ty);',
            '  float fx = tx - x0, fy = ty - y0;',
            '  float v00 = texture2D(u_data, vec2((x0+0.5)/u_dataCols, (y0+0.5)/u_dataRows)).r;',
            '  float v10 = texture2D(u_data, vec2((x0+1.5)/u_dataCols, (y0+0.5)/u_dataRows)).r;',
            '  float v01 = texture2D(u_data, vec2((x0+0.5)/u_dataCols, (y0+1.5)/u_dataRows)).r;',
            '  float v11 = texture2D(u_data, vec2((x0+1.5)/u_dataCols, (y0+1.5)/u_dataRows)).r;',
            '  float norm = mix(mix(v00,v10,fx), mix(v01,v11,fx), fy);',
            '  vec4 weather = texture2D(u_lut, vec2(clamp(norm,0.0,1.0), 0.5));',
            '  vec3 blended = mapColor.rgb * weather.rgb;',
            '  gl_FragColor = vec4(mix(mapColor.rgb, blended, weather.a), 1.0);',
            '}',
        ].join('\n');

        function compile(type, src) {
            var s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                console.error(gl.getShaderInfoLog(s));
                return null;
            }
            return s;
        }

        function initGL(_gl) {
            gl = _gl;
            program = gl.createProgram();
            gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
            gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
            gl.linkProgram(program);

            aPos = gl.getAttribLocation(program, 'a_pos');
            quadBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);

            U.baseMap = gl.getUniformLocation(program, 'u_baseMap');
            U.data = gl.getUniformLocation(program, 'u_data');
            U.lut = gl.getUniformLocation(program, 'u_lut');
            U.resolution = gl.getUniformLocation(program, 'u_resolution');
            U.centerLng = gl.getUniformLocation(program, 'u_centerLng');
            U.centerLat = gl.getUniformLocation(program, 'u_centerLat');
            U.pxPerDeg = gl.getUniformLocation(program, 'u_pxPerDeg');
            U.bW = gl.getUniformLocation(program, 'u_boundsWest');
            U.bE = gl.getUniformLocation(program, 'u_boundsEast');
            U.bS = gl.getUniformLocation(program, 'u_boundsSouth');
            U.bN = gl.getUniformLocation(program, 'u_boundsNorth');
            U.dataCols = gl.getUniformLocation(program, 'u_dataCols');
            U.dataRows = gl.getUniformLocation(program, 'u_dataRows');
            U.hasData = gl.getUniformLocation(program, 'u_hasData');
            U.baseLoaded = gl.getUniformLocation(program, 'u_baseLoaded');

            // 底图纹理（自加载，用于 multiply 采样）
            baseTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, baseTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            var img = new Image();
            img.onload = function () {
                gl.bindTexture(gl.TEXTURE_2D, baseTexture);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
                baseLoaded = true;
                console.log('[GLFill] 底图加载完成');
            };
            img.onerror = function () { console.error('[GLFill] 底图加载失败: ' + baseUrl); };
            img.src = baseUrl;

            // 数据纹理（LUMINANCE 单通道，NEAREST，手动双线性在着色器内做）
            dataTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, dataTexture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gridCols, gridRows, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, currentNormData);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

            // LUT 纹理（1xN RGBA，NEAREST，切要素时重传）
            lutTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, lutTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,0]));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        }

        function uploadData(type, timeIndex) {
            var resolveType = GLMeteo.resolveMeteoType(type);
            var contours = timeSeriesContours[timeIndex] || [];
            var points = GLMeteo.getLayerPointsAt(type, contours);
            var gridData = GLMeteo.computeFloatGrid(points, resolveType, gridCols, gridRows, west, east, south, north);
            var cfg = GLMeteo.METEO_CONFIG[resolveType];
            var min = (resolveType === 'rain' || resolveType === 'snow') ? 0 : cfg.min;
            var max = cfg.max;
            var span = (max - min) || 1;
            var grid = gridData.grid;
            var n = gridCols * gridRows;
            for (var i = 0; i < n; i++) {
                var ratio = (grid[i] - min) / span;
                if (ratio < 0) ratio = 0; else if (ratio > 1) ratio = 1;
                currentNormData[i] = Math.round(ratio * 255);
            }
            var lutData = GLMeteo.getFastLUT(resolveType);
            if (!gl) return;
            gl.bindTexture(gl.TEXTURE_2D, dataTexture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gridCols, gridRows, gl.LUMINANCE, gl.UNSIGNED_BYTE, currentNormData);
            gl.bindTexture(gl.TEXTURE_2D, lutTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lutData.steps, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutData.lut);
            activeType = type;
        }

        function emitLegend(type) {
            var info = type ? GLMeteo.getLegendInfo(type) : null;
            legendListeners.forEach(function (fn) { try { fn(info); } catch (e) { console.error(e); } });
        }

        function flushPending() {
            if (!pending || !gl) return;
            var p = pending; pending = null;
            uploadData(p.type, p.idx);
        }

        var layer = {
            render: function (glArg, view, api) {
                if (!gl) initGL(glArg);
                if (!program) return;
                flushPending();
                gl.useProgram(program);
                gl.uniform2f(U.resolution, view.width, view.height);
                gl.uniform1f(U.centerLng, view.centerLng);
                gl.uniform1f(U.centerLat, view.centerLat);
                gl.uniform1f(U.pxPerDeg, view.pxPerDeg);
                gl.uniform1f(U.bW, west); gl.uniform1f(U.bE, east);
                gl.uniform1f(U.bS, south); gl.uniform1f(U.bN, north);
                gl.uniform1f(U.dataCols, gridCols); gl.uniform1f(U.dataRows, gridRows);
                gl.uniform1f(U.hasData, activeType ? 1.0 : 0.0);
                gl.uniform1f(U.baseLoaded, baseLoaded ? 1.0 : 0.0);
                gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, baseTexture); gl.uniform1i(U.baseMap, 0);
                gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, dataTexture); gl.uniform1i(U.data, 1);
                gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, lutTexture); gl.uniform1i(U.lut, 2);
                gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
                gl.enableVertexAttribArray(aPos);
                gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            },
            setData: function (cmissData) {
                timeSeriesContours = ((cmissData && cmissData.data) || []).map(function (item) {
                    return item.contours || [];
                });
                return layer;
            },
            setElement: function (type, timeIndex) {
                pending = { type: type, idx: timeIndex };
                if (gl) flushPending();
                emitLegend(type);
                return layer;
            },
            getActiveType: function () { return activeType; },
            onLegendChange: function (fn) {
                if (typeof fn === 'function') legendListeners.push(fn);
                if (activeType) emitLegend(activeType);
                return layer;
            },
            destroy: function () {
                if (!gl) return;
                if (baseTexture) gl.deleteTexture(baseTexture);
                if (dataTexture) gl.deleteTexture(dataTexture);
                if (lutTexture) gl.deleteTexture(lutTexture);
                if (quadBuffer) gl.deleteBuffer(quadBuffer);
                if (program) gl.deleteProgram(program);
            },
        };
        return layer;
    }

    return { create: create };
})();
```

- [ ] **Step 4: 打开页面，确认填色出现（绿）**

刷新 `gl-stage.html`。
Expected:
- 控制台无报错，打印 `[GLFill] 底图加载完成`。
- 青海省内出现温度填色（彩虹色带，与现有 index.html 切到"温度"一致），省外深色背景（裁剪）。
- 右上工具栏 9 个按钮，`temp` 高亮。
- 底部图例显示"实况表面温度 (℃)" + 彩虹渐变条 + 刻度。

- [ ] **Step 5: 交互验收**

在 `gl-stage.html` 上：
1. 点击工具栏其他要素（rain/snow/windSpeed/pressure/isobar/humidity/radiation/cloud），填色与图例随之切换，色带与现有 index.html 同要素一致。
2. 拖拽地图平移，填色正确跟随，与底图不错位。
3. 滚轮缩放（光标为中心），缩放后填色跟随，光标下位置不变。
4. 双击放大一级，填色跟随。
5. 现有 `index.html` 行为完全不变（零改动，打开确认仍正常）。

如有要素填色与现有明显不一致，记录要素名与差异，回头校准 `uploadData` 的 min/max 或 `METEO_CONFIG`（本阶段为移植，应一致）。

- [ ] **Step 6: Commit**

```bash
git reset HEAD -- weather/pgm/index.css weather/pgm/index.html weather/pgm/index.js weather/pgm/map.js
git add weather/pgm/gl-fill.js weather/pgm/gl-stage.html
git commit -m "feat(gl): 新增 GPU 填色 layer（gl-fill）+ 阶段1验证页接线" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
git add weather/pgm/index.css weather/pgm/index.html weather/pgm/index.js weather/pgm/map.js
```

---

## 验收对照（spec §9）

| spec 验收点 | 对应任务 |
| --- | --- |
| 1. 9 要素填色色带与现有一致 | Task 2（LUT 移植）+ Task 3 Step 5.1 |
| 2. 切换要素图例同步 | Task 2（getLegendInfo）+ Task 3 Step 5.1 |
| 3. 省内填色/省外深色背景裁剪 | Task 3 着色器 alpha 分支 + Step 5 |
| 4. 拖拽/缩放/双击下填色跟随 | Task 3 Step 5.2-5.4 |
| 5. 现有 index.html 行为不变 | Task 3 Step 5.5 |
| 6. WebGL 不支持时降级 | 沿用 stage0（gl-engine.js 已有降级提示） |

## 后续阶段衔接（非本计划范围）

- 阶段 2（光流）：`setElement` 改持有 from/to 两张数据纹理，着色器做光流位移插值；RGBA8 精度不足时升 float。
- 阶段 3（粒子）：雨/雪/风粒子经 `addLayer` 注入，复用 view 投影 + 数据纹理 mask。
- 阶段 4（等压线）：marching squares CPU 算线段，GPU 画线 + H/L。
- 阶段 5（叠加层）：场站/地名/popup DOM 叠加，最终替换 index.html、退役 map.js、消除 gl-meteo 重复。
