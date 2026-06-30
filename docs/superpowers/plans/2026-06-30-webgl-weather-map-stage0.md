# WebGL 气象地图引擎 — 阶段 0 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建一个可交互的 WebGL 青海底图引擎（投影 / 缩放平移拖拽双击 / 底图 alpha 裁剪 / resize），为后续 5 个阶段把现有 Leaflet 气象效果迁移到 GPU 打地基。

**Architecture:** 投影数学抽成纯函数模块 `gl-proj.js`（零依赖、可测）；`gl-engine.js` 是 IIFE 引擎模块，负责 WebGL 上下文、全屏 quad 渲染管线、view uniform、交互与事件分发；`gl-stage.html` 是阶段验证页。底图经纬度↔纹理 UV 在片元着色器内线性反推，青海省外（底图 alpha<0.1）渲染深色背景，复刻 demo 的 GPU 裁剪思路。

**Tech Stack:** 原生 WebGL1（无三方库）、ES5 IIFE 风格（对齐现有 map.js）、Plate Carrée 线性投影、零依赖 HTML 断言页做 TDD。

**对应 spec:** `docs/superpowers/specs/2026-06-30-webgl-weather-map-stage0-design.md`

---

## 文件结构

| 文件 | 责任 | 本次 |
| --- | --- | --- |
| `weather/pgm/gl-proj.js` | 纯投影数学：`makeView / project / unproject / clampZoom / clampCenter / zoomAt / fitBounds`。零 GL/DOM 依赖，可测。 | 新建 |
| `weather/pgm/gl-proj.test.html` | 零依赖断言页：加载 gl-proj.js，跑 round-trip / clamp / zoomAt / fitBounds 断言，显示 PASS/FAIL。TDD 用。 | 新建 |
| `weather/pgm/gl-engine.js` | `GLEngine` IIFE 模块：canvas/GL 初始化、resize、底图纹理、全屏 quad 渲染管线、view uniform、交互、事件、对外 API、加载遮罩、图层容器。依赖 gl-proj。 | 新建 |
| `weather/pgm/gl-stage.html` | 阶段验证页：加载 gl-engine.js + gl-proj.js，设底图、fitBounds、点击打印经纬度。 | 新建 |

现有 `index.html / map.js / index.js` 本次**不改**。

**投影数学（Plate Carrée）核心**（所有任务共用，先在此定死）：
- `view = { centerLng, centerLat, zoom, width, height, pxPerDeg, minZoom, maxZoom }`
- `pxPerDeg = BASE_PX_PER_DEG * 2^zoom`，`BASE_PX_PER_DEG = 1`（zoom=6 → 64 px/deg，青海宽 ~883px 约铺满视口）
- `project([lng,lat]) = [ width/2 + (lng-centerLng)*pxPerDeg , height/2 - (lat-centerLat)*pxPerDeg ]`（纬度向上、屏幕 y 向下故取负）
- `unproject([px,py]) = [ centerLng + (px-width/2)/pxPerDeg , centerLat - (py-height/2)/pxPerDeg ]`
- `bounds` 统一为 `[[south, west], [north, east]]`

---

## Task 1: 投影纯函数 gl-proj.js（TDD）

**Files:**
- Create: `weather/pgm/gl-proj.js`
- Test: `weather/pgm/gl-proj.test.html`

- [ ] **Step 1: 写失败测试页 gl-proj.test.html**

创建 `weather/pgm/gl-proj.test.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>gl-proj 纯函数测试</title>
<style>
  body { font-family: monospace; padding: 20px; background:#111; color:#eee; }
  .pass { color: #6f6; }
  .fail { color: #f66; font-weight: bold; }
  #out { white-space: pre-wrap; }
</style>
</head>
<body>
<h2>gl-proj 测试</h2>
<div id="out"></div>
<script src="./gl-proj.js"></script>
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

  var v = GLProj.makeView(96.2, 35.4, 6, 1200, 800, { minZoom: 4, maxZoom: 12 });
  assert('makeView.pxPerDeg (zoom6 → 64)', v.pxPerDeg, 64);
  assert('makeView 存 minZoom', v.minZoom, 4);
  assert('makeView 存 maxZoom', v.maxZoom, 12);

  // round-trip: project → unproject 回到原值
  var ll = [100.0, 37.0];
  var px = GLProj.project(ll, v);
  var back = GLProj.unproject(px, v);
  assert('round-trip project/unproject', back, ll);

  // 中心点投影到屏幕中心
  assert('中心投影到视口中心', GLProj.project([96.2, 35.4], v), [600, 400]);

  // clampZoom
  assert('clampZoom 上限', GLProj.clampZoom(20, 4, 12), 12);
  assert('clampZoom 下限', GLProj.clampZoom(1, 4, 12), 4);
  assert('clampZoom 区间内不变', GLProj.clampZoom(7, 4, 12), 7);

  // clampCenter 限制在 bounds 内
  var b = [[31.5, 89.4], [39.3, 103.2]];
  assert('clampCenter 越界西', GLProj.clampCenter(80, 35, b), [89.4, 35]);
  assert('clampCenter 越界东', GLProj.clampCenter(110, 35, b), [103.2, 35]);
  assert('clampCenter 越界南', GLProj.clampCenter(96, 30, b), [96, 31.5]);
  assert('clampCenter 区间内不变', GLProj.clampCenter(96, 35, b), [96, 35]);

  // zoomAt: 锚点经纬度缩放后不变
  var anchor = [700, 300];
  var r = GLProj.zoomAt(v, 8, anchor);
  var v2 = GLProj.makeView(r.centerLng, r.centerLat, r.zoom, 1200, 800, { minZoom: 4, maxZoom: 12 });
  assert('zoomAt 锚点经纬度不变', GLProj.unproject(anchor, v2), GLProj.unproject(anchor, v));
  assert('zoomAt zoom 钳到上限', GLProj.zoomAt(v, 99, anchor).zoom, 12);

  // fitBounds: 完整容纳青海
  var fit = GLProj.fitBounds(b, 1200, 800, [88, 60, 250, 60], { minZoom: 4, maxZoom: 12 });
  assert('fitBounds 中心经度', fit.centerLng, (89.4 + 103.2) / 2);
  assert('fitBounds 中心纬度', fit.centerLat, (31.5 + 39.3) / 2);
  // 容纳后青海应铺满可视区（可视宽 1200-88-250=862，青海经度跨度 13.8 → pxPerDegX≈62.5；可视高 800-60-60=680，纬度跨度 7.8 → pxPerDegY≈87；取小≈62.5 → zoom≈log2(62.5)≈5.97）
  assert('fitBounds zoom≈5.97', approx(fit.zoom, Math.log2(Math.min(862 / 13.8, 680 / 7.8)), 1e-3), true);

  out.innerHTML += '\n---- ' + pass + ' passed, ' + fail + ' failed ----';
})();
</script>
</body>
</html>
```

