/**
 * WeatherMap 气象地图核心模块
 * 搭载高颜值气象色带引擎 & 全局 Canvas 粒子动画引擎 (无痛解耦复合风场)
 */
var WeatherMap = (function () {
    /* 修补 leaflet-velocity 的库缺陷：其 CanvasLayer.onRemove 未取消 onAdd 中注册的
     requestAnimationFrame(drawLayer) 与 setTimeout(_onLayerDidMove)。图层被移除时，
     Leaflet 的 Map.removeLayer 会先把 layer._map 置为 null，残留的回调随后执行就会
     访问 null.getSize() / null.containerPointToLayerPoint() 而抛错。
     这里给两个回调加 _map 守卫，丢弃图层已卸载后的过期回调。 */
    if (L.CanvasLayer && L.CanvasLayer.prototype) {
        var _clProto = L.CanvasLayer.prototype;
        var _origDrawLayer = _clProto.drawLayer;
        if (typeof _origDrawLayer === "function") {
            _clProto.drawLayer = function () {
                if (!this._map) return;
                return _origDrawLayer.apply(this, arguments);
            };
        }
        var _origOnLayerDidMove = _clProto._onLayerDidMove;
        if (typeof _origOnLayerDidMove === "function") {
            _clProto._onLayerDidMove = function () {
                if (!this._map) return;
                return _origOnLayerDidMove.apply(this, arguments);
            };
        }
    }

    var MAP_CONFIG = {
        enabled: true,
        region: "qinghai",
        center: [35.4, 96.2],
        url: "../base/rs/img/qinghai_map.png",
        bounds: [
            [31.5, 89.4],
            [39.3, 103.2],
        ],
    };

    var timeSteps = []; /* 播放时间步标签，由 cmiss data 各项的 date 填充 */
    var APIs = {
        CMISS: "../base/rs/js/cmiss.json",
        GEO_BOUNDS: "../base/rs/js/" + MAP_CONFIG.region + ".json",
        /* 墨迹 EC1x1 请求要素集合（数据结构配置；接口/鉴权由后端处理） */
        MOJICB_ELEMS: "TT2,RAIN,WS,PS,WEATHER",
    };



    var map = null;
    // 全局唯一风场流线实例，不再重复创建或使用空数据销毁
    var globalVelLayer = null;
    var cacheData = {
        gfs: null,
        cmiss: null,
        maskRings: [],
        timeSeriesCmiss: [],
    };
    var qinghaiPolygons = [];
    var mapLayersCache = {};
    var currentTimeIndex = 0;
    var isPlaying = false;
    var playbackTimer = null;

    /* 播放帧缓存：为每个 (图层类型, 时间步) 预计算 IDW 热力网格的 RGBA 像素快照。
       播放时只在相邻两帧之间做像素级线性插值（极快），不再每帧重算 IDW，
       既实现丝滑过渡，又不阻塞雨雪粒子动画。 */
    var frameCache = {}; // { [type]: { cols, rows, resolveType, frames: { [idx]: Uint8ClampedArray } } }
    var _blendImgData = null; // 复用的 ImageData，避免每帧 createImageData 的开销
    var playbackRaf = null; // requestAnimationFrame 句柄
    var playState = null; // { fromIdx, toIdx, stepStart, lastHalf }
    var PLAY_STEP_MS = 1000; // 单个时间步的插值过渡时长（ms）

    /* ============================================================
     固定场站图层：按经纬度展示场站（类型图标 + 名称），常驻显示、
     不参与气象图层互斥；天气图层激活时可叠加场站天气角标。
     图标图片由 STATION_TYPE_ICON 映射 —— 直接替换对应图片文件即可换图标。
     ============================================================ */
    var STATION_TYPE_ICON = {
        pv: "../base/rs/img/station-pv.png",
        storage: "../base/rs/img/station-storage.png",
        wind: "../base/rs/img/station-wind.png",
        hydro: "../base/rs/img/station-hydro.png",
        default: "../base/rs/img/station-default.png",
    };
    var STATION_TYPE_LABEL = {
        pv: "光伏",
        storage: "储能",
        wind: "风电",
        hydro: "水电",
        default: "场站",
    };
    /* 图片缺失时兜底显示的 emoji 徽章（可改） */
    var STATION_TYPE_FALLBACK = {
        pv: "☀️",
        storage: "🔋",
        wind: "🌬️",
        hydro: "💧",
        default: "📍",
    };
    var stationConfig = []; // 场站配置（由 api.setStationConfig 注入）
    var stationLayer = null; // 场站图层（常驻，独立于 mapLayersCache）
    var showStationWeather = false; // 是否在场站上叠加天气角标（随天气图层联动）
    var currentHighlight = null; // 当前高亮的分组(地区/公司)，null 表示无高亮

    /* ============================================================
     专业气象级高颜值等距色带
     ============================================================ */
    var METEO_CONFIG = {
        temp: {
            min: -20,
            max: 40,
            colors: [
                { val: -20, r: 49, g: 54, b: 149, hex: "#313695" },
                { val: -10, r: 69, g: 117, b: 180, hex: "#4575b4" },
                { val: 0, r: 224, g: 243, b: 248, hex: "#e0f3f8" },
                { val: 10, r: 254, g: 224, b: 144, hex: "#fee090" },
                { val: 20, r: 244, g: 109, b: 67, hex: "#f46d43" },
                { val: 30, r: 215, g: 48, b: 39, hex: "#d73027" },
                { val: 40, r: 165, g: 0, b: 38, hex: "#a50026" },
            ],
        },
        rain: {
            min: 0.1,
            max: 100,
            colors: [
                { val: 0.1, r: 166, g: 242, b: 143, hex: "#a6f28f" },
                { val: 10, r: 61, g: 185, b: 63, hex: "#3db93f" },
                { val: 25, r: 99, g: 184, b: 249, hex: "#63b8f9" },
                { val: 50, r: 0, g: 0, b: 254, hex: "#0000fe" },
                { val: 100, r: 243, g: 5, b: 238, hex: "#f305ee" },
            ],
        },
        snow: {
            min: 0.1,
            max: 30,
            colors: [
                { val: 0.1, r: 224, g: 243, b: 248, hex: "#e0f3f8" },
                { val: 2.5, r: 145, g: 191, b: 219, hex: "#91bfdb" },
                { val: 5.0, r: 69, g: 117, b: 180, hex: "#4575b4" },
                { val: 10, r: 49, g: 54, b: 149, hex: "#313695" },
                { val: 20, r: 84, g: 39, b: 136, hex: "#542788" },
                { val: 30, r: 45, g: 0, b: 75, hex: "#2d004b" },
            ],
        },
        windSpeed: {
            min: 0,
            max: 30,
            colors: [
                {
                    val: 0,
                    r: 173,
                    g: 216,
                    b: 230,
                    a: 0,
                    hex: "rgba(173,216,230,0)",
                },
                { val: 2, r: 173, g: 216, b: 230, a: 255, hex: "#add8e6" },
                { val: 4, r: 65, g: 105, b: 225, a: 255, hex: "#4169e1" },
                { val: 6, r: 0, g: 255, b: 127, a: 255, hex: "#00ff7f" },
                { val: 8, r: 50, g: 205, b: 50, a: 255, hex: "#32cd32" },
                { val: 10, r: 255, g: 255, b: 0, a: 255, hex: "#ffff00" },
                { val: 15, r: 255, g: 140, b: 0, a: 255, hex: "#ff8c00" },
                { val: 20, r: 255, g: 0, b: 0, a: 255, hex: "#ff0000" },
                { val: 25, r: 139, g: 0, b: 139, a: 255, hex: "#8b008b" },
                { val: 30, r: 0, g: 0, b: 0, a: 255, hex: "#000000" },
            ],
        },
        pressure: {
            min: 500,
            max: 1000,
            colors: [
                { val: 500, r: 64, g: 0, b: 75, hex: "#40004b" },
                { val: 600, r: 118, g: 42, b: 131, hex: "#762a83" },
                { val: 700, r: 153, g: 112, b: 171, hex: "#9970ab" },
                { val: 800, r: 210, g: 229, b: 240, hex: "#d2e5f0" },
                { val: 900, r: 67, g: 147, b: 195, hex: "#4393c3" },
                { val: 1000, r: 33, g: 102, b: 172, hex: "#2166ac" },
            ],
        },
        /* 相对湿度（%） */
        humidity: {
            min: 0,
            max: 100,
            colors: [
                { val: 0, r: 253, g: 230, b: 138, hex: "#fde68a" },
                { val: 30, r: 134, g: 239, b: 172, hex: "#86efac" },
                { val: 60, r: 56, g: 189, b: 248, hex: "#38bdf8" },
                { val: 80, r: 37, g: 99, b: 235, hex: "#2563eb" },
                { val: 100, r: 30, g: 58, b: 138, hex: "#1e3a8a" },
            ],
        },
        /* 太阳总辐射（W/m²） */
        radiation: {
            min: 0,
            max: 1000,
            colors: [
                { val: 0, r: 30, g: 41, b: 59, hex: "#1e293b" },
                { val: 200, r: 124, g: 58, b: 237, hex: "#7c3aed" },
                { val: 400, r: 219, g: 39, b: 119, hex: "#db2777" },
                { val: 600, r: 234, g: 88, b: 12, hex: "#ea580c" },
                { val: 800, r: 250, g: 204, b: 21, hex: "#facc15" },
                { val: 1000, r: 254, g: 240, b: 138, hex: "#fef08a" },
            ],
        },
        /* 总云量（%）：低值近透明，高值深灰 */
        cloud: {
            min: 0,
            max: 100,
            colors: [
                {
                    val: 0,
                    r: 255,
                    g: 255,
                    b: 255,
                    a: 0,
                    hex: "rgba(255,255,255,0)",
                },
                { val: 20, r: 224, g: 242, b: 254, hex: "#e0f2fe" },
                { val: 50, r: 148, g: 163, b: 184, hex: "#94a3b8" },
                { val: 80, r: 71, g: 85, b: 105, hex: "#475569" },
                { val: 100, r: 30, g: 41, b: 59, hex: "#1e293b" },
            ],
        },
        isobar: {
            interval: 20,
            lineColor: "rgba(100, 120, 150, 0.8)",
            lineWidth: 1.2,
            labelColor: "#445566",
        },
    };

    /* ============================================================
     图例同步组件
     ============================================================ */
    window.updateLegendUI = function (type, configMap) {
        if (!type || type === "weather") {
            if (window.app) window.app.showLegend = false;
            return;
        }

        var titleMap = {
            temp: "实况表面温度 (℃)",
            rain: "实况降水量 (mm)",
            snow: "地表积雪量热力预测 (mm)",
            windSpeed: "风速能量热力场 (m/s)",
            pressure: "实况地表气压 (hPa)",
            wind: "风速能量热力场 (m/s)",
            isobar: "气压 (hPa)",
            humidity: "相对湿度 (%)",
            radiation: "太阳总辐射 (W/m²)",
            cloud: "总云量 (%)",
        };

        var config = configMap[type];
        if (type === "wind" || type === "windSpeed")
            config = configMap["windSpeed"];
        if (type === "isobar") config = configMap["pressure"];

        if (config && config.colors) {
            var gradientStr =
                "linear-gradient(to right, " +
                config.colors
                    .map(function (c) {
                        return c.hex;
                    })
                    .join(", ") +
                ")";
            if (window.app) {
                window.app.legendTitle = titleMap[type] || "气象要素";
                window.app.legendGradient = gradientStr;
                window.app.legendLabels = config.colors.map(function (c) {
                    return c.val;
                });
                window.app.showLegend = true;
            }
        }
    };

    /* 天气电码 → (现象名, 图标) 映射；图片命名规则：tq-<电码>.png */
    window.WEATHER_ICON_CODEX = {
        1: "晴",
        8: "多云",
        13: "阴",
        26: "雾",
        29: "沙尘暴",
        30: "浮尘",
        32: "扬沙",
        34: "霾",
        49: "雨夹雪",
        51: "小雨",
        53: "中雨",
        54: "大雨",
        55: "暴雨",
        56: "大暴雨",
        57: "特大暴雨",
        58: "小雪",
        60: "中雪",
        62: "大雪",
        63: "暴雪",
    };
    var WEATHER_ICONS = {};
    Object.keys(WEATHER_ICON_CODEX).forEach(function (code) {
        var label = WEATHER_ICON_CODEX[code];
        WEATHER_ICONS[code] = {
            label: label,
            html:
                '<img src="../base/rs/img/tq-' +
                code +
                '.png" width="28" height="28" alt="' +
                label +
                '" />',
        };
    });

    /** 支持动态透明度（A通道）平滑插值 */
    function getIdwColor(type, val) {
        var config = METEO_CONFIG[type];
        if (!config || !config.colors) return { r: 0, g: 0, b: 0, a: 0 };
        var colors = config.colors;

        if ((type === "rain" || type === "snow") && val < 0.1)
            return { r: 0, g: 0, b: 0, a: 0 };

        var first = colors[0];
        if (val <= first.val)
            return {
                r: first.r,
                g: first.g,
                b: first.b,
                a: first.a !== undefined ? first.a : 255,
            };

        var last = colors[colors.length - 1];
        if (val >= last.val)
            return {
                r: last.r,
                g: last.g,
                b: last.b,
                a: last.a !== undefined ? last.a : 255,
            };

        for (var i = 0; i < colors.length - 1; i++) {
            var c1 = colors[i],
                c2 = colors[i + 1];
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

    function applyTrueTransparentMask() {
        if (!MAP_CONFIG.enabled || cacheData.maskRings.length === 0) return;
        var svg = document.getElementById("map-clip-svg");
        if (!svg) {
            svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.id = "map-clip-svg";
            svg.style.position = "absolute";
            svg.style.width = "0";
            svg.style.height = "0";
            document.body.appendChild(svg);
        }
        var pathString = "";
        cacheData.maskRings.forEach(function (ring) {
            ring.forEach(function (coord, j) {
                var pt = map.latLngToLayerPoint([coord[1], coord[0]]);
                pathString += (j === 0 ? "M" : "L") + pt.x + "," + pt.y + " ";
            });
            pathString += "Z ";
        });
        svg.innerHTML =
            '<clipPath id="qinghai-clip"><path d="' +
            pathString +
            '" /></clipPath>';

        ["baseImagePane", "heatPane", "overlayPane", "bordersPane"].forEach(
            function (paneName) {
                var pane = map.getPane(paneName);
                if (pane) {
                    pane.style.clipPath = "url(#qinghai-clip)";
                    pane.style.webkitClipPath = "url(#qinghai-clip)";
                }
            },
        );
    }

    function getGridValueAt(rawData, lat, lng) {
        if (!rawData || !rawData[0] || !rawData[0].header) return null;
        /* 用 header 的 lo1/la1/dx/dy 做局部网格索引(兼容全球与青海局部网格) */
        var h = rawData[0].header;
        var nx = h.nx,
            ny = h.ny;
        var lo1 = h.lo1,
            la1 = h.la1;
        var dx =
            h.dx != null ? h.dx : nx > 1 ? (h.lo2 - h.lo1) / (nx - 1) : 1;
        var dy =
            h.dy != null ? h.dy : ny > 1 ? (h.la1 - h.la2) / (ny - 1) : 1;
        var gi = Math.floor((lng - lo1) / dx);
        var gj = Math.floor((la1 - lat) / dy);
        if (gi < 0 || gi >= nx || gj < 0 || gj >= ny) return null;
        return rawData.map(function (comp) {
            return comp.data[gj * nx + gi];
        });
    }

    function extractPointsFromContours(type, contours) {
        var points = [];
        if (!contours) return points;
        contours.forEach(function (s) {
            var val;
            if (type === "temp") val = s[19];
            else if (type === "rain" || type === "snow") val = s[12];
            else if (type === "pressure" || type === "isobar") val = s[8];
            else if (type === "windSpeed" || type === "wind") val = s[5];
            /* 相对湿度/太阳总辐射/总云量：直接读取 cmiss 对应索引
               （s[9]/s[10]/s[11]；缺测 9999 会被下方过滤自动跳过） */
            else if (type === "humidity") val = s[9];
            else if (type === "radiation") val = s[10];
            else if (type === "cloud") val = s[11];

            if (val === undefined || val === null || isNaN(val)) return;
            if (
                val === 9999 ||
                val === 999999 ||
                val === -9999 ||
                val === -999 ||
                val === -99
            )
                return;

            points.push({ lat: s[2], lng: s[1], value: val });
        });
        return points;
    }

    function pointInPolygon(lng, lat, polygon) {
        var inside = false;
        for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            var xi = polygon[i][0],
                yi = polygon[i][1],
                xj = polygon[j][0],
                yj = polygon[j][1];
            if (
                yi > lat !== yj > lat &&
                lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
            )
                inside = !inside;
        }
        return inside;
    }
    function isInsideQinghai(lat, lng) {
        return qinghaiPolygons.some(function (r) {
            return pointInPolygon(lng, lat, r);
        });
    }
    function findNearestStation(lat, lng) {
        var contours = cacheData.timeSeriesCmiss[currentTimeIndex];
        if (!contours) return null;
        var best = null,
            bestDist = Infinity;
        contours.forEach(function (s) {
            var dist =
                (s[1] - lng) * (s[1] - lng) + (s[2] - lat) * (s[2] - lat);
            if (dist < bestDist) {
                bestDist = dist;
                best = s;
            }
        });
        return best;
    }

    /* ============================================================
     降雪粒子层：仅在降雪区域渲染（与雨滴同构：降雪 IDW 网格做 mask 过滤，
     叠加青海边界裁剪，不污染无降雪区）
     ============================================================ */
    var SnowParticleLayer = L.Layer.extend({
        initialize: function (points) {
            this._points = points || [];
        },
        onAdd: function (map) {
            this._map = map;
            this._canvas = document.createElement("canvas");
            this._canvas.style.position = "absolute";
            this._canvas.style.top = 0;
            this._canvas.style.left = 0;
            this._canvas.style.pointerEvents = "none";
            this._canvas.style.zIndex = 1000;
            map.getContainer().appendChild(this._canvas);

            this._ctx = this._canvas.getContext("2d");
            this._resize();
            map.on("resize", this._resize, this);
            map.on("zoomend moveend", this._rebuild, this);
            this._animate();
        },
        onRemove: function (map) {
            cancelAnimationFrame(this._raf);
            map.getContainer().removeChild(this._canvas);
            map.off("resize", this._resize, this);
            map.off("zoomend moveend", this._rebuild, this);
        },
        setData: function (points) {
            this._points = points || [];
            if (this._map) this._buildMask();
        },
        _resize: function () {
            var rect = this._canvas.parentNode.getBoundingClientRect();
            this._canvas.width = rect.width;
            this._canvas.height = rect.height;
            this._buildMask();
            this._initParticles();
        },
        _rebuild: function () {
            this._buildMask();
            this._initParticles();
        },
        // 降雪网格 + 青海裁剪 mask + 青海在 canvas 的像素矩形（与 RainParticleLayer 同构）
        _buildMask: function () {
            var b = L.latLngBounds(MAP_CONFIG.bounds);
            var west = b.getWest(),
                east = b.getEast(),
                south = b.getSouth(),
                north = b.getNorth();
            var cols = 160,
                rows = Math.ceil(cols * ((north - south) / (east - west)));
            this._grid = computeFloatGrid(
                this._points,
                "snow",
                cols,
                rows,
                west,
                east,
                south,
                north,
            );
            var g = this._grid;
            this._mask = new Uint8Array(g.cols * g.rows);
            for (var gy = 0; gy < g.rows; gy++) {
                var lat = g.north - (gy + 0.5) * g.dy;
                for (var gx = 0; gx < g.cols; gx++) {
                    var lng = g.west + (gx + 0.5) * g.dx;
                    if (
                        isInsideQinghai(lat, lng) &&
                        g.grid[gy * g.cols + gx] > 0.1
                    ) {
                        this._mask[gy * g.cols + gx] = 1;
                    }
                }
            }
            var tl = this._map.latLngToContainerPoint([north, west]);
            var br = this._map.latLngToContainerPoint([south, east]);
            this._rect = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
        },
        _initParticles: function () {
            if (!this._rect) return;
            var r = this._rect;
            this._particles = [];
            for (var i = 0; i < 220; i++) {
                this._particles.push({
                    x: r.x + Math.random() * r.w,
                    y: r.y + Math.random() * r.h,
                    r: Math.random() * 2.5 + 1,
                    d: Math.random() * 20,
                });
            }
        },
        // canvas 点是否落在（青海内 && 降雪区）
        _isSnowing: function (px, py) {
            var r = this._rect,
                g = this._grid,
                m = this._mask;
            if (!r || !g || !m) return false;
            if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h)
                return false;
            var gx = Math.floor(((px - r.x) / r.w) * g.cols);
            var gy = Math.floor(((py - r.y) / r.h) * g.rows);
            if (gx < 0 || gx >= g.cols || gy < 0 || gy >= g.rows) return false;
            return m[gy * g.cols + gx] === 1;
        },
        _animate: function () {
            var ctx = this._ctx;
            ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
            if (this._rect && this._mask && this._particles) {
                var r = this._rect;
                var ps = this._particles;
                ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
                ctx.beginPath();
                for (var i = 0; i < ps.length; i++) {
                    var p = ps[i];
                    if (this._isSnowing(p.x, p.y)) {
                        ctx.moveTo(p.x, p.y);
                        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2, true);
                    }
                }
                ctx.fill();
                // 飘落位移（左右摆动 + 下落），越界则回到降雪矩形顶部/两侧
                for (var j = 0; j < ps.length; j++) {
                    var p = ps[j];
                    p.y += Math.cos(p.d) + 1 + p.r / 2;
                    p.x += Math.sin(p.d) * 1.5;
                    if (
                        p.x > r.x + r.w + 5 ||
                        p.x < r.x - 5 ||
                        p.y > r.y + r.h
                    ) {
                        if (j % 3 > 0) {
                            ps[j] = {
                                x: r.x + Math.random() * r.w,
                                y: r.y - 10,
                                r: p.r,
                                d: p.d,
                            };
                        } else if (Math.sin(p.d) > 0) {
                            ps[j] = {
                                x: r.x - 5,
                                y: r.y + Math.random() * r.h,
                                r: p.r,
                                d: p.d,
                            };
                        } else {
                            ps[j] = {
                                x: r.x + r.w + 5,
                                y: r.y + Math.random() * r.h,
                                r: p.r,
                                d: p.d,
                            };
                        }
                    }
                }
            }
            this._raf = requestAnimationFrame(this._animate.bind(this));
        },
    });

    /* 雨滴下落粒子层：仅在降水区域渲染（用降水 IDW 网格做 mask 过滤，不污染无降水区） */
    var RainParticleLayer = L.Layer.extend({
        initialize: function (points) {
            this._points = points || [];
        },
        onAdd: function (map) {
            this._map = map;
            this._canvas = document.createElement("canvas");
            this._canvas.style.position = "absolute";
            this._canvas.style.top = 0;
            this._canvas.style.left = 0;
            this._canvas.style.pointerEvents = "none";
            this._canvas.style.zIndex = 1000;
            map.getContainer().appendChild(this._canvas);
            this._ctx = this._canvas.getContext("2d");
            this._resize();
            this._buildMask();
            this._initParticles();
            map.on("resize", this._resize, this);
            map.on("zoomend moveend", this._rebuild, this);
            this._animate();
        },
        onRemove: function (map) {
            cancelAnimationFrame(this._raf);
            map.getContainer().removeChild(this._canvas);
            map.off("resize", this._resize, this);
            map.off("zoomend moveend", this._rebuild, this);
        },
        setData: function (points) {
            this._points = points || [];
            if (this._map) this._buildMask();
        },
        _resize: function () {
            var rect = this._canvas.parentNode.getBoundingClientRect();
            this._canvas.width = rect.width;
            this._canvas.height = rect.height;
            this._buildMask();
            this._initParticles();
        },
        _rebuild: function () {
            this._buildMask();
            this._initParticles();
        },
        // 算青海降水网格 + 青海边界裁剪 mask + 青海在 canvas 的像素矩形
        _buildMask: function () {
            var b = L.latLngBounds(MAP_CONFIG.bounds);
            var west = b.getWest(),
                east = b.getEast(),
                south = b.getSouth(),
                north = b.getNorth();
            var cols = 160,
                rows = Math.ceil(cols * ((north - south) / (east - west)));
            this._grid = computeFloatGrid(
                this._points,
                "rain",
                cols,
                rows,
                west,
                east,
                south,
                north
            );
            // mask：网格点需同时满足「在青海多边形内」且「降水>0.1mm」，杜绝雨滴越界
            var g = this._grid;
            this._mask = new Uint8Array(g.cols * g.rows);
            for (var gy = 0; gy < g.rows; gy++) {
                var lat = g.north - (gy + 0.5) * g.dy;
                for (var gx = 0; gx < g.cols; gx++) {
                    var lng = g.west + (gx + 0.5) * g.dx;
                    if (
                        isInsideQinghai(lat, lng) &&
                        g.grid[gy * g.cols + gx] > 0.1
                    ) {
                        this._mask[gy * g.cols + gx] = 1;
                    }
                }
            }
            var tl = this._map.latLngToContainerPoint([north, west]);
            var br = this._map.latLngToContainerPoint([south, east]);
            this._rect = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
        },
        _initParticles: function () {
            if (!this._rect) return;
            var r = this._rect;
            this._particles = [];
            // 两层雨滴：近景（浓长快）+ 远景（淡短慢），营造纵深
            for (var i = 0; i < 900; i++) {
                var near = Math.random() < 0.45;
                this._particles.push({
                    x: r.x + Math.random() * r.w,
                    y: r.y + Math.random() * r.h,
                    len: 3 + Math.random() * 3,
                    speed: 3 + Math.random() * 3,
                    w: near ? 1.4 : 0.8,
                });
            }
            // 水花溅射池
            this._splashes = [];
        },
        // canvas 点是否落在（青海内 && 降水区）
        _isRaining: function (px, py) {
            var r = this._rect,
                g = this._grid,
                m = this._mask;
            if (!r || !g || !m) return false;
            if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h)
                return false;
            var gx = Math.floor(((px - r.x) / r.w) * g.cols);
            var gy = Math.floor(((py - r.y) / r.h) * g.rows);
            if (gx < 0 || gx >= g.cols || gy < 0 || gy >= g.rows) return false;
            return m[gy * g.cols + gx] === 1;
        },
        _animate: function () {
            var ctx = this._ctx;
            ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
            if (this._rect && this._mask && this._particles) {
                var r = this._rect;
                var ps = this._particles;
                var sp = this._splashes;
                var slant = 0.22; // 雨滴倾斜度（x/y），带风感
                // 远景层（淡细）
                ctx.beginPath();
                ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
                ctx.lineWidth = 0.8;
                for (var i = 0; i < ps.length; i++) {
                    var p = ps[i];
                    if (p.w > 1) continue;
                    if (this._isRaining(p.x, p.y)) {
                        ctx.moveTo(p.x, p.y);
                        ctx.lineTo(p.x + p.len * slant, p.y + p.len);
                    }
                }
                ctx.stroke();
                // 近景层（浓粗）
                ctx.beginPath();
                ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
                ctx.lineWidth = 1.4;
                for (var j = 0; j < ps.length; j++) {
                    var q = ps[j];
                    if (q.w <= 1) continue;
                    if (this._isRaining(q.x, q.y)) {
                        ctx.moveTo(q.x, q.y);
                        ctx.lineTo(q.x + q.len * slant, q.y + q.len);
                    }
                }
                ctx.stroke();

                // 水花溅射绘制（圆弧 + 小水珠）
                for (var si = sp.length - 1; si >= 0; si--) {
                    var s = sp[si];
                    var alpha = s.life / s.maxLife;
                    // 小圆弧（溅射伞形）
                    ctx.beginPath();
                    ctx.strokeStyle =
                        "rgba(255, 255, 255, " + (alpha * 0.7).toFixed(2) + ")";
                    ctx.lineWidth = 1;
                    ctx.arc(s.x, s.y, s.radius * (1 - alpha * 0.3), -Math.PI, 0, false);
                    ctx.stroke();
                    // 飞散小水珠
                    ctx.fillStyle =
                        "rgba(255, 255, 255, " + (alpha * 0.6).toFixed(2) + ")";
                    for (var di = 0; di < s.drops.length; di++) {
                        var d = s.drops[di];
                        var dx = s.x + d.vx * (1 - alpha) * 8;
                        var dy = s.y + d.vy * (1 - alpha) * 8 - (1 - alpha) * 4;
                        ctx.beginPath();
                        ctx.arc(dx, dy, d.r * alpha, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    s.life -= 1;
                    if (s.life <= 0) sp.splice(si, 1);
                }

                // 位移（斜向下落）
                for (var k = 0; k < ps.length; k++) {
                    var rp = ps[k];
                    rp.y += rp.speed;
                    rp.x += rp.speed * slant;
                    if (rp.y > r.y + r.h || rp.x > r.x + r.w) {
                        rp.y = r.y - rp.len;
                        rp.x = r.x + Math.random() * r.w;
                    }
                }

                // 在降水区域内持续生成溅射（模拟雨滴落在地面各处）
                if (sp.length < 160) {
                    // 每帧尝试生成若干溅射点，位置随机落在降水区域
                    for (var tryN = 0; tryN < 40; tryN++) {
                        if (Math.random() > 0.5) continue;
                        var sx = r.x + Math.random() * r.w;
                        var sy = r.y + Math.random() * r.h;
                        if (!this._isRaining(sx, sy)) continue;
                        var drops = [];
                        var dropCount = 3 + Math.floor(Math.random() * 3);
                        for (var dn = 0; dn < dropCount; dn++) {
                            drops.push({
                                vx: (Math.random() - 0.5) * 2,
                                vy: -Math.random() * 1.5 - 0.5,
                                r: 1 + Math.random() * 1.2,
                            });
                        }
                        sp.push({
                            x: sx,
                            y: sy,
                            radius: 3 + Math.random() * 3,
                            life: 8 + Math.floor(Math.random() * 6),
                            maxLife: 14,
                            drops: drops,
                        });
                    }
                }
            }
            this._raf = requestAnimationFrame(this._animate.bind(this));
        },
    });

    var CanvasOverlay = L.Layer.extend({
        initialize: function (canvas, bounds, options) {
            this._canvas = canvas;
            this._bounds = L.latLngBounds(bounds);
            L.Util.setOptions(this, options);
        },
        onAdd: function (map) {
            this._image = this._canvas;
            L.DomUtil.addClass(this._image, "leaflet-image-layer");
            if (this.options.opacity !== undefined)
                this._image.style.opacity = this.options.opacity;
            if (this.options.mixBlendMode)
                this._image.style.mixBlendMode = this.options.mixBlendMode;
            if (map.options.zoomAnimation && L.Browser.any3d)
                L.DomUtil.addClass(this._image, "leaflet-zoom-animated");
            map.getPane(this.options.pane || "overlayPane").appendChild(
                this._image,
            );
            this._reset();
        },
        onRemove: function (map) {
            L.DomUtil.remove(this._image);
        },
        getEvents: function () {
            var events = { zoom: this._reset, viewreset: this._reset };
            if (this._zoomAnimated) events.zoomanim = this._animateZoom;
            return events;
        },
        _animateZoom: function (e) {
            var scale = this._map.getZoomScale(e.zoom),
                offset = this._map._latLngBoundsToNewLayerBounds(
                    this._bounds,
                    e.zoom,
                    e.center,
                ).min;
            L.DomUtil.setTransform(this._image, offset, scale);
        },
        _reset: function () {
            var image = this._image,
                bounds = new L.Bounds(
                    this._map.latLngToLayerPoint(this._bounds.getNorthWest()),
                    this._map.latLngToLayerPoint(this._bounds.getSouthEast()),
                ),
                size = bounds.getSize();
            L.DomUtil.setPosition(image, bounds.min);
            image.style.width = size.x + "px";
            image.style.height = size.y + "px";
        },
    });

    function computeFloatGrid(
        points,
        type,
        cols,
        rows,
        west,
        east,
        south,
        north,
    ) {
        var dx = (east - west) / cols;
        var dy = (north - south) / rows;
        var cosLat = Math.cos((((south + north) / 2) * Math.PI) / 180);
        var grid = new Float32Array(cols * rows);
        var idx = 0;
        var R = 5.0,
            R2 = R * R,
            smoothing = 0.05;

        for (var gy = 0; gy < rows; gy++) {
            var lat = north - gy * dy;
            for (var gx = 0; gx < cols; gx++) {
                var lng = west + gx * dx;
                var sumV = 0,
                    sumW = 0,
                    closestVal = 0,
                    minDist2 = Infinity;
                for (var i = 0; i < points.length; i++) {
                    var p = points[i];
                    var dlng = (lng - p.lng) * cosLat,
                        dlat = lat - p.lat;
                    var d2 = dlng * dlng + dlat * dlat;
                    if (d2 < minDist2) {
                        minDist2 = d2;
                        closestVal = p.value;
                    }
                    if (d2 > R2) continue;

                    var w;
                    if (type === "rain" || type === "snow")
                        w = 1.0 / Math.pow(d2 + smoothing, 3);
                    else w = 1.0 / (d2 + smoothing);

                    sumV += p.value * w;
                    sumW += w;
                }
                grid[idx++] = sumW > 0 ? sumV / sumW : closestVal;
            }
        }
        return {
            grid: grid,
            cols: cols,
            rows: rows,
            dx: dx,
            dy: dy,
            west: west,
            north: north,
        };
    }

    function updateCanvasOverlay(layer, points, type) {
        var bounds = L.latLngBounds(MAP_CONFIG.bounds);
        var west = bounds.getWest(),
            east = bounds.getEast();
        var south = bounds.getSouth(),
            north = bounds.getNorth();

        var cols = 240;
        var rows = Math.ceil(cols * ((north - south) / (east - west)));

        var resolveType = type === "wind" ? "windSpeed" : type;
        var gridData = computeFloatGrid(
            points,
            resolveType,
            cols,
            rows,
            west,
            east,
            south,
            north,
        );
        var grid = gridData.grid;

        var displayCanvas = layer._canvas;
        displayCanvas.width = cols;
        displayCanvas.height = rows;
        var ctx = displayCanvas.getContext("2d");
        var imgData = ctx.createImageData(cols, rows);
        var data = imgData.data;

        for (var i = 0; i < cols * rows; i++) {
            var val = grid[i];
            var c = getIdwColor(resolveType, val);
            data[i * 4] = c.r;
            data[i * 4 + 1] = c.g;
            data[i * 4 + 2] = c.b;
            data[i * 4 + 3] = c.a;
        }
        ctx.putImageData(imgData, 0, 0);
    }

    function createPerformanceIdwLayer(points, type) {
        var displayCanvas = document.createElement("canvas");
        var bounds = L.latLngBounds(MAP_CONFIG.bounds);
        // multiply 混合：热力区颜色与青海底图相乘，"印"在地形上，既保留色阶又透出底图。
        // 关键：canvas 必须与底图同处一个 stacking context（同 pane）mix-blend-mode 才生效——
        // Leaflet 各 pane 的 z-index 会让 pane 成为独立 stacking context，跨 pane blend 会被屏蔽。
        // 故热力层挂到 baseImagePane（与底图同 pane）；opacity 用 1.0（<1 同样会屏蔽 blend）。
        // 若想去掉 multiply 改回纯半透明：删掉 mixBlendMode 行、pane 改回 "heatPane"、opacity 调 0.6~0.75。
        var layer = new CanvasOverlay(displayCanvas, bounds, {
            opacity: 1.0,
            pane: "baseImagePane",
            mixBlendMode: "multiply",
        });
        layer.points = points;
        layer._type = type;
        layer.smoothRedraw = function () {
            updateCanvasOverlay(this, this.points, this._type);
        };
        layer.smoothRedraw();
        return layer;
    }

    function createContourVectorLayer(points) {
        var ContourLayer = L.GridLayer.extend({
            smoothRedraw: function () {
                var bounds = L.latLngBounds(MAP_CONFIG.bounds);
                var cols = 150,
                    rows = Math.ceil(
                        cols *
                            ((bounds.getNorth() - bounds.getSouth()) /
                                (bounds.getEast() - bounds.getWest())),
                    );
                if (this._nextGlobal) {
                    /* 播放时由 precomputeContourNext 在过渡期间提前算好，复用跳过 IDW */
                    this.globalData = this._nextGlobal;
                    this._nextGlobal = null;
                } else {
                    this.globalData = computeFloatGrid(
                        this.points,
                        "isobar",
                        cols,
                        rows,
                        bounds.getWest(),
                        bounds.getEast(),
                        bounds.getSouth(),
                        bounds.getNorth(),
                    );
                }
                var tiles = this._tiles;
                Object.keys(tiles).forEach(
                    function (key) {
                        var entry = tiles[key];
                        if (!entry.current || !entry.coords) return;
                        var freshCanvas = this.createTile(entry.coords);
                        if (entry.el && entry.el.getContext) {
                            var elCtx = entry.el.getContext("2d");
                            elCtx.clearRect(
                                0,
                                0,
                                entry.el.width,
                                entry.el.height,
                            );
                            elCtx.drawImage(freshCanvas, 0, 0);
                        }
                    }.bind(this),
                );
            },
            createTile: function (coords) {
                var tile = L.DomUtil.create("canvas", "leaflet-tile"),
                    size = this.getTileSize();
                tile.width = size.x;
                tile.height = size.y;
                var ctx = tile.getContext("2d");

                if (!this.globalData) {
                    var gBounds = L.latLngBounds(MAP_CONFIG.bounds);
                    var gCols = 150,
                        gRows = Math.ceil(
                            gCols *
                                ((gBounds.getNorth() - gBounds.getSouth()) /
                                    (gBounds.getEast() - gBounds.getWest())),
                        );
                    this.globalData = computeFloatGrid(
                        this.points,
                        "isobar",
                        gCols,
                        gRows,
                        gBounds.getWest(),
                        gBounds.getEast(),
                        gBounds.getSouth(),
                        gBounds.getNorth(),
                    );
                }
                var globalData = this.globalData;
                var bounds = this._tileCoordsToBounds(coords);
                var west = bounds.getWest(),
                    east = bounds.getEast(),
                    north = bounds.getNorth(),
                    south = bounds.getSouth();
                var gridStep = 6,
                    cols = Math.ceil(size.x / gridStep) + 1,
                    rows = Math.ceil(size.y / gridStep) + 1;
                var grid = Array.from({ length: rows }, function () {
                    return new Float32Array(cols);
                });

                for (var gy = 0; gy < rows; gy++) {
                    var lat =
                        north - ((gy * gridStep) / size.y) * (north - south);
                    for (var gx = 0; gx < cols; gx++) {
                        var lng =
                            west + ((gx * gridStep) / size.x) * (east - west);
                        var gxGlobal = (lng - globalData.west) / globalData.dx,
                            gyGlobal = (globalData.north - lat) / globalData.dy;
                        var x0 = Math.floor(gxGlobal),
                            x1 = Math.min(x0 + 1, globalData.cols - 1);
                        var y0 = Math.floor(gyGlobal),
                            y1 = Math.min(y0 + 1, globalData.rows - 1);
                        if (x0 < 0) x0 = 0;
                        if (y0 < 0) y0 = 0;
                        var tx = gxGlobal - x0,
                            ty = gyGlobal - y0;
                        var v00 = globalData.grid[y0 * globalData.cols + x0],
                            v10 = globalData.grid[y0 * globalData.cols + x1];
                        var v01 = globalData.grid[y1 * globalData.cols + x0],
                            v11 = globalData.grid[y1 * globalData.cols + x1];
                        grid[gy][gx] =
                            v00 * (1 - tx) * (1 - ty) +
                            v10 * tx * (1 - ty) +
                            v01 * (1 - tx) * ty +
                            v11 * tx * ty;
                    }
                }

                function getIsobarStyle(val) {
                    if (val < 600)
                        return { color: "rgba(100, 50, 150, 0.8)", width: 1.2 };
                    if (val >= 600 && val < 700)
                        return {
                            color: "rgba(150, 100, 200, 0.8)",
                            width: 1.3,
                        };
                    if (val >= 700 && val < 800)
                        return {
                            color: "rgba(200, 150, 250, 0.85)",
                            width: 1.4,
                        };
                    if (val >= 800 && val < 900)
                        return { color: "rgba(50, 150, 250, 0.9)", width: 1.5 };
                    return { color: "rgba(0, 100, 200, 0.95)", width: 1.6 };
                }

                var contourInterval = (METEO_CONFIG.isobar || { interval: 20 })
                    .interval;
                ctx.lineJoin = "round";
                ctx.lineCap = "round";

                for (var cy = 0; cy < rows - 1; cy++) {
                    for (var cx = 0; cx < cols - 1; cx++) {
                        var v1 = grid[cy][cx],
                            v2 = grid[cy][cx + 1],
                            v3 = grid[cy + 1][cx],
                            v4 = grid[cy + 1][cx + 1];
                        var minV = Math.min(v1, v2, v3, v4),
                            maxV = Math.max(v1, v2, v3, v4);
                        if (maxV - minV > 50 * contourInterval) continue;

                        var minLevel = Math.floor(minV / contourInterval),
                            maxLevel = Math.floor(maxV / contourInterval);
                        if (minLevel !== maxLevel) {
                            for (
                                var level = minLevel + 1;
                                level <= maxLevel;
                                level++
                            ) {
                                var target = level * contourInterval,
                                    pts = [];
                                if (
                                    (v1 <= target && v2 >= target) ||
                                    (v1 >= target && v2 <= target)
                                )
                                    pts.push({
                                        x: cx + (target - v1) / (v2 - v1),
                                        y: cy,
                                    });
                                if (
                                    (v3 <= target && v4 >= target) ||
                                    (v3 >= target && v4 <= target)
                                )
                                    pts.push({
                                        x: cx + (target - v3) / (v4 - v3),
                                        y: cy + 1,
                                    });
                                if (
                                    (v1 <= target && v3 >= target) ||
                                    (v1 >= target && v3 <= target)
                                )
                                    pts.push({
                                        x: cx,
                                        y: cy + (target - v1) / (v3 - v1),
                                    });
                                if (
                                    (v2 <= target && v4 >= target) ||
                                    (v2 >= target && v4 <= target)
                                )
                                    pts.push({
                                        x: cx + 1,
                                        y: cy + (target - v2) / (v4 - v2),
                                    });

                                if (pts.length >= 2) {
                                    var px1 = pts[0].x * gridStep,
                                        py1 = pts[0].y * gridStep,
                                        px2 = pts[1].x * gridStep,
                                        py2 = pts[1].y * gridStep;
                                    var style = getIsobarStyle(target);
                                    ctx.beginPath();
                                    ctx.strokeStyle = style.color;
                                    ctx.lineWidth = style.width;
                                    ctx.moveTo(px1, py1);
                                    ctx.lineTo(px2, py2);
                                    ctx.stroke();

                                    if (
                                        cx % 40 === 20 &&
                                        cy % 40 === 20 &&
                                        px1 > 25 &&
                                        py1 > 25 &&
                                        px1 < size.x - 25
                                    ) {
                                        var mx = (px1 + px2) / 2,
                                            my = (py1 + py2) / 2,
                                            angle = Math.atan2(
                                                py2 - py1,
                                                px2 - px1,
                                            );
                                        if (
                                            angle > Math.PI / 2 ||
                                            angle < -Math.PI / 2
                                        )
                                            angle += Math.PI;
                                        ctx.save();
                                        ctx.translate(mx, my);
                                        ctx.rotate(angle);
                                        ctx.fillStyle = "rgba(30, 42, 54, 0.8)";
                                        if (ctx.roundRect) {
                                            ctx.beginPath();
                                            ctx.roundRect(-16, -8, 32, 16, 4);
                                            ctx.fill();
                                        } else {
                                            ctx.fillRect(-16, -8, 32, 16);
                                        }
                                        ctx.fillStyle = "#ffffff";
                                        ctx.font =
                                            "normal 10px system-ui, sans-serif";
                                        ctx.textAlign = "center";
                                        ctx.textBaseline = "middle";
                                        ctx.fillText(Math.round(target), 0, 0);
                                        ctx.restore();
                                    }
                                }
                            }
                        }
                    }
                }
                var rThreshold = 20,
                    centers = [];
                for (var hy = rThreshold; hy < rows - rThreshold; hy += 6) {
                    for (var hx = rThreshold; hx < cols - rThreshold; hx += 6) {
                        var hVal = grid[hy][hx],
                            isMax = true,
                            isMin = true;
                        for (var hdy = -rThreshold; hdy <= rThreshold; hdy++) {
                            for (
                                var hdx = -rThreshold;
                                hdx <= rThreshold;
                                hdx++
                            ) {
                                if (hdx === 0 && hdy === 0) continue;
                                var neighbor = grid[hy + hdy][hx + hdx];
                                if (neighbor >= hVal) isMax = false;
                                if (neighbor <= hVal) isMin = false;
                            }
                        }
                        if (isMax && hVal > 800)
                            centers.push({
                                type: "H",
                                x: hx * gridStep,
                                y: hy * gridStep,
                                val: Math.round(hVal),
                            });
                        else if (isMin && hVal < 700)
                            centers.push({
                                type: "L",
                                x: hx * gridStep,
                                y: hy * gridStep,
                                val: Math.round(hVal),
                            });
                    }
                }
                centers.forEach(function (c) {
                    ctx.save();
                    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
                    ctx.shadowBlur = 5;
                    ctx.font = "bold 16px Arial, sans-serif";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    if (c.type === "H") {
                        ctx.fillStyle = "#ff4d4f";
                        ctx.strokeStyle = "#ffffff";
                        ctx.lineWidth = 2.5;
                        ctx.strokeText("H", c.x, c.y - 8);
                        ctx.fillText("H", c.x, c.y - 8);
                    } else {
                        ctx.fillStyle = "#1890ff";
                        ctx.strokeStyle = "#ffffff";
                        ctx.lineWidth = 2.5;
                        ctx.strokeText("L", c.x, c.y - 8);
                        ctx.fillText("L", c.x, c.y - 8);
                    }
                    ctx.shadowBlur = 0;
                    ctx.font = "bold 11px monospace, sans-serif";
                    ctx.fillStyle = "#ffffff";
                    ctx.strokeStyle = "rgba(0,0,0,0.8)";
                    ctx.lineWidth = 2.5;
                    ctx.strokeText(c.val, c.x, c.y + 8);
                    ctx.fillText(c.val, c.x, c.y + 8);
                    ctx.restore();
                });
                return tile;
            },
        });
        var layer = new ContourLayer({
            opacity: 1.0,
            pane: "heatPane",
            updateWhenZooming: false,
        });
        layer.points = points;
        return layer;
    }

    function buildWeatherIconLayer() {
        var currentContours = cacheData.timeSeriesCmiss[currentTimeIndex];
        if (!currentContours) return null;
        var markers = [];
        for (var i = 0; i < currentContours.length; i++) {
            var s = currentContours[i];
            if (!isInsideQinghai(s[2], s[1])) continue;
            var c = String(s[4]),
                iconCfg = WEATHER_ICONS[c];
            /* 缺测(9999)或未知电码 → 兜底显示阴(电码13) */
            if (!iconCfg) iconCfg = WEATHER_ICONS["13"];
            var divIcon = L.divIcon({
                html: iconCfg.html,
                className: "wm-ic",
                iconSize: [28, 28],
                iconAnchor: [14, 14],
            });
            var marker = L.marker([s[2], s[1]], { icon: divIcon });
            var popup =
                '<div class="popup-title">📍 ' + (s[27] || "") + "</div>";
            popup +=
                '<div class="popup-row">🧭 经纬度: ' +
                (+s[2]).toFixed(3) +
                "°N, " +
                (+s[1]).toFixed(3) +
                "°E</div>";
            popup +=
                '<div class="popup-row">🌤️ 天气: ' + iconCfg.label + "</div>";
            marker.bindPopup(popup, {
                className: "weather-popup",
                maxWidth: 240,
            });
            markers.push(marker);
        }
        return L.layerGroup(markers);
    }

    /* ============================================================
     固定场站图层：构建与刷新
     ============================================================ */
    function buildStationLayer() {
        if (!stationConfig || stationConfig.length === 0) return null;
        var markers = [];
        stationConfig.forEach(function (st) {
            var typeKey =
                st.type && STATION_TYPE_ICON[st.type] ? st.type : "default";
            var iconUrl = STATION_TYPE_ICON[typeKey];
            var fallback =
                STATION_TYPE_FALLBACK[typeKey] || STATION_TYPE_FALLBACK.default;

            /* 外层图标 + 名称；data-fallback 供图片缺失兜底显示 emoji */
            var html =
                '<div class="wm-station">' +
                '<div class="wm-station-icon" data-fallback="' +
                fallback +
                '">' +
                '<img class="wm-station-pic" src="' +
                iconUrl +
                '" alt="' +
                (st.name || "") +
                '" onerror="this.style.display=\'none\';this.parentNode.classList.add(\'is-fallback\')" />';

            /* 天气图层激活且场站有天气电码时叠加天气角标 */
            if (showStationWeather && st.weather != null && st.weather !== "") {
                var code = String(st.weather);
                var wx = WEATHER_ICONS[code] || WEATHER_ICONS["13"];
                html +=
                    '<span class="wm-station-wx" title="' +
                    wx.label +
                    '">' +
                    '<img src="../base/rs/img/tq-' +
                    code +
                    '.png" alt="' +
                    wx.label +
                    '" /></span>';
            }
            html +=
                "</div>" +
                '<div class="wm-station-name">' +
                (st.name || "") +
                "</div></div>";

            var divIcon = L.divIcon({
                html: html,
                className: "wm-station-wrap",
                iconSize: [28, 28],
                iconAnchor: [14, 14],
            });
            var marker = L.marker([st.lat, st.lng], {
                icon: divIcon,
                pane: "stationPane", /* 专用顶层 pane：盖过所有气象图层与站点图标 */
            });
            marker._stationGroup = st.group || ""; // 记录分组(地区/公司)，供批量高亮

            /* popup：类型 + 经纬度 + 天气（如有） */
            var popup =
                '<div class="popup-title">📍 ' + (st.name || "") + "</div>";
            popup +=
                '<div class="popup-row">🏷️ 类型: ' +
                (STATION_TYPE_LABEL[typeKey] || typeKey) +
                "</div>";
            popup +=
                '<div class="popup-row">🧭 经纬度: ' +
                (+st.lat).toFixed(3) +
                "°N, " +
                (+st.lng).toFixed(3) +
                "°E</div>";
            if (st.weather != null && st.weather !== "") {
                var wx2 = WEATHER_ICONS[String(st.weather)] || WEATHER_ICONS["13"];
                popup +=
                    '<div class="popup-row">🌤️ 天气: ' + wx2.label + "</div>";
            }
            marker.bindPopup(popup, {
                className: "weather-popup",
                maxWidth: 240,
            });
            markers.push(marker);
        });
        return L.layerGroup(markers);
    }

    /* 重建场站图层（配置变化或天气角标开关变化时调用） */
    function refreshStationLayer() {
        if (!map) return;
        if (stationLayer) {
            map.removeLayer(stationLayer);
            stationLayer = null;
        }
        if (stationConfig && stationConfig.length > 0) {
            stationLayer = buildStationLayer();
            if (stationLayer) {
                stationLayer.addTo(map);
                /* 重建后 DOM 已更新，需重新应用当前高亮分组 */
                applyHighlight();
            }
        }
    }

    /* 按分组批量高亮场站：currentHighlight 为 null 时全部恢复正常态。
       匹配分组的场站突出（放大/发光），其余场站半透明弱化。
       通过切换 marker 根元素的 CSS class 实现，不重建图层、无闪烁。 */
    function applyHighlight() {
        if (!stationLayer) return;
        stationLayer.eachLayer(function (marker) {
            var el = marker.getElement();
            if (!el) return;
            if (currentHighlight == null) {
                el.classList.remove("is-highlight", "is-dimmed");
                el.style.zIndex = ""; // 恢复 Leaflet 按纬度的默认层级
                return;
            }
            if ((marker._stationGroup || "") === currentHighlight) {
                el.classList.add("is-highlight");
                el.classList.remove("is-dimmed");
                el.style.zIndex = 1000; // 高亮组置顶（覆盖 Leaflet 的纬度层级）
            } else {
                el.classList.add("is-dimmed");
                el.classList.remove("is-highlight");
                el.style.zIndex = "";
            }
        });
    }

    /* 风速(m/s) + 风向角度(0-360, 来风方向, 0=北, 顺时针) → U/V 分量 */
    function windToUV(speed, dir) {
        var rad = (dir * Math.PI) / 180;
        return {
            u: -speed * Math.sin(rad), // 东西向(东正西负)
            v: -speed * Math.cos(rad), // 南北向(北正南负)
        };
    }

    /* 从当前时间步 cmiss 站点提取风速/风向：s[5]=风速, s[6]=风向(来风,0=北) */
    function extractWindStations(timeIndex) {
        var contours =
            cacheData.timeSeriesCmiss.length > 0
                ? cacheData.timeSeriesCmiss[timeIndex]
                : null;
        if (!contours) return [];
        var list = [];
        contours.forEach(function (s) {
            var speed = s[5],
                dir = s[6];
            if (
                speed == null ||
                speed === 9999 ||
                dir == null ||
                dir === 9999
            )
                return;
            list.push({ lat: s[2], lng: s[1], speed: speed, dir: dir });
        });
        return list;
    }

    /* 站点风速+风向 → U/V 网格(leaflet-velocity 格式) + 风速点(热力区用)。
       U/V 分别 IDW 插值到青海网格。 */
    function buildStationWindField(stations) {
        if (!stations || !stations.length) return null;
        var b = MAP_CONFIG.bounds;
        var south = b[0][0],
            west = b[0][1],
            north = b[1][0],
            east = b[1][1];
        var step = 0.5; // 插值网格分辨率(°)
        var cols = Math.round((east - west) / step) + 1;
        var rows = Math.round((north - south) / step) + 1;

        var uPts = [],
            vPts = [],
            speedPts = [];
        stations.forEach(function (st) {
            var uv = windToUV(st.speed, st.dir);
            uPts.push({ lat: st.lat, lng: st.lng, value: uv.u });
            vPts.push({ lat: st.lat, lng: st.lng, value: uv.v });
            speedPts.push({ lat: st.lat, lng: st.lng, value: st.speed });
        });

        var uGrid = computeFloatGrid(
            uPts,
            "windSpeed",
            cols,
            rows,
            west,
            east,
            south,
            north,
        );
        var vGrid = computeFloatGrid(
            vPts,
            "windSpeed",
            cols,
            rows,
            west,
            east,
            south,
            north,
        );

        var header = {
            discipline: 0,
            parameterCategory: 2,
            lo1: west,
            la1: north,
            lo2: east,
            la2: south,
            nx: cols,
            ny: rows,
            dx: step,
            dy: step,
            refTime: new Date().toISOString(),
            parameterNumber: 2,
            parameterNumberName: "U-component_of_wind",
            parameterUnit: "m.s-1",
        };
        var headerV = Object.assign({}, header, {
            parameterNumber: 3,
            parameterNumberName: "V-component_of_wind",
        });
        return {
            uv: [
                { header: header, data: Array.from(uGrid.grid) },
                { header: headerV, data: Array.from(vGrid.grid) },
            ],
            speed: speedPts,
        };
    }

    /* 创建 leaflet-velocity 粒子层实例（白色流线仅表达风向；风速由背景热力区表达） */
    function createVelLayer(data) {
        return L.velocityLayer({
            displayValues: true,
            displayOptions: {
                velocityType: "风场",
                displayPosition: "bottomright",
                speedUnit: "m/s",
            },
            data: data,
            maxVelocity: 20,
            velocityScale: 0.005,
            particleMultiplier: 1 / 600,
            lineWidth: 1.5,
            colorScale: [
                "rgba(255, 255, 255, 0.9)",
                "rgba(255, 255, 255, 0.95)",
                "rgba(255, 255, 255, 1)",
            ],
        });
    }

    /* ============================================================
     构建图层：彻底解耦全局风场插件，挂载原生地图 Group 中
     ============================================================ */
    function buildWeatherLayer(type) {
        if (type === "weather") return buildWeatherIconLayer();

        // 降雪复合特效
        if (type === "snow") {
            var compositeGroup = L.layerGroup();
            var currentContours =
                cacheData.timeSeriesCmiss.length > 0
                    ? cacheData.timeSeriesCmiss[currentTimeIndex]
                    : null;
            var points = extractPointsFromContours("snow", currentContours);
            if (points && points.length > 0) {
                var heatLayer = createPerformanceIdwLayer(points, "snow");
                heatLayer.points = points;
                compositeGroup.heatLayer = heatLayer;
                compositeGroup.addLayer(heatLayer);
            }
            var snowFx = new SnowParticleLayer(points);
            compositeGroup.snowFx = snowFx;
            compositeGroup.addLayer(snowFx);
            compositeGroup.points = points;
            return compositeGroup;
        }

        // 降水复合特效：降水热力层 + 雨滴下落粒子（粒子仅限降水区域）
        if (type === "rain") {
            var compositeGroup = L.layerGroup();
            var rainContours =
                cacheData.timeSeriesCmiss.length > 0
                    ? cacheData.timeSeriesCmiss[currentTimeIndex]
                    : null;
            var rainPoints = extractPointsFromContours("rain", rainContours);
            if (rainPoints && rainPoints.length > 0) {
                var heatLayer = createPerformanceIdwLayer(rainPoints, "rain");
                heatLayer.points = rainPoints;
                compositeGroup.heatLayer = heatLayer;
                compositeGroup.addLayer(heatLayer);
                var rainFx = new RainParticleLayer(rainPoints);
                compositeGroup.rainFx = rainFx;
                compositeGroup.addLayer(rainFx);
            }
            compositeGroup.points = rainPoints;
            return compositeGroup;
        }

        // 复合大风层：由 cmiss 站点(s[5]风速 + s[6]风向)驱动 → U/V 网格喂粒子层，风速点喂热力区
        if (type === "wind" || type === "windSpeed") {
            var compositeGroup = L.layerGroup();
            var built = buildStationWindField(
                extractWindStations(currentTimeIndex),
            );
            if (built) {
                cacheData.gfs = built.uv;
                var heatLayer = createPerformanceIdwLayer(
                    built.speed,
                    "windSpeed",
                );
                heatLayer.points = built.speed;
                compositeGroup.heatLayer = heatLayer;
                compositeGroup.addLayer(heatLayer);
                /* 首次激活风速图层时用站点 U/V 创建粒子层；已存在则更新数据 */
                if (!globalVelLayer) {
                    globalVelLayer = createVelLayer(built.uv);
                } else if (globalVelLayer.setData) {
                    globalVelLayer.setData(built.uv);
                }
                if (globalVelLayer) {
                    compositeGroup.velLayer = globalVelLayer;
                    compositeGroup.addLayer(globalVelLayer);
                }
            }
            compositeGroup.points = built ? built.speed : [];
            return compositeGroup;
        }

        // 气压：气压热力图 + 等压线叠加（类似风速的热力背景 + 流线前景结构）
        if (type === "isobar") {
            var compositeGroup = L.layerGroup();
            var pressureContours =
                cacheData.timeSeriesCmiss.length > 0
                    ? cacheData.timeSeriesCmiss[currentTimeIndex]
                    : null;
            var pressurePoints = extractPointsFromContours(
                "pressure",
                pressureContours
            );
            if (pressurePoints && pressurePoints.length > 0) {
                // 气压热力背景（pressure 色带 500-1000 hPa）
                var heatLayer = createPerformanceIdwLayer(pressurePoints, "pressure");
                heatLayer.points = pressurePoints;
                compositeGroup.heatLayer = heatLayer;
                compositeGroup.addLayer(heatLayer);
                // 等压线前景（每 interval hPa 一条，自动上色 + H/L 高低中心）
                var contourLayer = createContourVectorLayer(pressurePoints);
                contourLayer.points = pressurePoints;
                compositeGroup.contourLayer = contourLayer;
                compositeGroup.addLayer(contourLayer);
            }
            compositeGroup.points = pressurePoints;
            return compositeGroup;
        }

        var currentContours =
            cacheData.timeSeriesCmiss.length > 0
                ? cacheData.timeSeriesCmiss[currentTimeIndex]
                : null;
        var points = extractPointsFromContours(type, currentContours);
        if (points.length === 0) return null;
        var layer = createPerformanceIdwLayer(points, type);
        if (layer) layer.points = points;
        return layer;
    }

    var MUTEX_TYPES = [
        "wind",
        "rain",
        "snow",
        "temp",
        "pressure",
        "isobar",
        "humidity",
        "radiation",
        "cloud",
    ];

    function toggleLayer(type, forceState) {
        if (type === "windSpeed") type = "wind";
        /* 切换图层时关闭已打开的弹窗，避免内容与新图层不符 */
        if (map) map.closePopup();

        var wasActive =
            !!mapLayersCache[type] &&
            map._layers[mapLayersCache[type]._leaflet_id];
        var willBeActive =
            typeof forceState === "boolean" ? forceState : !wasActive;

        /* 天气图层与固定场站联动：激活时在场站上叠加天气角标，关闭时移除 */
        if (type === "weather" && showStationWeather !== willBeActive) {
            showStationWeather = willBeActive;
            refreshStationLayer();
        }

        if (wasActive && !willBeActive) {
            map.removeLayer(mapLayersCache[type]);
            if (type === "snow") delete mapLayersCache[type];
            return false;
        }

        if (!wasActive && willBeActive) {
            // 仅当当前图层本身属于互斥组时，才移除其它互斥图层；
            // 天气图标(weather)需与风场等互斥图层叠加共存，不参与互斥移除。
            if (MUTEX_TYPES.indexOf(type) >= 0) {
                MUTEX_TYPES.forEach(function (mType) {
                    if (mType === type) return;
                    var mLayer = mapLayersCache[mType];
                    if (mLayer && map._layers[mLayer._leaflet_id]) {
                        map.removeLayer(mLayer);
                        if (mType === "snow") delete mapLayersCache[mType];
                    }
                });
            }

            if (!mapLayersCache[type]) {
                mapLayersCache[type] = buildWeatherLayer(type);
            } else if (MUTEX_TYPES.indexOf(type) >= 0) {
                var currentContours =
                    cacheData.timeSeriesCmiss.length > 0
                        ? cacheData.timeSeriesCmiss[currentTimeIndex]
                        : null;
                if (currentContours)
                    mapLayersCache[type].points = extractPointsFromContours(
                        type,
                        currentContours,
                    );
            }

            if (mapLayersCache[type]) mapLayersCache[type].addTo(map);

            /* 播放中切换图层：新激活的雨/雪/风粒子会随 onAdd 自动启动，
               需继续隐藏，保持"播放期间不渲染粒子" */
            if (isPlaying) setParticleFxVisible(false);

            /* 只异步预算当前帧供拖动时间轴秒出；全部帧留到点播放时由
               startPlayback 统一预算，避免切换瞬间后台密集算 6 帧抢 CPU 卡顿 */
            if (MUTEX_TYPES.indexOf(type) >= 0) {
                var _preT = type, _preI = currentTimeIndex;
                setTimeout(function () { getCachedFrame(_preT, _preI); }, 0);
            }

            if (window.updateLegendUI)
                window.updateLegendUI(type, METEO_CONFIG);
            return true;
        }
        return wasActive;
    }

    function bindMapPopup() {
        map.on("click", function (e) {
            var lat = e.latlng.lat,
                lng = e.latlng.lng;
            if (!isInsideQinghai(lat, lng)) return;
            var station = findNearestStation(lat, lng);
            var rows = [];

            function check(v) {
                return (
                    v !== undefined &&
                    v !== 9999 &&
                    v !== 999999 &&
                    v !== -9999 &&
                    v !== -999
                );
            }
            function isOn(t) {
                var l = mapLayersCache[t];
                return !!l && !!map._layers[l._leaflet_id];
            }

            /* 只展示当前激活图层对应的气象要素（互斥图层仅一个激活） */
            var activeType = getActiveLayerType();
            if (station) {
                if (activeType === "temp" && check(station[19]))
                    rows.push(
                        '<div class="popup-row">🌡️ <b>气温:</b> ' +
                            station[19] +
                            "°C</div>",
                    );
                else if (activeType === "rain" && check(station[12]))
                    rows.push(
                        '<div class="popup-row">💧 <b>降水:</b> ' +
                            station[12] +
                            " mm</div>",
                    );
                else if (activeType === "snow" && check(station[12]))
                    rows.push(
                        '<div class="popup-row">❄️ <b>降雪量:</b> ' +
                            station[12] +
                            " mm</div>",
                    );
                else if (activeType === "wind" || activeType === "windSpeed") {
                    if (check(station[5]))
                        rows.push(
                            '<div class="popup-row">🌪 <b>实况风速:</b> ' +
                                station[5] +
                                " m/s</div>",
                        );
                    if (
                        !isPlaying &&
                        cacheData.gfs &&
                        cacheData.gfs.length >= 2
                    ) {
                        var v = getGridValueAt(cacheData.gfs, lat, lng);
                        if (v && v[0] != null && v[1] != null) {
                            var speed = Math.sqrt(
                                v[0] * v[0] + v[1] * v[1],
                            ).toFixed(1),
                                dir = (
                                    ((Math.atan2(-v[0], -v[1]) * 180) / Math.PI +
                                        360) %
                                    360
                                ).toFixed(0);
                            rows.push(
                                '<div class="popup-row">🌬️ <b>预报流线:</b> ' +
                                    speed +
                                    " m/s  (" +
                                    dir +
                                    "°)</div>",
                            );
                        }
                    }
                } else if (
                    (activeType === "pressure" || activeType === "isobar") &&
                    check(station[8])
                )
                    rows.push(
                        '<div class="popup-row">⏱ <b>气压:</b> ' +
                            station[8] +
                            " hPa</div>",
                    );
                else if (activeType === "humidity" && check(station[9]))
                    rows.push(
                        '<div class="popup-row">💧 <b>相对湿度:</b> ' +
                            station[9] +
                            " %</div>",
                    );
                else if (activeType === "radiation" && check(station[10]))
                    rows.push(
                        '<div class="popup-row">☀️ <b>太阳辐射:</b> ' +
                            station[10] +
                            " W/m²</div>",
                    );
                else if (activeType === "cloud" && check(station[11]))
                    rows.push(
                        '<div class="popup-row">☁️ <b>总云量:</b> ' +
                            station[11] +
                            " %</div>",
                    );
                else if (
                    activeType == null &&
                    isOn("weather") &&
                    station[4] != null
                ) {
                    /* 仅天气图标图层激活时，展示天气现象 */
                    var wx = WEATHER_ICONS[String(station[4])];
                    if (wx)
                        rows.push(
                            '<div class="popup-row">🌤️ <b>天气:</b> ' +
                                wx.label +
                                "</div>",
                        );
                }
            }

            /* 地点（最近站点名）+ 经纬度始终展示 */
            var place = station && station[27] ? station[27] : "";
            var html =
                '<div class="popup-title">📍 ' +
                (place ? place + "  ·  " : "") +
                lat.toFixed(2) +
                "°N, " +
                lng.toFixed(2) +
                "°E</div>" +
                rows.join("");
            L.popup({
                className: "weather-popup",
                maxWidth: 280,
                autoPan: false,
            })
                .setLatLng(e.latlng)
                .setContent(html)
                .openOn(map);
        });
    }

    /* ============================================================
     墨迹 EC1x1 接口适配层（映射到 cmiss s[] 结构）
     文档：GET /v1/ompdata/list/points?elems=&lat=&lng=&us=1
     响应 data.values 二维：第一维时间、第二维要素（单点）；
     多点查询（lat/lng 为数组）时 data.lat/lng 为数组，values 为 [点][时间][要素]。
     data.elems 标明第二维要素顺序；data.timeSeries 为 yyyyMMddHHmm 时间标签。
     单位换算：RAIN 加 us=1 已是 mm；PS 原始 Pa → ÷100 转 hPa。
     ============================================================ */
    var MOJICB_ELEM_MAP = {
        WEATHER: { s: 4, conv: function (v) { return String(v); } },
        TT2: { s: 19, conv: function (v) { return +(+v).toFixed(1); } },
        WS: { s: 5, conv: function (v) { return +(+v).toFixed(1); } },
        RAIN: { s: 12, conv: function (v) { return +(+v).toFixed(2); } },
        SNOW: { s: 12, conv: function (v) { return +(+v).toFixed(2); } },
        PS: { s: 8, conv: function (v) { return +(+v / 100).toFixed(1); } },
    };

    /* 一行墨迹要素值 → cmiss station 数组（s[0]站号/s[1]lng/s[2]lat/.../s[27]站名） */
    function _mojicbRowToStation(lat, lng, row, elemIndex) {
        var s = new Array(28).fill(9999);
        s[0] = "mj_" + (+lat).toFixed(3) + "_" + (+lng).toFixed(3);
        s[1] = +lng;
        s[2] = +lat;
        for (var elem in MOJICB_ELEM_MAP) {
            var idx = elemIndex[elem];
            if (idx === undefined || idx >= row.length) continue;
            var raw = row[idx];
            if (raw === null || raw === undefined || raw === "" || isNaN(raw))
                continue;
            s[MOJICB_ELEM_MAP[elem].s] = MOJICB_ELEM_MAP[elem].conv(raw);
        }
        s[27] = (+lat).toFixed(2) + "," + (+lng).toFixed(2);
        return s;
    }

    /* yyyyMMddHHmm → "MM月dd日 HH:mm" */
    function _mojicbTimeLabel(ts) {
        if (!ts || String(ts).length < 12) return ts || "";
        ts = String(ts);
        return (
            ts.substr(4, 2) +
            "月" +
            ts.substr(6, 2) +
            "日 " +
            ts.substr(8, 2) +
            ":" +
            ts.substr(10, 2)
        );
    }

    /* 墨迹 data → { timeLabels, perTimeContours }
       单点：data.lat/lng 为数值，values[t] = [要素...]
       多点：data.lat/lng 为数组，values[p][t] = [要素...] */
    function adaptMojicbData(data) {
        if (!data || !Array.isArray(data.values) || !data.elems) return null;
        var elemIndex = {};
        data.elems.forEach(function (e, i) {
            elemIndex[e] = i;
        });

        var multi = Array.isArray(data.lat);
        var pts = multi
            ? data.lat.map(function (la, i) {
                  return { lat: la, lng: data.lng[i] };
              })
            : [{ lat: data.lat, lng: data.lng }];

        var values = data.values;
        var nTime = multi
            ? values[0]
                ? values[0].length
                : 0
            : values.length;
        var perTime = [];
        for (var t = 0; t < nTime; t++) {
            var stations = [];
            for (var p = 0; p < pts.length; p++) {
                var row = multi ? values[p][t] : values[t];
                if (!Array.isArray(row)) continue;
                stations.push(
                    _mojicbRowToStation(pts[p].lat, pts[p].lng, row, elemIndex),
                );
            }
            perTime.push(stations);
        }
        return {
            timeLabels: (data.timeSeries || []).map(_mojicbTimeLabel),
            perTimeContours: perTime,
        };
    }

    function fetchAllRealData(callbacks) {
        callbacks = callbacks || {};
        return Promise.all([
            fetch(APIs.CMISS)
                .then(function (r) {
                    return r.json();
                })
                .catch(function () {
                    return null;
                }),
            fetch(APIs.GEO_BOUNDS)
                .then(function (r) {
                    return r.json();
                })
                .catch(function () {
                    return null;
                }),
        ])
            .then(function (results) {
                cacheData.cmiss = results[0];
                var resGeo = results[1];


                /* 由 cmiss.data(数组) 重建时序 + 默认定位到当前时间最近步 */
                rebuildTimeSeries();
                currentTimeIndex = findNearestStepIndex(new Date());

                if (resGeo && resGeo.features) {
                    var rings = [];
                    resGeo.features.forEach(function (f) {
                        var geom = f.geometry,
                            coordsList =
                                geom.type === "Polygon"
                                    ? [geom.coordinates]
                                    : geom.coordinates;
                        coordsList.forEach(function (polygon) {
                            var subRings = Array.isArray(polygon[0][0])
                                ? polygon
                                : [polygon];
                            subRings.forEach(function (ring) {
                                if (ring.length >= 3) rings.push(ring);
                            });
                        });
                    });
                    cacheData.maskRings = rings;
                    qinghaiPolygons = rings;

                    L.geoJSON(resGeo, {
                        pane: "bordersPane",
                        style: { fillOpacity: 0, color: "#9ca3af", weight: 2 },
                    }).addTo(map);
                    if (resGeo.features.length > 0) {
                        map.fitBounds(L.geoJSON(resGeo).getBounds(), {
                            padding: [60, 60],
                            animate: false,
                        });
                        applyTrueTransparentMask();
                    }
                }

                if (typeof callbacks.onLoad === "function") callbacks.onLoad();
                return api;
            })
            .catch(function (err) {
                if (typeof callbacks.onError === "function")
                    callbacks.onError("数据拉取失败！");
                throw err;
            });
    }

    /* 由 cacheData.cmiss.data(数组) 重建时序：timeSeriesCmiss / timeSteps / timeStepDates */
    function rebuildTimeSeries() {
        cacheData.timeSeriesCmiss = [];
        timeSteps = [];
        cacheData.timeStepDates = [];
        if (cacheData.cmiss && Array.isArray(cacheData.cmiss.data)) {
            cacheData.cmiss.data.forEach(function (item) {
                cacheData.timeSeriesCmiss.push(item.contours || []);
                timeSteps.push(formatStepDate(item.date));
                cacheData.timeStepDates.push(stepDateToDate(item.date));
            });
        }
    }

    /* 清除所有已激活图层的缓存，迫使下次 toggleLayer 用新数据重建 */
    function clearActiveLayers() {
        Object.keys(mapLayersCache).forEach(function (type) {
            var layer = mapLayersCache[type];
            if (layer && map._layers[layer._leaflet_id]) {
                map.removeLayer(layer);
            }
            delete mapLayersCache[type];
        });
    }

    /* 刷新 cmiss 数据：重新拉取 cmiss.json → 重建时序 → 重置到当前时间最近步 → 清激活图层缓存。
       index.js 在 onLoad 里重新 toggleLayer(currentTab) + 更新时间轴即可刷新视图。 */
    function refreshCmissData(callbacks) {
        callbacks = callbacks || {};
        return fetch(APIs.CMISS)
            .then(function (r) {
                return r.json();
            })
            .catch(function () {
                return null;
            })
            .then(function (cmiss) {
                if (!cmiss) {
                    if (typeof callbacks.onError === "function")
                        callbacks.onError("cmiss 数据加载失败");
                    return api;
                }
                cacheData.cmiss = cmiss;
                rebuildTimeSeries();
                clearFrameCache(); /* 原始数据已变，清掉所有图层帧缓存 */
                currentTimeIndex = findNearestStepIndex(new Date());
                clearActiveLayers();
                if (typeof callbacks.onLoad === "function") callbacks.onLoad();
                return api;
            });
    }

    /* date → 播放标签：date 为时间戳（毫秒数值或可解析字符串） */
    function pad2(n) {
        n = +n;
        return (n < 10 ? "0" : "") + n;
    }
    function formatStepDate(date) {
        if (date == null) return "";
        var d = new Date(date);
        if (isNaN(d.getTime())) return String(date);
        return (
            pad2(d.getMonth() + 1) +
            "月" +
            pad2(d.getDate()) +
            "日 " +
            pad2(d.getHours()) +
            ":" +
            pad2(d.getMinutes())
        );
    }
    /* date → Date 对象（时间戳数值或可解析字符串，用于按时间就近匹配） */
    function stepDateToDate(date) {
        if (date == null) return null;
        var d = new Date(date);
        return isNaN(d.getTime()) ? null : d;
    }
    /* 在时间步中找到与 targetDate 绝对时间差最小的索引 */
    function findNearestStepIndex(targetDate) {
        var dates = cacheData.timeStepDates;
        if (!dates || !dates.length || !(targetDate instanceof Date)) return 0;
        var best = 0,
            bestDiff = Infinity;
        for (var i = 0; i < dates.length; i++) {
            if (!dates[i]) continue;
            var diff = Math.abs(dates[i].getTime() - targetDate.getTime());
            if (diff < bestDiff) {
                bestDiff = diff;
                best = i;
            }
        }
        return best;
    }

    var _onTimeChange = null;
    function notifyTimeChange(progress) {
        if (typeof _onTimeChange === "function")
            _onTimeChange({
                timeIndex: currentTimeIndex,
                timeLabel: timeSteps[currentTimeIndex],
                isPlaying: isPlaying,
                totalSteps: timeSteps.length,
                /* 连续进度 0~1（播放中随插值 t 平滑推进，供进度条像视频一样流动）；
                   非 number 时为 null，前端回退用 timeIndex 按整数步对齐 */
                progress: typeof progress === "number" ? progress : null,
            });
    }

    /* ============================================================
       播放帧缓存与插值渲染
       -----------------------------------------------------------
       旧实现每帧重算 IDW 全网格(computeFloatGrid)→ 阻塞粒子动画，被迫
       退化为"硬切换"，画面一帧一帧跳。新实现把每个时间步的 IDW 结果预算
       成 RGBA 像素快照缓存，播放时仅在相邻两帧间做像素级线性插值，
       单帧仅 ~45 万次浮点运算(<5ms)，可跑满 60fps，且不再阻塞雨雪粒子。
       ============================================================ */

    /* 图层类型 → 色带/插值类型（与 buildWeatherLayer 里 createPerformanceIdwLayer
       传入的 type 保持一致：wind→windSpeed、isobar→pressure） */
    function resolveMeteoType(type) {
        if (type === "wind" || type === "windSpeed") return "windSpeed";
        if (type === "isobar") return "pressure";
        return type;
    }

    /* 取某时间步某图层的散点（风场走站点风速点，其余走 cmiss 要素提取） */
    function getLayerPointsAt(type, timeIndex) {
        if (type === "wind" || type === "windSpeed") {
            var built = buildStationWindField(extractWindStations(timeIndex));
            return built ? built.speed : [];
        }
        var contours = cacheData.timeSeriesCmiss[timeIndex] || [];
        return extractPointsFromContours(type, contours);
    }

    /* 单步 IDW → RGBA 像素快照（与 updateCanvasOverlay 同口径：cols=400） */
    function computeFrameRGBA(type, timeIndex) {
        var resolveType = resolveMeteoType(type);
        var bounds = L.latLngBounds(MAP_CONFIG.bounds);
        var west = bounds.getWest(),
            east = bounds.getEast(),
            south = bounds.getSouth(),
            north = bounds.getNorth();
        var cols = 240;
        var rows = Math.ceil(cols * ((north - south) / (east - west)));
        var points = getLayerPointsAt(type, timeIndex);
        var gridData = computeFloatGrid(
            points,
            resolveType,
            cols,
            rows,
            west,
            east,
            south,
            north,
        );
        var grid = gridData.grid;
        var rgba = new Uint8ClampedArray(cols * rows * 4);
        for (var i = 0, n = cols * rows; i < n; i++) {
            var c = getIdwColor(resolveType, grid[i]);
            rgba[i * 4] = c.r;
            rgba[i * 4 + 1] = c.g;
            rgba[i * 4 + 2] = c.b;
            rgba[i * 4 + 3] = c.a;
        }
        return { rgba: rgba, cols: cols, rows: rows, resolveType: resolveType };
    }

    /* 懒加载缓存：首次取某帧时计算并入缓存，后续直接命中 */
    function getCachedFrame(type, timeIndex) {
        if (!frameCache[type]) frameCache[type] = { frames: {} };
        var slot = frameCache[type];
        if (!slot.frames[timeIndex]) {
            var f = computeFrameRGBA(type, timeIndex);
            slot.cols = f.cols;
            slot.rows = f.rows;
            slot.resolveType = f.resolveType;
            slot.frames[timeIndex] = f.rgba;
        }
        return slot;
    }

    function clearFrameCache(type) {
        if (type == null) frameCache = {};
        else delete frameCache[type];
    }

    /* 滑动窗口清理：丢弃远离当前播放位置的帧缓存，避免长时间播放(几百上千步)
       时 frameCache 无限堆积吃满内存。保留当前位置 ±3 帧。 */
    function trimFrameCache(type, centerIdx) {
        var slot = frameCache[type];
        if (!slot) return;
        Object.keys(slot.frames).forEach(function (k) {
            var ki = +k;
            if (ki < centerIdx - 3 || ki > centerIdx + 3) {
                delete slot.frames[k];
            }
        });
    }

    /* 当前已激活的互斥图层类型（无则 null） */
    function getActiveLayerType() {
        var active = null;
        MUTEX_TYPES.forEach(function (type) {
            var layer = mapLayersCache[type];
            if (layer && map._layers[layer._leaflet_id]) active = type;
        });
        return active;
    }

    /* 把 fromIdx→toIdx 按 t∈[0,1] 做像素级插值，绘到热力层 canvas。
       fromIdx===toIdx 时即落单帧。 */
    function renderBlendedFrame(type, fromIdx, toIdx, t) {
        var layer = mapLayersCache[type];
        if (!layer) return;
        var heatLayer = layer.heatLayer ? layer.heatLayer : layer;
        var canvas = heatLayer._canvas;
        if (!canvas) return;

        var slot = getCachedFrame(type, fromIdx);
        if (!slot.frames[toIdx]) getCachedFrame(type, toIdx);
        var from = slot.frames[fromIdx];
        var to = slot.frames[toIdx];
        var cols = slot.cols,
            rows = slot.rows;

        if (canvas.width !== cols) { canvas.width = cols; _blendImgData = null; }
        if (canvas.height !== rows) { canvas.height = rows; _blendImgData = null; }

        var ctx = canvas.getContext("2d");
        if (!_blendImgData || _blendImgData.width !== cols || _blendImgData.height !== rows) {
            _blendImgData = ctx.createImageData(cols, rows);
        }
        var data = _blendImgData.data;
        /* 降水/降雪为"有/无"二值场（alpha 仅 0 或 255）：边界处若线性插值 alpha，
           叠加 multiply 混合会产生明显的半透明暗化阴影。故这类图层在边界采用
           阈值切换（t<0.5 取 from，否则取 to），杜绝半透明 → 无阴影；
           内部(两端同有/同无降水)仍做颜色渐变。其余图层走逐通道线性插值。 */
        var binaryAlpha = type === "rain" || type === "snow";
        if (t <= 0) {
            data.set(from);
        } else if (t >= 1) {
            data.set(to);
        } else if (!binaryAlpha) {
            /* 整体匀速渐变：所有像素同步从 from 线性过渡到 to（无方向性光波） */
            for (var i = 0, n = data.length; i < n; i++) {
                data[i] = from[i] + (to[i] - from[i]) * t;
            }
        } else {
            var useFrom = t < 0.5;
            for (var p = 0, np = data.length; p < np; p += 4) {
                var fa = from[p + 3],
                    ta = to[p + 3];
                if ((fa === 0) !== (ta === 0)) {
                    /* 边界：阈值切换，杜绝半透明阴影 */
                    if (useFrom) {
                        data[p] = from[p];
                        data[p + 1] = from[p + 1];
                        data[p + 2] = from[p + 2];
                        data[p + 3] = fa;
                    } else {
                        data[p] = to[p];
                        data[p + 1] = to[p + 1];
                        data[p + 2] = to[p + 2];
                        data[p + 3] = ta;
                    }
                } else {
                    data[p] = from[p] + (to[p] - from[p]) * t;
                    data[p + 1] = from[p + 1] + (to[p + 1] - from[p + 1]) * t;
                    data[p + 2] = from[p + 2] + (to[p + 2] - from[p + 2]) * t;
                    data[p + 3] = fa + (ta - fa) * t;
                }
            }
        }
        ctx.putImageData(_blendImgData, 0, 0);
    }

    /* 过渡期间把下一时间步的等压线整块算好并预渲染到每块 tile canvas，存到 _nextTiles。
       关键：预渲染分片用 requestIdleCallback 只在每帧渲染完的空闲时段跑，绝不挤占
       playLoop 的 RAF，色带与进度条不受影响。全部预渲染完才置 _nextReady=true，中点
       只在就绪时 drawImage(零重算)；没就绪就跳过本次切换，绝不回退重算，保证不卡。 */
    function precomputeContourNext(type, idx) {
        var layer = mapLayersCache[type];
        if (!layer || !layer.contourLayer) return;
        var cl = layer.contourLayer;
        var bounds = L.latLngBounds(MAP_CONFIG.bounds);
        var cols = 150,
            rows = Math.ceil(
                cols *
                    ((bounds.getNorth() - bounds.getSouth()) /
                        (bounds.getEast() - bounds.getWest())),
            );
        var tiles = cl._tiles;
        var keys = Object.keys(tiles).filter(function (k) {
            return tiles[k].current && tiles[k].coords;
        });
        if (!keys.length) return;
        /* requestIdleCallback：帧末空闲时执行（200ms 内必触发，避免被饿死）；回退 setTimeout */
        var ric = window.requestIdleCallback
            ? function (cb) {
                  return window.requestIdleCallback(cb, { timeout: 200 });
              }
            : function (cb) {
                  return setTimeout(cb, 0);
              };
        setTimeout(function () {
            if (mapLayersCache[type] !== layer) return; /* 图层已切走则放弃 */
            /* 1) 算 b 的气压 IDW */
            var gData = computeFloatGrid(
                getLayerPointsAt(type, idx),
                "isobar",
                cols,
                rows,
                bounds.getWest(),
                bounds.getEast(),
                bounds.getSouth(),
                bounds.getNorth(),
            );
            /* 2) 临时挂 gData，帧末空闲分片预渲染每块 tile */
            var prevGlobal = cl.globalData;
            cl.globalData = gData;
            cl._nextGlobal = gData;
            cl._nextTiles = {};
            cl._nextReady = false;
            var i = 0;
            (function renderNext() {
                if (i >= keys.length) {
                    cl.globalData = prevGlobal; /* 恢复当前显示用的 globalData */
                    cl._nextReady = true; /* 全部就绪，中点可 drawImage */
                    return;
                }
                var key = keys[i];
                var entry = tiles[key];
                if (entry && entry.coords) {
                    cl._nextTiles[key] = cl.createTile(entry.coords);
                }
                i++;
                if (mapLayersCache[type] !== layer) return; /* 切走则中止 */
                ric(renderNext); /* 下一帧末空闲继续 */
            })();
        }, 0);
    }

    /* 等压线无法像素插值，只能按时间步切换。中点时若过渡期间预渲染已完整就绪
       (_nextReady)则直接 drawImage(零重算)；没就绪则跳过本次切换(等压线延一步再切)，
       绝不回退重算以免卡。用 lastHalf 去重，避免每帧重复刷新。 */
    function syncSubLayers(type, state, t) {
        var half = t >= 0.5;
        if (half === state.lastHalf) return;
        state.lastHalf = half;
        if (!half) return; /* 仅 t 跨过中点(向上)时切到 toIdx */
        var layer = mapLayersCache[type];
        if (!layer || !layer.contourLayer) return;
        if (!layer.contourLayer._nextReady) return; /* 预渲染没就绪则跳过，不回退重算 */
        var idx = state.toIdx;
        var cl = layer.contourLayer;
        cl.points = getLayerPointsAt(type, idx);
        /* 复用过渡期间预渲染的 tile canvas，只 drawImage（纯拷贝，~1ms） */
        cl.globalData = cl._nextGlobal;
        var nt = cl._nextTiles;
        var tiles = cl._tiles;
        Object.keys(tiles).forEach(function (key) {
            var entry = tiles[key];
            if (!entry.current || !entry.coords) return;
            if (nt[key] && entry.el && entry.el.getContext) {
                var ctx = entry.el.getContext("2d");
                ctx.clearRect(0, 0, entry.el.width, entry.el.height);
                ctx.drawImage(nt[key], 0, 0);
            }
        });
        cl._nextTiles = null;
        cl._nextGlobal = null;
        cl._nextReady = false;
    }

    /* 渲染单个时间步（slider 拖动/停止播放时用；缓存命中，极快） */
    function renderSingleFrame(type, idx) {
        if (!type) return;
        var layer = mapLayersCache[type];
        if (!layer) return;
        renderBlendedFrame(type, idx, idx, 1);
        var pts = getLayerPointsAt(type, idx);
        if (layer.points) layer.points = pts;
        var heatLayer = layer.heatLayer ? layer.heatLayer : layer;
        if (heatLayer.points) heatLayer.points = pts;
        if (layer.contourLayer) {
            layer.contourLayer.points = pts;
            if (layer.contourLayer.smoothRedraw) layer.contourLayer.smoothRedraw();
        }
        if (layer.rainFx) layer.rainFx.setData(pts);
        if (layer.snowFx) layer.snowFx.setData(pts);
        if ((type === "wind" || type === "windSpeed") && globalVelLayer) {
            var built = buildStationWindField(extractWindStations(idx));
            if (built) {
                cacheData.gfs = built.uv;
                globalVelLayer._data = built.uv;
            }
        }
    }

    function renderCurrentTimeStep() {
        var activeType = getActiveLayerType();
        if (!activeType) return;
        renderSingleFrame(activeType, currentTimeIndex);
    }

    /* 播放期间隐藏雨/雪/风粒子（它们随时间步难以平滑过渡，与色带流动叠加会显得杂乱），
       播放结束/暂停后恢复。
       雨雪粒子：cancel raf 停止计算 + 隐藏 canvas（不重置粒子位置，省 CPU）；
       风场流线（leaflet-velocity）：隐藏其 _canvas 即视觉消失。 */
    function setParticleFxVisible(visible) {
        ["rain", "snow"].forEach(function (type) {
            var layer = mapLayersCache[type];
            if (!layer || !map._layers[layer._leaflet_id]) return;
            var fx = type === "rain" ? layer.rainFx : layer.snowFx;
            if (!fx) return;
            if (visible) {
                if (fx._canvas) fx._canvas.style.display = "";
                if (!fx._raf && typeof fx._animate === "function") fx._animate();
            } else {
                if (fx._raf) {
                    cancelAnimationFrame(fx._raf);
                    fx._raf = null;
                }
                if (fx._canvas) fx._canvas.style.display = "none";
            }
        });
        /* 风场流线（leaflet-velocity）：粒子 canvas 在 _canvasLayer._canvas；
           粒子动画循环在 Windy 闭包内（变量 c），靠 _windy.stop() 真正 cancel 掉，
           并清掉 onDrawLayer 排的 750ms 重启 timer，否则会被自动拉起。
           仅隐藏 canvas 不够——循环仍在后台跑、和热力插值抢 CPU，导致风速图层卡。 */
        if (globalVelLayer && globalVelLayer._canvasLayer) {
            var vc = globalVelLayer._canvasLayer._canvas;
            if (visible) {
                if (vc) vc.style.display = "";
                if (globalVelLayer._windy && globalVelLayer._clearAndRestart) {
                    globalVelLayer._clearAndRestart(); /* 清屏 + 重启粒子循环 */
                }
            } else {
                if (globalVelLayer._timer) {
                    clearTimeout(globalVelLayer._timer);
                    globalVelLayer._timer = null;
                }
                if (globalVelLayer._windy && globalVelLayer._windy.stop) {
                    globalVelLayer._windy.stop(); /* cancel 粒子 RAF 循环 */
                }
                if (vc) vc.style.display = "none";
            }
        }
    }

    function pausePlayback() {
        isPlaying = false;
        if (playbackRaf) {
            cancelAnimationFrame(playbackRaf);
            playbackRaf = null;
        }
        if (playbackTimer) {
            clearInterval(playbackTimer);
            playbackTimer = null;
        }
        playState = null;
        /* 停止时把当前真实时间步渲染到位（缓存命中，极快） */
        renderSingleFrame(getActiveLayerType(), currentTimeIndex);
        setParticleFxVisible(true); /* 恢复雨/雪/风粒子 */
        notifyTimeChange();
    }

    function playLoop() {
        if (!isPlaying) return;
        var now = performance.now();
        var t = Math.min(1, (now - playState.stepStart) / PLAY_STEP_MS);
        var activeType = getActiveLayerType();
        if (activeType) {
            renderBlendedFrame(activeType, playState.fromIdx, playState.toIdx, t);
            syncSubLayers(activeType, playState, t);
        }
        /* 连续进度（进度条平滑向前）：currentTimeIndex + t 占满一步的比例 */
        var progress =
            timeSteps.length > 1
                ? (currentTimeIndex + t) / (timeSteps.length - 1)
                : 0;
        notifyTimeChange(progress);
        if (t >= 1) {
            currentTimeIndex = playState.toIdx;
            /* 播放到末尾自动暂停（再点播放则从头开始） */
            if (currentTimeIndex >= timeSteps.length - 1) {
                pausePlayback();
                return;
            }
            playState.fromIdx = currentTimeIndex;
            playState.toIdx = currentTimeIndex + 1;
            playState.stepStart = now;
            playState.lastHalf = false;
            /* 滑动窗口：异步预算下一帧(过渡期间空闲算完，不阻塞切换)，
               并清理远离当前位置的旧帧，避免长时间播放 frameCache 堆积吃满内存。 */
            if (activeType) {
                var preT = activeType,
                    preI = playState.toIdx;
                setTimeout(function () {
                    if (isPlaying && preI < timeSteps.length)
                        getCachedFrame(preT, preI);
                }, 0);
                trimFrameCache(activeType, currentTimeIndex);
            }
            /* 进入新的 a→b 过渡：期间提前预算 b 的等压线 IDW，中点切换时复用 */
            precomputeContourNext(activeType, playState.toIdx);
        }
        playbackRaf = requestAnimationFrame(playLoop);
    }

    function startPlayback() {
        if (timeSteps.length <= 1) return;
        /* 已在末尾时从头开始 */
        if (currentTimeIndex >= timeSteps.length - 1) {
            currentTimeIndex = 0;
            renderCurrentTimeStep();
        }
        isPlaying = true;
        setParticleFxVisible(false); /* 播放期间隐藏雨/雪/风粒子 */
        notifyTimeChange();
        var activeType = getActiveLayerType();
        if (activeType) {
            /* 滑动窗口：只预算当前帧 + 下一帧，够开始插值即可。
               绝不全量预算——时间步多时(几百上千)会阻塞主线程几十秒导致卡死。 */
            getCachedFrame(activeType, currentTimeIndex);
            if (currentTimeIndex + 1 < timeSteps.length)
                getCachedFrame(activeType, currentTimeIndex + 1);
        }
        /* 第一次过渡也提前预算等压线 IDW */
        precomputeContourNext(
            activeType,
            Math.min(currentTimeIndex + 1, timeSteps.length - 1),
        );
        playState = {
            fromIdx: currentTimeIndex,
            toIdx: Math.min(currentTimeIndex + 1, timeSteps.length - 1),
            stepStart: performance.now(),
            lastHalf: false,
        };
        if (playbackTimer) {
            clearInterval(playbackTimer);
            playbackTimer = null;
        }
        playbackRaf = requestAnimationFrame(playLoop);
    }

    function togglePlayback() {
        isPlaying ? pausePlayback() : startPlayback();
    }
    function onSliderChange(val) {
        currentTimeIndex = parseInt(val, 10);
        notifyTimeChange();
        renderCurrentTimeStep();
    }

    /* 核心接口与初始化 */
    var api = {
        map: null,
        get timeSteps() {
            return timeSteps;
        },
        MAP_CONFIG: MAP_CONFIG,
        METEO_CONFIG: METEO_CONFIG,
        WEATHER_ICON_CODEX: WEATHER_ICON_CODEX,
        get currentTimeIndex() {
            return currentTimeIndex;
        },
        get isPlaying() {
            return isPlaying;
        },
        init: null,
        toggleLayer: null,
        fetchAllRealData: null,
        togglePlayback: null,
        onSliderChange: null,
        /* 墨迹 EC1x1 响应 → cmiss contours 适配（纯数据结构转换工具，供后端数据接入时调用） */
        adaptMojicbData: adaptMojicbData,
        /* 重新拉取 cmiss 并重建时序/清缓存；onLoad 后需重新 toggleLayer + 更新时间轴 */
        refreshCmissData: refreshCmissData,
        /* 注入固定场站配置并渲染场站图层（常驻显示，不随气象图层互斥移除） */
        setStationConfig: function (list) {
            stationConfig = Array.isArray(list) ? list : [];
            refreshStationLayer();
            return api;
        },
        /* 按分组(地区/公司)批量高亮场站；传 null/undefined 等同于清除高亮 */
        highlightStations: function (group) {
            currentHighlight = group == null ? null : String(group);
            applyHighlight();
            return api;
        },
        /* 清除场站高亮，全部恢复正常态 */
        clearStationHighlight: function () {
            currentHighlight = null;
            applyHighlight();
            return api;
        },
    };

    function init(container) {
        map = L.map(container, {
            center: MAP_CONFIG.center,
            zoom: 6,
            minZoom: 4,
            maxZoom: 12,
            zoomSnap: 0,
            zoomDelta: 0.5,
            zoomControl: true,
            dragging: true,
            scrollWheelZoom: true,
            attributionControl: false,
        });

        map.createPane("baseImagePane");
        map.getPane("baseImagePane").style.zIndex = 100;
        map.getPane("baseImagePane").style.pointerEvents = "none";
        map.createPane("heatPane");
        map.getPane("heatPane").style.zIndex = 200;
        map.getPane("heatPane").style.pointerEvents = "none";
        map.createPane("bordersPane");
        map.getPane("bordersPane").style.zIndex = 300;
        map.getPane("bordersPane").style.pointerEvents = "none";
        /* 场站专用 pane：层级高于 markerPane(600)/popupPane(700)，保证场站盖在
           所有气象图层与气象站点图标之上。容器穿透点击，场站本体单独开启点击。 */
        map.createPane("stationPane");
        map.getPane("stationPane").style.zIndex = 800;
        map.getPane("stationPane").style.pointerEvents = "none";

        L.imageOverlay(MAP_CONFIG.url, MAP_CONFIG.bounds, {
            pane: "baseImagePane",
            opacity: 1.0,
        }).addTo(map);

        window.addEventListener("resize", function () {
            map.invalidateSize();
            if (cacheData.maskRings.length > 0) applyTrueTransparentMask();
        });
        map.on("zoomend moveend", function () {
            if (cacheData.maskRings.length > 0) applyTrueTransparentMask();
        });

        api.toggleLayer = toggleLayer;
        api.fetchAllRealData = fetchAllRealData;
        api.togglePlayback = togglePlayback;
        api.onSliderChange = onSliderChange;
        Object.defineProperty(api, "onTimeChange", {
            get: function () {
                return _onTimeChange;
            },
            set: function (fn) {
                _onTimeChange = typeof fn === "function" ? fn : null;
            },
        });

        bindMapPopup();
        return api;
    }

    api.init = init;
    return api;
})();