- [ ] **Step 2: 运行测试页，确认全红（GLProj 未定义）**

用 Live Server 打开 `weather/pgm/gl-proj.test.html`（或双击 file:// 打开）。
Expected: 页面显示若干 `✗`，且浏览器控制台报 `GLProj is not defined`（因为 gl-proj.js 还没创建）。这是预期的失败。

- [ ] **Step 3: 实现 gl-proj.js 使测试通过**

创建 `weather/pgm/gl-proj.js`：

```js
/**
 * GLProj — 纯投影数学模块（Plate Carrée 线性经纬度投影）
 * 零 GL/DOM 依赖，可独立测试。bounds 统一为 [[south, west], [north, east]]。
 */
var GLProj = (function () {
    /* BASE_PX_PER_DEG=1：zoom=6 时 pxPerDeg=64，青海经度跨度 ~13.8° → ~883px 约铺满视口 */
    var BASE_PX_PER_DEG = 1;

    function makeView(centerLng, centerLat, zoom, width, height, opts) {
        opts = opts || {};
        var z = clampZoom(zoom, opts.minZoom != null ? opts.minZoom : 4, opts.maxZoom != null ? opts.maxZoom : 12);
        return {
            centerLng: centerLng,
            centerLat: centerLat,
            zoom: z,
            width: width,
            height: height,
            minZoom: opts.minZoom != null ? opts.minZoom : 4,
            maxZoom: opts.maxZoom != null ? opts.maxZoom : 12,
            pxPerDeg: BASE_PX_PER_DEG * Math.pow(2, z),
        };
    }

    /* [lng,lat] → 屏幕像素 [px,py]（屏幕原点左上，y 向下；纬度向上故取负） */
    function project(lngLat, view) {
        var lng = lngLat[0], lat = lngLat[1];
        var px = view.width / 2 + (lng - view.centerLng) * view.pxPerDeg;
        var py = view.height / 2 - (lat - view.centerLat) * view.pxPerDeg;
        return [px, py];
    }

    /* 屏幕 [px,py] → [lng,lat] */
    function unproject(pxPy, view) {
        var px = pxPy[0], py = pxPy[1];
        var lng = view.centerLng + (px - view.width / 2) / view.pxPerDeg;
        var lat = view.centerLat - (py - view.height / 2) / view.pxPerDeg;
        return [lng, lat];
    }

    function clampZoom(zoom, minZoom, maxZoom) {
        if (zoom < minZoom) return minZoom;
        if (zoom > maxZoom) return maxZoom;
        return zoom;
    }

    /* 限制 center 落在 bounds 经纬度范围内（不飞出青海太远） */
    function clampCenter(centerLng, centerLat, bounds) {
        var south = bounds[0][0], west = bounds[0][1];
        var north = bounds[1][0], east = bounds[1][1];
        if (centerLng < west) centerLng = west;
        else if (centerLng > east) centerLng = east;
        if (centerLat < south) centerLat = south;
        else if (centerLat > north) centerLat = north;
        return [centerLng, centerLat];
    }

    /* 以屏幕点 anchorPxPy 为锚缩放到 newZoom：缩放后该屏幕点下的经纬度不变。
       返回 {centerLng, centerLat, zoom}（zoom 已钳制）。 */
    function zoomAt(view, newZoom, anchorPxPy) {
        var z = clampZoom(newZoom, view.minZoom, view.maxZoom);
        var anchorLL = unproject(anchorPxPy, view);
        var newPxPerDeg = BASE_PX_PER_DEG * Math.pow(2, z);
        /* 反解：在新 pxPerDeg 下让 anchor 仍落在 anchorPxPy */
        var cx = anchorLL[0] - (anchorPxPy[0] - view.width / 2) / newPxPerDeg;
        var cy = anchorLL[1] + (anchorPxPy[1] - view.height / 2) / newPxPerDeg;
        return { centerLng: cx, centerLat: cy, zoom: z };
    }

    /* 计算 fitBounds：padding=[left, top, right, bottom]（CSS 像素）。
       返回 {centerLng, centerLat, zoom}，使 bounds 完整容纳在扣除 padding 的可视区内。 */
    function fitBounds(bounds, width, height, padding, opts) {
        opts = opts || {};
        var south = bounds[0][0], west = bounds[0][1];
        var north = bounds[1][0], east = bounds[1][1];
        var padLeft = padding[0], padTop = padding[1], padRight = padding[2], padBottom = padding[3];
        var visW = width - padLeft - padRight;
        var visH = height - padTop - padBottom;
        var spanLng = east - west || 1;
        var spanLat = north - south || 1;
        var pxPerDegX = visW / spanLng;
        var pxPerDegY = visH / spanLat;
        var pxPerDeg = Math.min(pxPerDegX, pxPerDegY);
        var zoom = Math.log2(pxPerDeg / BASE_PX_PER_DEG);
        zoom = clampZoom(zoom, opts.minZoom != null ? opts.minZoom : 4, opts.maxZoom != null ? opts.maxZoom : 12);
        return {
            centerLng: (west + east) / 2,
            centerLat: (south + north) / 2,
            zoom: zoom,
        };
    }

    function applyView(view, partial) {
        view.centerLng = partial.centerLng != null ? partial.centerLng : view.centerLng;
        view.centerLat = partial.centerLat != null ? partial.centerLat : view.centerLat;
        view.zoom = partial.zoom != null ? partial.zoom : view.zoom;
        view.zoom = clampZoom(view.zoom, view.minZoom, view.maxZoom);
        view.pxPerDeg = BASE_PX_PER_DEG * Math.pow(2, view.zoom);
    }

    return {
        BASE_PX_PER_DEG: BASE_PX_PER_DEG,
        makeView: makeView,
        project: project,
        unproject: unproject,
        clampZoom: clampZoom,
        clampCenter: clampCenter,
        zoomAt: zoomAt,
        fitBounds: fitBounds,
        applyView: applyView,
    };
})();
```

- [ ] **Step 4: 运行测试页，确认全绿**

刷新 `weather/pgm/gl-proj.test.html`。
Expected: 全部 `✓`，末行 `N passed, 0 failed`。若有失败，对照断言名修正 gl-proj.js。

- [ ] **Step 5: 提交**

```bash
git add weather/pgm/gl-proj.js weather/pgm/gl-proj.test.html
git commit -m "$(cat <<'EOF'
feat(gl): 新增纯投影数学模块 gl-proj 及零依赖测试页

Plate Carrée 线性经纬度投影：makeView/project/unproject/clampZoom/
clampCenter/zoomAt/fitBounds。纯函数无 GL/DOM 依赖，附 gl-proj.test.html
断言页覆盖 round-trip/clamp/zoomAt 锚点不变/fitBounds 容纳。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: GLEngine — GL 初始化 / resize / 底图纹理 / 全屏 quad 渲染管线（固定 view 先看底图）

**Files:**
- Create: `weather/pgm/gl-engine.js`
- Create: `weather/pgm/gl-stage.html`

本任务先用一个固定 view（zoom=6、青海中心）把底图画出来并验证裁剪；view 随交互变化留到 Task 3/4。

- [ ] **Step 1: 写 gl-stage.html 验证页骨架**

创建 `weather/pgm/gl-stage.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WebGL 气象地图引擎 — 阶段 0</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #1a1a24; font-family: sans-serif; }
  #gl-map { position: absolute; inset: 0; width: 100%; height: 100%; }
  .overlay { position: absolute; top: 16px; left: 16px; color: #fff; text-shadow: 0 2px 4px rgba(0,0,0,0.8); z-index: 10; pointer-events: none; }
  .overlay h1 { margin: 0 0 6px; font-size: 18px; letter-spacing: 1px; }
  .overlay p { margin: 0; font-size: 12px; color: #ccc; max-width: 420px; line-height: 1.5; }
  #hint { position: absolute; bottom: 16px; left: 16px; color: #9af; font-size: 12px; z-index: 10; pointer-events: none; }
</style>
</head>
<body>
  <div class="overlay">
    <h1>WebGL 青海地图引擎（阶段 0）</h1>
    <p>底图：../base/rs/img/qinghai_map.png ｜ GPU alpha 裁剪：省外深色背景。</p>
  </div>
  <div id="hint">拖拽平移 · 滚轮缩放（光标为中心）· 双击放大 · 点击查看经纬度（控制台）</div>
  <div id="gl-map"></div>

  <script src="./gl-proj.js"></script>
  <script src="./gl-engine.js"></script>
  <script>
    var engine = GLEngine.init('gl-map', {
      center: [96.2, 35.4],
      zoom: 6,
      minZoom: 4,
      maxZoom: 12,
    });
    engine.setBaseMap('../base/rs/img/qinghai_map.png', {
      bounds: [[31.5, 89.4], [39.3, 103.2]],
    });
    engine.fitBounds([[31.5, 89.4], [39.3, 103.2]], {
      paddingTopLeft: [88, 60],
      paddingBottomRight: [250, 60],
    });
    engine.on('click', function (e) {
      console.log('[click] lng,lat =', e.lng.toFixed(3) + ',' + e.lat.toFixed(3), ' px=', e.px.toFixed(0) + ',' + e.py.toFixed(0));
    });
    engine.on('moveend', function (e) {
      console.log('[moveend] center=', e.center.map(function (x) { return x.toFixed(3); }), ' zoom=', e.zoom.toFixed(2));
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: 实现 gl-engine.js 骨架（GL 初始化 + resize + 不支持提示 + 底图纹理 + 渲染管线），固定 view**

创建 `weather/pgm/gl-engine.js`：

```js
/**
 * GLEngine — WebGL 地图引擎（阶段 0：底图 + 投影 + 交互 + 裁剪）
 * 复刻 new.html demo 的 GPU 渲染思路：全屏 quad + 片元着色器内经纬度↔底图 UV 线性反推 +
 * 底图 alpha 通道裁剪（省外深色背景）。投影数学由 gl-proj.js 提供。
 */
var GLEngine = (function () {
    var DEFAULTS = { center: [96.2, 35.4], zoom: 6, minZoom: 4, maxZoom: 12 };

    function init(containerId, opts) {
        opts = opts || {};
        var container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
        if (!container) throw new Error('GLEngine: container not found: ' + containerId);

        var canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        container.appendChild(canvas);

        var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) {
            container.innerHTML = '<div style="color:#f66;padding:20px;">您的浏览器不支持 WebGL</div>';
            return null;
        }

        /* ---- 着色器 ---- */
        var vsSrc = [
            'attribute vec2 a_pos;',
            'varying vec2 v_ndc;',
            'void main() {',
            '  v_ndc = a_pos;',
            '  gl_Position = vec4(a_pos, 0.0, 1.0);',
            '}',
        ].join('\n');
        /* 片元着色器：NDC→屏幕像素(CSS)→经纬度→底图 UV(线性)→采样→alpha 裁剪。
           注意：纹理不翻转(UNPACK_FLIP_Y=false)，v=(north-lat)/(north-south) 自行控制方向。 */
        var fsSrc = [
            'precision highp float;',
            'varying vec2 v_ndc;',
            'uniform sampler2D u_baseMap;',
            'uniform vec2 u_resolution;',
            'uniform float u_centerLng, u_centerLat, u_pxPerDeg;',
            'uniform float u_boundsWest, u_boundsEast, u_boundsSouth, u_boundsNorth;',
            'uniform float u_baseLoaded;',
            'void main() {',
            '  vec2 px = (v_ndc * 0.5 + 0.5) * u_resolution;',
            '  float lng = u_centerLng + (px.x - u_resolution.x * 0.5) / u_pxPerDeg;',
            '  float lat = u_centerLat - (px.y - u_resolution.y * 0.5) / u_pxPerDeg;',
            '  float u = (lng - u_boundsWest) / (u_boundsEast - u_boundsWest);',
            '  float v = (u_boundsNorth - lat) / (u_boundsNorth - u_boundsSouth);',
            '  vec4 mapColor = texture2D(u_baseMap, vec2(u, v));',
            '  if (u_baseLoaded < 0.5) { gl_FragColor = vec4(0.1, 0.1, 0.15, 1.0); return; }',
            '  if (mapColor.a < 0.1) { gl_FragColor = vec4(0.1, 0.1, 0.15, 1.0); return; }',
            '  gl_FragColor = mapColor;',
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
        var program = gl.createProgram();
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
        gl.linkProgram(program);
        gl.useProgram(program);

        var aPos = gl.getAttribLocation(program, 'a_pos');
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        var U = {
            baseMap: gl.getUniformLocation(program, 'u_baseMap'),
            resolution: gl.getUniformLocation(program, 'u_resolution'),
            centerLng: gl.getUniformLocation(program, 'u_centerLng'),
            centerLat: gl.getUniformLocation(program, 'u_centerLat'),
            pxPerDeg: gl.getUniformLocation(program, 'u_pxPerDeg'),
            bW: gl.getUniformLocation(program, 'u_boundsWest'),
            bE: gl.getUniformLocation(program, 'u_boundsEast'),
            bS: gl.getUniformLocation(program, 'u_boundsSouth'),
            bN: gl.getUniformLocation(program, 'u_boundsNorth'),
            baseLoaded: gl.getUniformLocation(program, 'u_baseLoaded'),
        };

        /* ---- 底图纹理 ---- */
        var baseTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, baseTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        var baseLoaded = false;
        var baseBounds = null;

        /* ---- view ---- */
        var center = opts.center || DEFAULTS.center;
        var view = GLProj.makeView(center[0], center[1], opts.zoom != null ? opts.zoom : DEFAULTS.zoom, 1, 1, {
            minZoom: opts.minZoom != null ? opts.minZoom : DEFAULTS.minZoom,
            maxZoom: opts.maxZoom != null ? opts.maxZoom : DEFAULTS.maxZoom,
        });

        function resize() {
            var dpr = window.devicePixelRatio || 1;
            var w = container.clientWidth || window.innerWidth;
            var h = container.clientHeight || window.innerHeight;
            canvas.width = Math.max(1, Math.floor(w * dpr));
            canvas.height = Math.max(1, Math.floor(h * dpr));
            gl.viewport(0, 0, canvas.width, canvas.height);
            view.width = w;
            view.height = h;
        }
        resize();
        window.addEventListener('resize', resize);

        /* ---- 渲染循环（常驻，为后续阶段动画预留） ---- */
        function render() {
            gl.uniform2f(U.resolution, view.width, view.height);
            gl.uniform1f(U.centerLng, view.centerLng);
            gl.uniform1f(U.centerLat, view.centerLat);
            gl.uniform1f(U.pxPerDeg, view.pxPerDeg);
            if (baseBounds) {
                gl.uniform1f(U.bW, baseBounds[0][1]);
                gl.uniform1f(U.bS, baseBounds[0][0]);
                gl.uniform1f(U.bE, baseBounds[1][1]);
                gl.uniform1f(U.bN, baseBounds[1][0]);
            }
            gl.uniform1f(U.baseLoaded, baseLoaded ? 1.0 : 0.0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, baseTexture);
            gl.uniform1i(U.baseMap, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            requestAnimationFrame(render);
        }
        requestAnimationFrame(render);

        /* ---- 对外（Task 3/4/5 扩展，先占位最小集） ---- */
        var api = {
            _gl: gl,
            _canvas: canvas,
            _view: view,
            setBaseMap: function (url, bOpts) {
                baseBounds = bOpts.bounds;
                var img = new Image();
                img.onload = function () {
                    gl.bindTexture(gl.TEXTURE_2D, baseTexture);
                    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
                    baseLoaded = true;
                    console.log('[GLEngine] 底图加载完成');
                };
                img.onerror = function () {
                    console.error('[GLEngine] 底图加载失败: ' + url);
                };
                img.src = url;
                return api;
            },
            fitBounds: function (bounds, fOpts) {
                fOpts = fOpts || {};
                var padL = (fOpts.paddingTopLeft || [0, 0])[0];
                var padT = (fOpts.paddingTopLeft || [0, 0])[1];
                var padR = (fOpts.paddingBottomRight || [0, 0])[0];
                var padB = (fOpts.paddingBottomRight || [0, 0])[1];
                var fit = GLProj.fitBounds(bounds, view.width, view.height, [padL, padT, padR, padB], {
                    minZoom: view.minZoom, maxZoom: view.maxZoom,
                });
                GLProj.applyView(view, fit);
                return api;
            },
        };
        return api;
    }

    return { init: init };
})();
```

- [ ] **Step 3: 打开验证页，确认底图显示 + 裁剪生效**

用 Live Server 打开 `weather/pgm/gl-stage.html`。
Expected:
- 看到青海底图，省内清晰
- 省外（底图透明区）为深色背景 `rgb(26,26,36)`
- 浏览器控制台出现 `[GLEngine] 底图加载完成`
- 不支持 WebGL 时显示红色提示（可忽略，正常浏览器不触发）

若底图上下颠倒：检查 `UNPACK_FLIP_Y_WEBGL` 是否为 `false` 且 shader 中 `v = (u_boundsNorth - lat)/(...)` 正确（本实现已对齐，不应颠倒）。

- [ ] **Step 4: 提交**

```bash
git add weather/pgm/gl-engine.js weather/pgm/gl-stage.html
git commit -m "$(cat <<'EOF'
feat(gl): 新增 GLEngine WebGL 地图引擎（底图+裁剪+resize）

全屏 quad + 片元着色器：NDC→屏幕像素→经纬度→底图 UV 线性反推，
底图 alpha<0.1 渲染省外深色背景（复刻 demo GPU 裁剪）。常驻 rAF 渲染。
固定 view 先验证底图与裁剪，交互留待后续任务。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: GLEngine — view uniform 接入交互前的最小修正与 fitBounds 验证

Task 2 已让底图随 view（fitBounds 设定）正确显示。本任务确认 `fitBounds` 真的把青海铺满、并补 `getZoom/setZoom` 两个基础 API，为 Task 4 交互做铺垫。

**Files:**
- Modify: `weather/pgm/gl-engine.js`（在 `api` 对象内补方法）
- Modify: `weather/pgm/gl-stage.html`（加一行日志验证 fitBounds 结果）

- [ ] **Step 1: 在 gl-engine.js 的 api 对象内补 getZoom / setZoom / getView**

定位 `var api = {` 块（Task 2 创建），在 `fitBounds` 方法之后、闭合 `}` 之前插入：

```js
            getZoom: function () { return view.zoom; },
            getView: function () {
                return {
                    centerLng: view.centerLng,
                    centerLat: view.centerLat,
                    zoom: view.zoom,
                    width: view.width,
                    height: view.height,
                    pxPerDeg: view.pxPerDeg,
                };
            },
            setZoom: function (z) {
                GLProj.applyView(view, { zoom: z });
                return api;
            },
```

- [ ] **Step 2: 在 gl-stage.html 的 fitBounds 调用后加验证日志**

在 `engine.fitBounds(...)` 调用之后追加一行：

```js
    console.log('[fitBounds] result =', engine.getView());
```

- [ ] **Step 3: 打开验证页，确认青海铺满、日志正确**

刷新 `weather/pgm/gl-stage.html`。
Expected:
- 青海全省完整可见，未被右侧面板区遮挡过度（paddingTopLeft/paddingBottomRight 生效）
- 控制台 `[fitBounds] result =` 的 `zoom` ≈ 5.97，`centerLng` ≈ 96.3，`centerLat` ≈ 35.4

- [ ] **Step 4: 提交**

```bash
git add weather/pgm/gl-engine.js weather/pgm/gl-stage.html
git commit -m "$(cat <<'EOF'
feat(gl): 补 getZoom/setZoom/getView 并验证 fitBounds 铺满

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: GLEngine — 交互（拖拽 / 滚轮光标为中心 / 双击）+ 边界约束 + click/moveend 事件

**Files:**
- Modify: `weather/pgm/gl-engine.js`（在 `render` 函数定义之后、`api` 定义之前插入交互绑定；在 `api` 内补 `on/off/project/unproject`）

- [ ] **Step 1: 在 gl-engine.js 插入事件总线与交互绑定**

定位 `requestAnimationFrame(render);` 这一行（Task 2 渲染循环启动处），在其**之后、`var api = {` 之前**插入：

```js
        /* ---- 事件总线 ---- */
        var listeners = {};
        function on(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); }
        function off(name, fn) {
            var arr = listeners[name]; if (!arr) return;
            listeners[name] = arr.filter(function (f) { return f !== fn; });
        }
        function emit(name, payload) {
            (listeners[name] || []).forEach(function (fn) { try { fn(payload); } catch (e) { console.error(e); } });
        }

        /* ---- 交互：拖拽平移 / 滚轮光标为中心 / 双击放大 ---- */
        var dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0, moved = false;

        function clientToPx(clientX, clientY) {
            var rect = canvas.getBoundingClientRect();
            return [clientX - rect.left, clientY - rect.top];
        }

        canvas.addEventListener('pointerdown', function (e) {
            dragging = true; moved = false;
            lastX = e.clientX; lastY = e.clientY;
            downX = e.clientX; downY = e.clientY;
            try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        });
        canvas.addEventListener('pointermove', function (e) {
            if (!dragging) return;
            var dx = e.clientX - lastX, dy = e.clientY - lastY;
            if (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) moved = true;
            lastX = e.clientX; lastY = e.clientY;
            /* 地图跟随光标：光标右移 dx>0 → 视野左移 → centerLng 减小；下移 dy>0 → centerLat 增大 */
            view.centerLng -= dx / view.pxPerDeg;
            view.centerLat += dy / view.pxPerDeg;
            if (baseBounds) {
                var c = GLProj.clampCenter(view.centerLng, view.centerLat, baseBounds);
                view.centerLng = c[0]; view.centerLat = c[1];
            }
        });
        function endDrag(e) {
            if (!dragging) return;
            dragging = false;
            if (!moved) {
                var px = clientToPx(e.clientX, e.clientY);
                var ll = GLProj.unproject(px, view);
                emit('click', { lng: ll[0], lat: ll[1], px: px[0], py: px[1] });
            } else {
                emit('moveend', { center: [view.centerLng, view.centerLat], zoom: view.zoom });
            }
        }
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);

        canvas.addEventListener('wheel', function (e) {
            e.preventDefault();
            var px = clientToPx(e.clientX, e.clientY);
            var newZoom = view.zoom - Math.sign(e.deltaY) * 0.5;
            var r = GLProj.zoomAt(view, newZoom, px);
            GLProj.applyView(view, r);
            emit('moveend', { center: [view.centerLng, view.centerLat], zoom: view.zoom });
        }, { passive: false });

        canvas.addEventListener('dblclick', function (e) {
            e.preventDefault();
            var px = clientToPx(e.clientX, e.clientY);
            var r = GLProj.zoomAt(view, view.zoom + 1, px);
            GLProj.applyView(view, r);
            emit('moveend', { center: [view.centerLng, view.centerLat], zoom: view.zoom });
        });
```

- [ ] **Step 2: 在 api 对象内补 on/off/project/unproject/panBy/flyTo**

定位 `var api = {` 块，在 Task 3 补的 `setZoom` 之后插入：

```js
            on: on,
            off: off,
            project: function (lngLat) { return GLProj.project(lngLat, view); },
            unproject: function (pxPy) { return GLProj.unproject(pxPy, view); },
            panBy: function (dpxPy) {
                view.centerLng -= dpxPy[0] / view.pxPerDeg;
                view.centerLat += dpxPy[1] / view.pxPerDeg;
                if (baseBounds) {
                    var c = GLProj.clampCenter(view.centerLng, view.centerLat, baseBounds);
                    view.centerLng = c[0]; view.centerLat = c[1];
                }
                emit('moveend', { center: [view.centerLng, view.centerLat], zoom: view.zoom });
                return api;
            },
            flyTo: function (lngLat, zoom) {
                GLProj.applyView(view, { centerLng: lngLat[0], centerLat: lngLat[1], zoom: zoom });
                emit('moveend', { center: [view.centerLng, view.centerLat], zoom: view.zoom });
                return api;
            },
```

- [ ] **Step 3: 打开验证页，逐项手动验收交互**

刷新 `weather/pgm/gl-stage.html`，验收：
1. **拖拽平移**：按住拖动，地图跟随光标移动；松开后控制台 `[moveend]` 打印新 center；地图不会飞出青海 bounds（被 clamp 拉回）。
2. **滚轮缩放（光标为中心）**：把鼠标停在青海某地标上滚轮，放大/缩小后该地标仍停留在光标下；控制台 `[moveend]` 打印 zoom 变化；zoom 被钳在 [4,12]。
3. **双击放大**：双击某点，该点放大一级且仍在该点位置。
4. **点击**：在地图上单击（不拖动），控制台 `[click]` 打印 `[lng,lat]` 与 `[px,py]`。

若滚轮缩放后光标下地标**偏移**：检查 `GLProj.zoomAt` 的 center 反解符号（Task 1 已测，应正确）；确认 `clientToPx` 用的是 `canvas.getBoundingClientRect()`。

- [ ] **Step 4: 提交**

```bash
git add weather/pgm/gl-engine.js
git commit -m "$(cat <<'EOF'
feat(gl): 新增地图交互——拖拽平移/滚轮光标为中心缩放/双击放大

含边界 clamp（center 限制在青海 bounds 内）、click/moveend 事件、
project/unproject/panBy/flyTo 对外 API。光标为中心缩放经 zoomAt 测试保证锚点不变。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: GLEngine — 加载遮罩 + 图层容器 + destroy + API 收尾

**Files:**
- Modify: `weather/pgm/gl-engine.js`

- [ ] **Step 1: 在 gl-engine.js 的事件总线之后补加载遮罩**

定位 Task 4 插入的 `function emit(...)` 块之后，插入加载遮罩逻辑（对齐现有 map.js 的计数式遮罩语义）：

```js
        /* ---- 加载遮罩（计数式，对齐 map.js 语义） ---- */
        var loadingDepth = 0, loadingMask = null;
        function ensureLoadingMask() {
            if (loadingMask) return loadingMask;
            loadingMask = document.createElement('div');
            loadingMask.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;'
                + 'background:rgba(0,0,0,0.45);opacity:0;transition:opacity .2s;z-index:2000;pointer-events:none;';
            loadingMask.innerHTML = '<div style="color:#fff;font-family:sans-serif;">加载中…</div>';
            container.appendChild(loadingMask);
            return loadingMask;
        }
        function showLoading() {
            var first = loadingDepth === 0;
            loadingDepth++;
            var m = ensureLoadingMask();
            if (first) { void m.offsetWidth; m.style.opacity = '1'; m.style.pointerEvents = 'auto'; }
            return api;
        }
        function hideLoading() {
            if (loadingDepth > 0) loadingDepth--;
            if (loadingDepth === 0 && loadingMask) { loadingMask.style.opacity = '0'; loadingMask.style.pointerEvents = 'none'; }
            return api;
        }
```

- [ ] **Step 2: 在 api 对象内补 showLoading/hideLoading/addLayer/removeLayer/destroy**

先在 Task 4 插入的 `function emit(...)` 块之后、`var api = {` 之前，声明图层列表：

```js
        var layers = [];
```

再在 `var api = {` 块内，Task 4 补的 `flyTo` 之后插入：

```js
            showLoading: showLoading,
            hideLoading: hideLoading,
            /* 图层容器：为阶段 1/3/4 填色/粒子/等压线层预留。每帧遍历调用 layer.render(gl, view, api)。 */
            addLayer: function (layer) { layers.push(layer); return api; },
            removeLayer: function (layer) {
                layers = layers.filter(function (l) { return l !== layer; });
                return api;
            },
            destroy: function () {
                window.removeEventListener('resize', resize);
                if (loadingMask && loadingMask.parentNode) loadingMask.parentNode.removeChild(loadingMask);
                gl.deleteBuffer(buf);
                gl.deleteTexture(baseTexture);
                if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
            },
```

- [ ] **Step 3: 修改 Task 2 的 render 函数，在 drawArrays 后追加图层遍历**

定位 Task 2 render 函数内的 `gl.drawArrays(gl.TRIANGLES, 0, 6);` 这一行，在其**之后**（仍在 render 函数内、`requestAnimationFrame(render);` 之前）追加：

```js
            for (var i = 0; i < layers.length; i++) {
                if (layers[i] && typeof layers[i].render === 'function') {
                    layers[i].render(gl, view, api);
                }
            }
```

（阶段 0 layers 为空，此遍历无副作用，仅为后续阶段预留挂载点。）

- [ ] **Step 4: 在 gl-stage.html 临时验证加载遮罩可调用**

在 `engine.on('moveend', ...)` 之后临时追加（验证后保留也无妨）：

```js
    engine.showLoading();
    setTimeout(function () { engine.hideLoading(); }, 800);
```

- [ ] **Step 5: 打开验证页，确认遮罩一闪而过、其余功能不受影响**

刷新 `weather/pgm/gl-stage.html`。
Expected: 页面打开瞬间出现半透明"加载中…"遮罩，约 0.8s 后消失；底图与交互仍正常。

- [ ] **Step 6: 提交**

```bash
git add weather/pgm/gl-engine.js weather/pgm/gl-stage.html
git commit -m "$(cat <<'EOF'
feat(gl): 补加载遮罩/图层容器/destroy，收尾对外 API

计数式加载遮罩对齐 map.js 语义；addLayer/removeLayer 为后续阶段填色/
粒子/等压线层预留挂载点（每帧遍历 layer.render）；destroy 释放 GL 资源。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 阶段 0 验收清单走查 + 收尾

**Files:**
- 仅走查，不改文件（除非验收发现问题）

- [ ] **Step 1: 按 spec §7 逐条手动验收**

打开 `weather/pgm/gl-stage.html`，逐条核对：

| # | 验收项 | 通过条件 |
| --- | --- | --- |
| 1 | 青海底图 + 裁剪 | 省内清晰，省外深色背景 |
| 2 | 拖拽平移 | 地图跟随光标，clamp 生效不飞出 |
| 3 | 滚轮光标为中心 | 缩放后光标下经纬度不变 |
| 4 | 双击放大 | 双击点放大一级且位置不变 |
| 5 | zoom 钳制 + 平移约束 | zoom∈[4,12]，center 不出 bounds |
| 6 | resize 自适应 | 改窗口大小，底图无变形铺满 |
| 7 | 点击打印 [lng,lat] | 控制台 `[click]` 输出合理经纬度 |
| 8 | WebGL 不支持提示 | （正常浏览器跳过） |

任一项不通过：回到对应 Task 修复后重跑。

- [ ] **Step 2: 确认 gl-proj 测试页仍全绿**

刷新 `weather/pgm/gl-proj.test.html`，确认 `N passed, 0 failed`。

- [ ] **Step 3: 确认未触碰现有页面**

运行 `git status` 确认 `index.html / map.js / index.js` 未被修改（应仍为会话开始时的 staged/working 状态，无新增改动）。

- [ ] **Step 4: 收尾提交（如有验收修复）**

```bash
git status   # 确认仅 gl-* 三件套相关改动
# 若有修复改动：
git add weather/pgm/gl-engine.js
git commit -m "$(cat <<'EOF'
fix(gl): 阶段 0 验收修复

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

若验收一次通过无修复，跳过此步。

---

## Self-Review（计划作者自检）

**1. Spec 覆盖**：
- §2.1 范围内各项 → Task 1（投影）/ Task 2（GL+resize+底图+裁剪）/ Task 4（交互+约束）/ Task 5（遮罩+API）全覆盖。
- §3.2 对外 API → Task 2（setBaseMap/fitBounds）/ Task 3（getZoom/setZoom/getView）/ Task 4（on/off/project/unproject/panBy/flyTo）/ Task 5（showLoading/hideLoading/addLayer/removeLayer/destroy）。全部有定义。
- §4 投影 → Task 1 完整实现 + 测试。
- §5 交互 → Task 4 全部交互 + §5.5 边界约束（clampZoom 在 makeView/applyView，clampCenter 在拖拽/panBy）。
- §6 渲染管线 → Task 2 顶点/片元着色器 + 底图加载 + 常驻 rAF。
- §7 验收 8 条 → Task 6 逐条对应。
- §8 风险：Plate Carrée 形变（spec 已接受 <1%）；滚轮光标为中心（Task 1 zoomAt 测 + Task 4 验收点 3 双重保证）；DPI（Task 2 resize 分离 CSS/物理像素）；命名冲突（独立文件）。均落实。

**2. Placeholder 扫描**：无 TBD/TODO；每个代码 step 均含完整代码；验收 step 含具体通过条件。

**3. 类型/命名一致性**：`GLProj.makeView/project/unproject/clampZoom/clampCenter/zoomAt/fitBounds/applyView` 在 Task 1 定义，Task 2/3/4/5 调用名一致；`api` 方法名（setBaseMap/fitBounds/getZoom/setZoom/getView/on/off/project/unproject/panBy/flyTo/showLoading/hideLoading/addLayer/removeLayer/destroy）跨任务一致；`view` 字段（centerLng/centerLat/zoom/width/height/pxPerDeg/minZoom/maxZoom）跨任务一致；`emit('click'/'moveend')` 与 gl-stage.html 监听一致。

---

## 执行交接

Plan 完成并保存到 `docs/superpowers/plans/2026-06-30-webgl-weather-map-stage0.md`。两种执行方式：

**1. Subagent-Driven（推荐）** — 每个 Task 派一个全新 subagent，任务间我做两阶段 review，快速迭代。

**2. Inline Execution** — 在本会话内用 executing-plans 批量执行，带检查点 review。

请选择执行方式。
