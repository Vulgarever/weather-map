/**
 * WeatherMap 气象地图核心模块
 * 搭载高颜值气象色带引擎 & 全局 Canvas 粒子动画引擎 (无痛解耦复合风场)
 * 【已集成：光流法平流变形 (Optical Flow Advection) 物理流动引擎】
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

    /* 播放帧缓存：为每个 (图层类型, 时间步) 预计算 IDW 热力网格的 RGBA 像素快照。 */
    var frameCache = {}; // { [type]: { cols, rows, resolveType, frames: { [idx]: {rgba, grid} } } }
    var _blendImgData = null; // 复用的 ImageData，避免每帧 createImageData 的开销
    var playbackRaf = null; // requestAnimationFrame 句柄
    var playState = null; // { fromIdx, toIdx, stepStart, lastHalf }
    var PLAY_STEP_MS = 2000; // 单个时间步的插值过渡时长（ms）【优化：延长至2秒，过渡变化清晰可见】
    /* 连续场（温度/湿度/气压/风/辐射/云量）光流位移放大倍数：
       这些场时间变化平缓、缺乏降水降雪那种清晰团块边界，光流位移信号天然偏弱，
       需放大 shift 才能让气团推移在视觉上可见。降水降雪固定 1.0 不受影响。 */
    var ADV_SHIFT_SCALE = 2.8; // 【优化：从1.0提升至2.8，连续场锋面推移感大幅增强】
    /* 梯度门控参考值：连续场光流位移按 空间梯度/(梯度+此值) 软门控——
       锋面/边界（梯度大）放大位移产生推移感，平坦区（梯度小）位移趋近 0 不变形，
       避免变形采样把邻近区域的值拉进来、在 a→b 之外产生多余的中间色。 */
    var ADV_GRAD_REF = 0.10; // 【优化：从0.3降至0.10，更多区域感受到光流位移，变化感更强】

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
     【全面优化-针对青海浅蓝色调底图】渲染模式已改为 Normal叠加(opacity 0.82)，
     各要素颜色值重新设计：① 加入 a 通道（无值透明、有值饱和）② 气压收窄至高原范围
     ③ 降水值域调整为青海实际量级 ④ 降雪加深基础色 ⑤ 温度扩展至-30℃
     ============================================================ */
    var METEO_CONFIG = {
        temp: {
            min: -30,
            max: 40,
            // 【青海特化】扩展至-30℃覆盖高原极寒；Normal叠加模式各节点赋予透明度让底图纹理隐约可见
            colors: [
                { val: -30, r: 22,  g: 0,   b: 105, a: 235, hex: "rgba(22,0,105,0.92)" },    // 极寒深蓝紫
                { val: -20, r: 49,  g: 25,  b: 155, a: 225, hex: "rgba(49,25,155,0.88)" },   // 严寒紫蓝
                { val: -10, r: 22,  g: 85,  b: 195, a: 215, hex: "rgba(22,85,195,0.84)" },   // 藏青蓝
                { val: 0,   r: 55,  g: 172, b: 125, a: 205, hex: "rgba(55,172,125,0.80)" },  // 0度线青绿
                { val: 10,  r: 148, g: 212, b: 88,  a: 205, hex: "rgba(148,212,88,0.80)" },  // 浅草绿
                { val: 20,  r: 255, g: 242, b: 70,  a: 218, hex: "rgba(255,242,70,0.85)" },  // 暖黄
                { val: 30,  r: 255, g: 152, b: 18,  a: 238, hex: "rgba(255,152,18,0.93)" },  // 橙热
                { val: 40,  r: 218, g: 15,  b: 18,  a: 255, hex: "#da0f12" },                // 高温深红
            ],
        },
        rain: {
            min: 0.1,
            max: 50,
            // 【青海特化】值域收窄至50mm（青海日降水极少超50mm，缩小量级让颜色分级更精细）
            // 保留CMA标准色系：浅绿→绿→黄→橙红→红，各节点加 a 通道强化对比
            colors: [
                { val: 0.1, r: 166, g: 242, b: 143, a: 155, hex: "rgba(166,242,143,0.61)" }, // 微雨（半透明浅绿）
                { val: 5,   r: 50,  g: 195, b: 55,  a: 195, hex: "rgba(50,195,55,0.76)" },   // 小雨（绿）
                { val: 15,  r: 255, g: 245, b: 0,   a: 220, hex: "rgba(255,245,0,0.86)" },   // 大雨（黄金预警色）
                { val: 30,  r: 255, g: 80,  b: 0,   a: 238, hex: "rgba(255,80,0,0.93)" },    // 暴雨（橙红预警色）
                { val: 50,  r: 255, g: 0,   b: 0,   a: 255, hex: "#ff0000" },                // 大暴雨（红色极值）
            ],
        },
        snow: {
            min: 0.1,
            max: 30,
            // 【符合标准】气象业务中，为与降雨区分，降雪（特别是双极化雷达或降水相态图）通用“灰紫-亮紫”色系。
            // 完美避开了底图的白色和浅蓝色。
            colors: [
                { val: 0.1, r: 212, g: 185, b: 218, hex: "#d4b9da" }, // 零星小雪 (浅灰紫)
                { val: 2.5, r: 201, g: 148, b: 199, hex: "#c994c7" }, // 小雪
                { val: 5.0, r: 223, g: 101, b: 176, hex: "#df65b0" }, // 中雪 (洋红)
                { val: 10, r: 221, g: 28, b: 119, hex: "#dd1c77" },   // 大雪 
                { val: 20, r: 152, g: 0, b: 67, hex: "#980043" },     // 暴雪 (紫红)
                { val: 30, r: 73, g: 0, b: 106, hex: "#49006a" },     // 特大暴雪 (极深紫)
            ],
        },
        windSpeed: {
            min: 0,
            max: 30,
            // 【青海特化】高原风大(3-6级为常态)；低风速端半透明可见，强风端颜色深而饱和
            colors: [
                { val: 0,  r: 110, g: 210, b: 110, a: 0,   hex: "rgba(110,210,110,0)" },    // 0风速完全透明
                { val: 2,  r: 110, g: 210, b: 110, a: 175, hex: "rgba(110,210,110,0.69)" }, // 微风（青绿半透明）
                { val: 5,  r: 75,  g: 188, b: 148, a: 205, hex: "rgba(75,188,148,0.80)" },  // 3级风（深青）
                { val: 10, r: 255, g: 228, b: 0,   a: 222, hex: "rgba(255,228,0,0.87)" },   // 5级风（亮黄）
                { val: 15, r: 255, g: 155, b: 22,  a: 238, hex: "rgba(255,155,22,0.93)" },  // 7级风（橙色）
                { val: 20, r: 238, g: 75,  b: 48,  a: 248, hex: "rgba(238,75,48,0.97)" },   // 8级风（橘红）
                { val: 25, r: 195, g: 22,  b: 58,  a: 255, hex: "#c3163a" },                // 10级风（大红）
                { val: 30, r: 118, g: 0,   b: 28,  a: 255, hex: "#76001c" },                // 狂风（黑红）
            ],
        },
        pressure: {
            min: 500,
            max: 1000,
            // 【符合标准】气象等压面/高度场经典的“光谱渐变色 (Spectral)”，代表从低空到高空的梯度。
            // 采用深紫(低压)->蓝绿->黄->红(高压)的经典色阶。
            colors: [
                { val: 500, r: 94, g: 79, b: 162, hex: "#5e4fa2" },   // 低压 (深紫)
                { val: 600, r: 50, g: 136, b: 189, hex: "#3288bd" },  // (深蓝)
                { val: 700, r: 102, g: 194, b: 165, hex: "#66c2a5" }, // (蓝绿)
                { val: 800, r: 230, g: 245, b: 152, hex: "#e6f598" }, // (黄绿)
                { val: 900, r: 253, g: 174, b: 97, hex: "#fdae61" },  // (橙)
                { val: 1000, r: 213, g: 62, b: 79, hex: "#d53e4f" },  // 高压 (深红)
            ],
        },
        humidity: {
            min: 0,
            max: 100,
            // 【青海特化】青海整体偏干(年均湿度30-60%)；加深干端棕色，湿端绿色更饱和
            // BrBG配色保留，各节点加 a 通道让低值区半透明、高值区不透明
            colors: [
                { val: 0,   r: 125, g: 60,  b: 8,   a: 238, hex: "rgba(125,60,8,0.93)" },    // 极度干燥（深焦棕）
                { val: 25,  r: 205, g: 150, b: 72,  a: 218, hex: "rgba(205,150,72,0.85)" },  // 干燥（沙土黄）
                { val: 55,  r: 238, g: 218, b: 165, a: 205, hex: "rgba(238,218,165,0.80)" }, // 适宜（米白）
                { val: 75,  r: 68,  g: 162, b: 155, a: 218, hex: "rgba(68,162,155,0.85)" },  // 湿润（青绿）
                { val: 100, r: 0,   g: 88,  b: 78,  a: 238, hex: "rgba(0,88,78,0.93)" },     // 极湿（墨绿）
            ],
        },
        radiation: {
            min: 0,
            max: 1000,
            // 【符合标准】太阳辐射通常采用“热焰色”或称“黑体辐射色（Blackbody）”
            // 模拟温度不断升高的颜色变化：暗紫/黑 -> 红 -> 亮黄。
            colors: [
                { val: 0, r: 40, g: 0, b: 80, hex: "#280050" },       // 极低辐射 (夜间深紫)
                { val: 200, r: 128, g: 0, b: 38, hex: "#800026" },    // 
                { val: 400, r: 227, g: 26, b: 28, hex: "#e31a1c" },   // 中等辐射 (大红)
                { val: 600, r: 253, g: 141, b: 60, hex: "#fd8d3c" },  // 
                { val: 800, r: 254, g: 178, b: 76, hex: "#feb24c" },  // 高辐射 (亮橙)
                { val: 1000, r: 255, g: 255, b: 178, hex: "#ffffb2" },// 极高辐射 (耀眼黄白)
            ],
        },
        cloud: {
            min: 0,
            max: 100,
            // 【底图适配】Normal叠加模式下灰色云层可直接清晰显示；
            // 加深基础灰色，增强少云→密云的可见度梯度，无云区完全透明
            colors: [
                { val: 0,   r: 190, g: 190, b: 200, a: 0,   hex: "rgba(190,190,200,0)" },   // 晴空完全透明
                { val: 15,  r: 192, g: 192, b: 205, a: 130, hex: "rgba(192,192,205,0.51)" }, // 少云（浅灰半透明）
                { val: 40,  r: 135, g: 135, b: 148, a: 188, hex: "rgba(135,135,148,0.74)" }, // 多云（中灰）
                { val: 70,  r: 82,  g: 82,  b: 92,  a: 228, hex: "rgba(82,82,92,0.89)" },   // 阴天（深灰）
                { val: 100, r: 28,  g: 28,  b: 38,  a: 252, hex: "rgba(28,28,38,0.99)" },   // 密云（近黑）
            ],
        },
        isobar: {
            interval: 10, // 【优化】等压线间距从20降至10hPa，青海高原值域窄，10hPa间距线条更丰富
            lineColor: "rgba(20, 20, 20, 0.90)", // 深炭黑色，高对比
            lineWidth: 1.4,
            labelColor: "#0a0a0a",
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
        if (type === "wind" || type === "windSpeed") config = configMap["windSpeed"];
        if (type === "isobar") config = configMap["pressure"];

        if (config && config.colors) {
            var gradientStr =
                "linear-gradient(to right, " +
                config.colors.map(function (c) { return c.hex; }).join(", ") +
                ")";
            if (window.app) {
                window.app.legendTitle = titleMap[type] || "气象要素";
                window.app.legendGradient = gradientStr;
                window.app.legendLabels = config.colors.map(function (c) { return c.val; });
                window.app.showLegend = true;
            }
        }
    };

    window.WEATHER_ICON_CODEX = {
        1: "晴", 8: "多云", 13: "阴", 26: "雾", 29: "沙尘暴", 30: "浮尘", 32: "扬沙", 34: "霾",
        49: "雨夹雪", 51: "小雨", 53: "中雨", 54: "大雨", 55: "暴雨", 56: "大暴雨", 57: "特大暴雨",
        58: "小雪", 60: "中雪", 62: "大雪", 63: "暴雪",
    };
    var WEATHER_ICONS = {};
    Object.keys(WEATHER_ICON_CODEX).forEach(function (code) {
        var label = WEATHER_ICON_CODEX[code];
        WEATHER_ICONS[code] = {
            label: label,
            html: '<img src="../base/rs/img/tq-' + code + '.png" width="28" height="28" alt="' + label + '" />',
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
        svg.innerHTML = '<clipPath id="qinghai-clip"><path d="' + pathString + '" /></clipPath>';

        ["baseImagePane", "heatPane", "overlayPane", "bordersPane"].forEach(function (paneName) {
            var pane = map.getPane(paneName);
            if (pane) {
                pane.style.clipPath = "url(#qinghai-clip)";
                pane.style.webkitClipPath = "url(#qinghai-clip)";
            }
        });
    }

    function getGridValueAt(rawData, lat, lng) {
        if (!rawData || !rawData[0] || !rawData[0].header) return null;
        var h = rawData[0].header;
        var nx = h.nx, ny = h.ny;
        var lo1 = h.lo1, la1 = h.la1;
        var dx = h.dx != null ? h.dx : nx > 1 ? (h.lo2 - h.lo1) / (nx - 1) : 1;
        var dy = h.dy != null ? h.dy : ny > 1 ? (h.la1 - h.la2) / (ny - 1) : 1;
        var gi = Math.floor((lng - lo1) / dx);
        var gj = Math.floor((la1 - lat) / dy);
        if (gi < 0 || gi >= nx || gj < 0 || gj >= ny) return null;
        return rawData.map(function (comp) { return comp.data[gj * nx + gi]; });
    }

    /* 在点击点(lat,lng)对指定要素做 IDW 插值，权重与 computeFloatGrid 一致：
       rain/snow 用 1/(d²+0.05)³（强局部），其余用 1/(d²+0.05)，R=5° 半径，cosLat 修正。
       用于弹窗展示“点击点本身”的气象值，不再取最近格点的原值。 */
    function interpolatePointValue(type, lat, lng) {
        var contours = cacheData.timeSeriesCmiss[currentTimeIndex];
        var points = extractPointsFromContours(type, contours);
        if (!points || points.length === 0) return null;
        var resolveType = resolveMeteoType(type);
        var b = L.latLngBounds(MAP_CONFIG.bounds);
        var cosLat = Math.cos((((b.getSouth() + b.getNorth()) / 2) * Math.PI) / 180);
        var R = 5.0, R2 = R * R, smoothing = 0.05;
        var dlng = 0, dlat = 0, d2 = 0, w = 0, sumV = 0, sumW = 0, closestVal = null, minDist2 = Infinity;
        for (var i = 0; i < points.length; i++) {
            var p = points[i];
            var dl = (lng - p.lng) * cosLat, da = lat - p.lat;
            d2 = dl * dl + da * da;
            if (d2 < minDist2) { minDist2 = d2; closestVal = p.value; }
            if (d2 > R2) continue;
            if (type === "rain" || type === "snow") w = 1.0 / Math.pow(d2 + smoothing, 3);
            else w = 1.0 / (d2 + smoothing);
            sumV += p.value * w;
            sumW += w;
        }
        return sumW > 0 ? sumV / sumW : closestVal;
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
            else if (type === "humidity") val = s[9];
            else if (type === "radiation") val = s[10];
            else if (type === "cloud") val = s[11];

            if (val === undefined || val === null || isNaN(val)) return;
            if (val === 9999 || val === 999999 || val === -9999 || val === -999 || val === -99) return;

            points.push({ lat: s[2], lng: s[1], value: val });
        });
        return points;
    }

    function pointInPolygon(lng, lat, polygon) {
        var inside = false;
        for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            var xi = polygon[i][0], yi = polygon[i][1], xj = polygon[j][0], yj = polygon[j][1];
            if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }
    function isInsideQinghai(lat, lng) {
        return qinghaiPolygons.some(function (r) { return pointInPolygon(lng, lat, r); });
    }
    function findNearestStation(lat, lng) {
        var contours = cacheData.timeSeriesCmiss[currentTimeIndex];
        if (!contours) return null;
        var best = null, bestDist = Infinity;
        contours.forEach(function (s) {
            var dist = (s[1] - lng) * (s[1] - lng) + (s[2] - lat) * (s[2] - lat);
            if (dist < bestDist) { bestDist = dist; best = s; }
        });
        return best;
    }

    /* ============================================================
     降雪粒子层
     ============================================================ */
    var SnowParticleLayer = L.Layer.extend({
        initialize: function (points) { this._points = points || []; },
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
        _buildMask: function () {
            var b = L.latLngBounds(MAP_CONFIG.bounds);
            var west = b.getWest(), east = b.getEast(), south = b.getSouth(), north = b.getNorth();
            var cols = 240, rows = Math.ceil(cols * ((north - south) / (east - west)));
            this._grid = computeFloatGrid(this._points, "snow", cols, rows, west, east, south, north);
            var g = this._grid;
            this._mask = new Uint8Array(g.cols * g.rows);
            for (var gy = 0; gy < g.rows; gy++) {
                var lat = g.north - (gy + 0.5) * g.dy;
                for (var gx = 0; gx < g.cols; gx++) {
                    var lng = g.west + (gx + 0.5) * g.dx;
                    if (isInsideQinghai(lat, lng) && g.grid[gy * g.cols + gx] > 0.1) {
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
        _isSnowing: function (px, py) {
            var r = this._rect, g = this._grid, m = this._mask;
            if (!r || !g || !m) return false;
            if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) return false;
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
                for (var j = 0; j < ps.length; j++) {
                    var p = ps[j];
                    p.y += Math.cos(p.d) + 1 + p.r / 2;
                    p.x += Math.sin(p.d) * 1.5;
                    if (p.x > r.x + r.w + 5 || p.x < r.x - 5 || p.y > r.y + r.h) {
                        if (j % 3 > 0) ps[j] = { x: r.x + Math.random() * r.w, y: r.y - 10, r: p.r, d: p.d };
                        else if (Math.sin(p.d) > 0) ps[j] = { x: r.x - 5, y: r.y + Math.random() * r.h, r: p.r, d: p.d };
                        else ps[j] = { x: r.x + r.w + 5, y: r.y + Math.random() * r.h, r: p.r, d: p.d };
                    }
                }
            }
            this._raf = requestAnimationFrame(this._animate.bind(this));
        },
    });

    /* ============================================================
     雨滴下落粒子层
     ============================================================ */
    var RainParticleLayer = L.Layer.extend({
        initialize: function (points) { this._points = points || []; },
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
        _buildMask: function () {
            var b = L.latLngBounds(MAP_CONFIG.bounds);
            var west = b.getWest(), east = b.getEast(), south = b.getSouth(), north = b.getNorth();
            var cols = 240, rows = Math.ceil(cols * ((north - south) / (east - west)));
            this._grid = computeFloatGrid(this._points, "rain", cols, rows, west, east, south, north);
            var g = this._grid;
            this._mask = new Uint8Array(g.cols * g.rows);
            for (var gy = 0; gy < g.rows; gy++) {
                var lat = g.north - (gy + 0.5) * g.dy;
                for (var gx = 0; gx < g.cols; gx++) {
                    var lng = g.west + (gx + 0.5) * g.dx;
                    if (isInsideQinghai(lat, lng) && g.grid[gy * g.cols + gx] > 0.1) {
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
            this._splashes = [];
        },
        _isRaining: function (px, py) {
            var r = this._rect, g = this._grid, m = this._mask;
            if (!r || !g || !m) return false;
            if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) return false;
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
                var slant = 0.22; 
                
                ctx.beginPath();
                ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
                ctx.lineWidth = 0.8;
                for (var i = 0; i < ps.length; i++) {
                    var p = ps[i];
                    if (p.w > 1) continue;
                    /* 起终点都在降水区内才画整条雨线，避免雨线终点探出区域边界 */
                    if (this._isRaining(p.x, p.y) && this._isRaining(p.x + p.len * slant, p.y + p.len)) {
                        ctx.moveTo(p.x, p.y);
                        ctx.lineTo(p.x + p.len * slant, p.y + p.len);
                    }
                }
                ctx.stroke();

                ctx.beginPath();
                ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
                ctx.lineWidth = 1.4;
                for (var j = 0; j < ps.length; j++) {
                    var q = ps[j];
                    if (q.w <= 1) continue;
                    if (this._isRaining(q.x, q.y) && this._isRaining(q.x + q.len * slant, q.y + q.len)) {
                        ctx.moveTo(q.x, q.y);
                        ctx.lineTo(q.x + q.len * slant, q.y + q.len);
                    }
                }
                ctx.stroke();

                for (var si = sp.length - 1; si >= 0; si--) {
                    var s = sp[si];
                    var alpha = s.life / s.maxLife;
                    ctx.beginPath();
                    ctx.strokeStyle = "rgba(255, 255, 255, " + (alpha * 0.7).toFixed(2) + ")";
                    ctx.lineWidth = 1;
                    ctx.arc(s.x, s.y, s.radius * (1 - alpha * 0.3), -Math.PI, 0, false);
                    ctx.stroke();
                    ctx.fillStyle = "rgba(255, 255, 255, " + (alpha * 0.6).toFixed(2) + ")";
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

                for (var k = 0; k < ps.length; k++) {
                    var rp = ps[k];
                    rp.y += rp.speed;
                    rp.x += rp.speed * slant;
                    if (rp.y > r.y + r.h || rp.x > r.x + r.w) {
                        rp.y = r.y - rp.len;
                        rp.x = r.x + Math.random() * r.w;
                    }
                }

                if (sp.length < 160) {
                    for (var tryN = 0; tryN < 40; tryN++) {
                        if (Math.random() > 0.5) continue;
                        var sx = r.x + Math.random() * r.w;
                        var sy = r.y + Math.random() * r.h;
                        if (!this._isRaining(sx, sy)) continue;
                        var drops = [];
                        var dropCount = 3 + Math.floor(Math.random() * 3);
                        for (var dn = 0; dn < dropCount; dn++) {
                            drops.push({ vx: (Math.random() - 0.5) * 2, vy: -Math.random() * 1.5 - 0.5, r: 1 + Math.random() * 1.2 });
                        }
                        sp.push({ x: sx, y: sy, radius: 3 + Math.random() * 3, life: 8 + Math.floor(Math.random() * 6), maxLife: 14, drops: drops });
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
            if (this.options.opacity !== undefined) this._image.style.opacity = this.options.opacity;
            if (this.options.mixBlendMode) this._image.style.mixBlendMode = this.options.mixBlendMode;
            if (map.options.zoomAnimation && L.Browser.any3d) L.DomUtil.addClass(this._image, "leaflet-zoom-animated");
            map.getPane(this.options.pane || "overlayPane").appendChild(this._image);
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
                offset = this._map._latLngBoundsToNewLayerBounds(this._bounds, e.zoom, e.center).min;
            L.DomUtil.setTransform(this._image, offset, scale);
        },
        _reset: function () {
            var image = this._image,
                bounds = new L.Bounds(
                    this._map.latLngToLayerPoint(this._bounds.getNorthWest()),
                    this._map.latLngToLayerPoint(this._bounds.getSouthEast())
                ),
                size = bounds.getSize();
            L.DomUtil.setPosition(image, bounds.min);
            image.style.width = size.x + "px";
            image.style.height = size.y + "px";
        },
    });

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

    function updateCanvasOverlay(layer, points, type) {
        var bounds = L.latLngBounds(MAP_CONFIG.bounds);
        var west = bounds.getWest(), east = bounds.getEast(), south = bounds.getSouth(), north = bounds.getNorth();
        var cols = 240;
        var rows = Math.ceil(cols * ((north - south) / (east - west)));
        var resolveType = type === "wind" ? "windSpeed" : type;
        var gridData = computeFloatGrid(points, resolveType, cols, rows, west, east, south, north);
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
                var cols = 150, rows = Math.ceil(cols * ((bounds.getNorth() - bounds.getSouth()) / (bounds.getEast() - bounds.getWest())));
                if (this._nextGlobal) {
                    this.globalData = this._nextGlobal;
                    this._nextGlobal = null;
                } else {
                    this.globalData = computeFloatGrid(this.points, "isobar", cols, rows, bounds.getWest(), bounds.getEast(), bounds.getSouth(), bounds.getNorth());
                }
                var tiles = this._tiles;
                Object.keys(tiles).forEach(function (key) {
                    var entry = tiles[key];
                    if (!entry.current || !entry.coords) return;
                    var freshCanvas = this.createTile(entry.coords);
                    if (entry.el && entry.el.getContext) {
                        var elCtx = entry.el.getContext("2d");
                        elCtx.clearRect(0, 0, entry.el.width, entry.el.height);
                        elCtx.drawImage(freshCanvas, 0, 0);
                    }
                }.bind(this));
            },
            createTile: function (coords) {
                var tile = L.DomUtil.create("canvas", "leaflet-tile"), size = this.getTileSize();
                tile.width = size.x;
                tile.height = size.y;
                var ctx = tile.getContext("2d");
                if (!this.globalData) {
                    var gBounds = L.latLngBounds(MAP_CONFIG.bounds);
                    var gCols = 150, gRows = Math.ceil(gCols * ((gBounds.getNorth() - gBounds.getSouth()) / (gBounds.getEast() - gBounds.getWest())));
                    this.globalData = computeFloatGrid(this.points, "isobar", gCols, gRows, gBounds.getWest(), gBounds.getEast(), gBounds.getSouth(), gBounds.getNorth());
                }
                var globalData = this.globalData;
                var bounds = this._tileCoordsToBounds(coords);
                var west = bounds.getWest(), east = bounds.getEast(), north = bounds.getNorth(), south = bounds.getSouth();
                var gridStep = 6, cols = Math.ceil(size.x / gridStep) + 1, rows = Math.ceil(size.y / gridStep) + 1;
                var grid = Array.from({ length: rows }, function () { return new Float32Array(cols); });
                for (var gy = 0; gy < rows; gy++) {
                    var lat = north - ((gy * gridStep) / size.y) * (north - south);
                    for (var gx = 0; gx < cols; gx++) {
                        var lng = west + ((gx * gridStep) / size.x) * (east - west);
                        var gxGlobal = (lng - globalData.west) / globalData.dx, gyGlobal = (globalData.north - lat) / globalData.dy;
                        var x0 = Math.floor(gxGlobal), x1 = Math.min(x0 + 1, globalData.cols - 1);
                        var y0 = Math.floor(gyGlobal), y1 = Math.min(y0 + 1, globalData.rows - 1);
                        if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
                        var tx = gxGlobal - x0, ty = gyGlobal - y0;
                        var v00 = globalData.grid[y0 * globalData.cols + x0], v10 = globalData.grid[y0 * globalData.cols + x1];
                        var v01 = globalData.grid[y1 * globalData.cols + x0], v11 = globalData.grid[y1 * globalData.cols + x1];
                        grid[gy][gx] = v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
                    }
                }
                function getIsobarStyle(val) {
                    if (val < 600) return { color: "rgba(100, 50, 150, 0.8)", width: 1.2 };
                    if (val >= 600 && val < 700) return { color: "rgba(150, 100, 200, 0.8)", width: 1.3 };
                    if (val >= 700 && val < 800) return { color: "rgba(200, 150, 250, 0.85)", width: 1.4 };
                    if (val >= 800 && val < 900) return { color: "rgba(50, 150, 250, 0.9)", width: 1.5 };
                    return { color: "rgba(0, 100, 200, 0.95)", width: 1.6 };
                }
                var contourInterval = (METEO_CONFIG.isobar || { interval: 20 }).interval;
                ctx.lineJoin = "round";
                ctx.lineCap = "round";
                for (var cy = 0; cy < rows - 1; cy++) {
                    for (var cx = 0; cx < cols - 1; cx++) {
                        var v1 = grid[cy][cx], v2 = grid[cy][cx + 1], v3 = grid[cy + 1][cx], v4 = grid[cy + 1][cx + 1];
                        var minV = Math.min(v1, v2, v3, v4), maxV = Math.max(v1, v2, v3, v4);
                        if (maxV - minV > 50 * contourInterval) continue;
                        var minLevel = Math.floor(minV / contourInterval), maxLevel = Math.floor(maxV / contourInterval);
                        if (minLevel !== maxLevel) {
                            for (var level = minLevel + 1; level <= maxLevel; level++) {
                                var target = level * contourInterval, pts = [];
                                if ((v1 <= target && v2 >= target) || (v1 >= target && v2 <= target)) pts.push({ x: cx + (target - v1) / (v2 - v1), y: cy });
                                if ((v3 <= target && v4 >= target) || (v3 >= target && v4 <= target)) pts.push({ x: cx + (target - v3) / (v4 - v3), y: cy + 1 });
                                if ((v1 <= target && v3 >= target) || (v1 >= target && v3 <= target)) pts.push({ x: cx, y: cy + (target - v1) / (v3 - v1) });
                                if ((v2 <= target && v4 >= target) || (v2 >= target && v4 <= target)) pts.push({ x: cx + 1, y: cy + (target - v2) / (v4 - v2) });
                                if (pts.length >= 2) {
                                    var px1 = pts[0].x * gridStep, py1 = pts[0].y * gridStep, px2 = pts[1].x * gridStep, py2 = pts[1].y * gridStep;
                                    var style = getIsobarStyle(target);
                                    ctx.beginPath();
                                    ctx.strokeStyle = style.color;
                                    ctx.lineWidth = style.width;
                                    ctx.moveTo(px1, py1);
                                    ctx.lineTo(px2, py2);
                                    ctx.stroke();
                                    if (cx % 40 === 20 && cy % 40 === 20 && px1 > 25 && py1 > 25 && px1 < size.x - 25) {
                                        var mx = (px1 + px2) / 2, my = (py1 + py2) / 2, angle = Math.atan2(py2 - py1, px2 - px1);
                                        if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
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
                                        ctx.font = "normal 10px system-ui, sans-serif";
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
                var rThreshold = 20, centers = [];
                for (var hy = rThreshold; hy < rows - rThreshold; hy += 6) {
                    for (var hx = rThreshold; hx < cols - rThreshold; hx += 6) {
                        var hVal = grid[hy][hx], isMax = true, isMin = true;
                        for (var hdy = -rThreshold; hdy <= rThreshold; hdy++) {
                            for (var hdx = -rThreshold; hdx <= rThreshold; hdx++) {
                                if (hdx === 0 && hdy === 0) continue;
                                var neighbor = grid[hy + hdy][hx + hdx];
                                if (neighbor >= hVal) isMax = false;
                                if (neighbor <= hVal) isMin = false;
                            }
                        }
                        if (isMax && hVal > 800) centers.push({ type: "H", x: hx * gridStep, y: hy * gridStep, val: Math.round(hVal) });
                        else if (isMin && hVal < 700) centers.push({ type: "L", x: hx * gridStep, y: hy * gridStep, val: Math.round(hVal) });
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
        var layer = new ContourLayer({ opacity: 1.0, pane: "heatPane", updateWhenZooming: false });
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
            var c = String(s[4]), iconCfg = WEATHER_ICONS[c];
            if (!iconCfg) iconCfg = WEATHER_ICONS["13"];
            var divIcon = L.divIcon({ html: iconCfg.html, className: "wm-ic", iconSize: [28, 28], iconAnchor: [14, 14] });
            var marker = L.marker([s[2], s[1]], { icon: divIcon });
            var popup = '<div class="popup-title">📍 ' + (s[27] || "") + "</div>";
            popup += '<div class="popup-row">🧭 经纬度: ' + (+s[2]).toFixed(3) + "°N, " + (+s[1]).toFixed(3) + "°E</div>";
            popup += '<div class="popup-row">🌤️ 天气: ' + iconCfg.label + "</div>";
            marker.bindPopup(popup, { className: "weather-popup", maxWidth: 240 });
            markers.push(marker);
        }
        return L.layerGroup(markers);
    }

    /* 场站弹窗 HTML：在弹窗打开时即时构建，确保反映当前选中的气象要素与时间步。
       保留场站自带天气电码，并追加当前选中要素在站点位置的插值值。 */
    function buildStationPopupHtml(st) {
        var typeKey = st.type && STATION_TYPE_ICON[st.type] ? st.type : "default";
        var html = '<div class="popup-title">📍 ' + (st.name || "") + "</div>";
        html += '<div class="popup-row">🏷️ 类型: ' + (STATION_TYPE_LABEL[typeKey] || typeKey) + "</div>";
        html += '<div class="popup-row">🧭 经纬度: ' + (+st.lat).toFixed(3) + "°N, " + (+st.lng).toFixed(3) + "°E</div>";
        if (st.weather != null && st.weather !== "") {
            var wx2 = WEATHER_ICONS[String(st.weather)] || WEATHER_ICONS["13"];
            html += '<div class="popup-row">🌤️ 天气: ' + wx2.label + "</div>";
        }
        var rows = activeElementRows(st.lat, st.lng);
        if (rows.length) html += rows.join("");
        return html;
    }

    function buildStationLayer() {
        if (!stationConfig || stationConfig.length === 0) return null;
        var markers = [];
        stationConfig.forEach(function (st) {
            var typeKey = st.type && STATION_TYPE_ICON[st.type] ? st.type : "default";
            var iconUrl = STATION_TYPE_ICON[typeKey];
            var fallback = STATION_TYPE_FALLBACK[typeKey] || STATION_TYPE_FALLBACK.default;

            var html = '<div class="wm-station"><div class="wm-station-icon" data-fallback="' + fallback + '">' +
                '<img class="wm-station-pic" src="' + iconUrl + '" alt="' + (st.name || "") + '" onerror="this.style.display=\'none\';this.parentNode.classList.add(\'is-fallback\')" />';

            if (showStationWeather && st.weather != null && st.weather !== "") {
                var code = String(st.weather);
                var wx = WEATHER_ICONS[code] || WEATHER_ICONS["13"];
                html += '<span class="wm-station-wx" title="' + wx.label + '">' +
                    '<img src="../base/rs/img/tq-' + code + '.png" alt="' + wx.label + '" /></span>';
            }
            html += '</div><div class="wm-station-name">' + (st.name || "") + "</div></div>";

            var divIcon = L.divIcon({ html: html, className: "wm-station-wrap", iconSize: [28, 28], iconAnchor: [14, 14] });
            var marker = L.marker([st.lat, st.lng], { icon: divIcon, pane: "stationPane" });
            marker._stationGroup = st.group || "";

            marker.bindPopup(function () { return buildStationPopupHtml(st); }, { className: "weather-popup", maxWidth: 240 });
            markers.push(marker);
        });
        return L.layerGroup(markers);
    }

    function refreshStationLayer() {
        if (!map) return;
        if (stationLayer) { map.removeLayer(stationLayer); stationLayer = null; }
        if (stationConfig && stationConfig.length > 0) {
            stationLayer = buildStationLayer();
            if (stationLayer) { stationLayer.addTo(map); applyHighlight(); }
        }
    }

    function applyHighlight() {
        if (!stationLayer) return;
        stationLayer.eachLayer(function (marker) {
            var el = marker.getElement();
            if (!el) return;
            if (currentHighlight == null) {
                el.classList.remove("is-highlight", "is-dimmed");
                el.style.zIndex = "";
                return;
            }
            if ((marker._stationGroup || "") === currentHighlight) {
                el.classList.add("is-highlight");
                el.classList.remove("is-dimmed");
                el.style.zIndex = 1000;
            } else {
                el.classList.add("is-dimmed");
                el.classList.remove("is-highlight");
                el.style.zIndex = "";
            }
        });
    }

    function windToUV(speed, dir) {
        var rad = (dir * Math.PI) / 180;
        return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
    }

    function extractWindStations(timeIndex) {
        var contours = cacheData.timeSeriesCmiss.length > 0 ? cacheData.timeSeriesCmiss[timeIndex] : null;
        if (!contours) return [];
        var list = [];
        contours.forEach(function (s) {
            var speed = s[5], dir = s[6];
            if (speed == null || speed === 9999 || dir == null || dir === 9999) return;
            list.push({ lat: s[2], lng: s[1], speed: speed, dir: dir });
        });
        return list;
    }

    function buildStationWindField(stations) {
        if (!stations || !stations.length) return null;
        var b = MAP_CONFIG.bounds;
        var south = b[0][0], west = b[0][1], north = b[1][0], east = b[1][1];
        var step = 0.5;
        var cols = Math.round((east - west) / step) + 1, rows = Math.round((north - south) / step) + 1;

        var uPts = [], vPts = [], speedPts = [];
        stations.forEach(function (st) {
            var uv = windToUV(st.speed, st.dir);
            uPts.push({ lat: st.lat, lng: st.lng, value: uv.u });
            vPts.push({ lat: st.lat, lng: st.lng, value: uv.v });
            speedPts.push({ lat: st.lat, lng: st.lng, value: st.speed });
        });

        var uGrid = computeFloatGrid(uPts, "windSpeed", cols, rows, west, east, south, north);
        var vGrid = computeFloatGrid(vPts, "windSpeed", cols, rows, west, east, south, north);

        var header = {
            discipline: 0, parameterCategory: 2, lo1: west, la1: north, lo2: east, la2: south,
            nx: cols, ny: rows, dx: step, dy: step, refTime: new Date().toISOString(),
            parameterNumber: 2, parameterNumberName: "U-component_of_wind", parameterUnit: "m.s-1",
        };
        var headerV = Object.assign({}, header, { parameterNumber: 3, parameterNumberName: "V-component_of_wind" });
        return {
            uv: [{ header: header, data: Array.from(uGrid.grid) }, { header: headerV, data: Array.from(vGrid.grid) }],
            speed: speedPts,
        };
    }

    function createVelLayer(data) {
        return L.velocityLayer({
            displayValues: true,
            displayOptions: { velocityType: "风场", displayPosition: "bottomright", speedUnit: "m/s" },
            data: data, maxVelocity: 20, velocityScale: 0.005, particleMultiplier: 1 / 600, lineWidth: 1.5,
            colorScale: ["rgba(255, 255, 255, 0.9)", "rgba(255, 255, 255, 0.95)", "rgba(255, 255, 255, 1)"],
        });
    }

    function buildWeatherLayer(type) {
        if (type === "weather") return buildWeatherIconLayer();
        if (type === "snow") {
            var compositeGroup = L.layerGroup();
            var currentContours = cacheData.timeSeriesCmiss.length > 0 ? cacheData.timeSeriesCmiss[currentTimeIndex] : null;
            var points = extractPointsFromContours("snow", currentContours);
            if (points && points.length > 0) {
                var heatLayer = createPerformanceIdwLayer(points, "snow");
                compositeGroup.heatLayer = heatLayer;
                compositeGroup.addLayer(heatLayer);
            }
            var snowFx = new SnowParticleLayer(points);
            compositeGroup.snowFx = snowFx;
            compositeGroup.addLayer(snowFx);
            compositeGroup.points = points;
            return compositeGroup;
        }
        if (type === "rain") {
            var compositeGroup = L.layerGroup();
            var rainContours = cacheData.timeSeriesCmiss.length > 0 ? cacheData.timeSeriesCmiss[currentTimeIndex] : null;
            var rainPoints = extractPointsFromContours("rain", rainContours);
            if (rainPoints && rainPoints.length > 0) {
                var heatLayer = createPerformanceIdwLayer(rainPoints, "rain");
                compositeGroup.heatLayer = heatLayer;
                compositeGroup.addLayer(heatLayer);
                var rainFx = new RainParticleLayer(rainPoints);
                compositeGroup.rainFx = rainFx;
                compositeGroup.addLayer(rainFx);
            }
            compositeGroup.points = rainPoints;
            return compositeGroup;
        }
        if (type === "wind" || type === "windSpeed") {
            var compositeGroup = L.layerGroup();
            var built = buildStationWindField(extractWindStations(currentTimeIndex));
            if (built) {
                cacheData.gfs = built.uv;
                var heatLayer = createPerformanceIdwLayer(built.speed, "windSpeed");
                compositeGroup.heatLayer = heatLayer;
                compositeGroup.addLayer(heatLayer);
                if (!globalVelLayer) globalVelLayer = createVelLayer(built.uv);
                else if (globalVelLayer.setData) globalVelLayer.setData(built.uv);
                if (globalVelLayer) { compositeGroup.velLayer = globalVelLayer; compositeGroup.addLayer(globalVelLayer); }
            }
            compositeGroup.points = built ? built.speed : [];
            return compositeGroup;
        }
        if (type === "isobar") {
            var compositeGroup = L.layerGroup();
            var pressureContours = cacheData.timeSeriesCmiss.length > 0 ? cacheData.timeSeriesCmiss[currentTimeIndex] : null;
            var pressurePoints = extractPointsFromContours("pressure", pressureContours);
            if (pressurePoints && pressurePoints.length > 0) {
                var heatLayer = createPerformanceIdwLayer(pressurePoints, "pressure");
                compositeGroup.heatLayer = heatLayer;
                compositeGroup.addLayer(heatLayer);
                var contourLayer = createContourVectorLayer(pressurePoints);
                compositeGroup.contourLayer = contourLayer;
                compositeGroup.addLayer(contourLayer);
            }
            compositeGroup.points = pressurePoints;
            return compositeGroup;
        }

        var currentContours = cacheData.timeSeriesCmiss.length > 0 ? cacheData.timeSeriesCmiss[currentTimeIndex] : null;
        var points = extractPointsFromContours(type, currentContours);
        if (points.length === 0) return null;
        var layer = createPerformanceIdwLayer(points, type);
        if (layer) layer.points = points;
        return layer;
    }

    var MUTEX_TYPES = ["wind", "rain", "snow", "temp", "pressure", "isobar", "humidity", "radiation", "cloud"];

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

            if (MUTEX_TYPES.indexOf(type) >= 0) {
                /* 切换数值气象要素图层时：停止播放，并将时间点重置为距当前时间最近的时间步
                   （默认值），修复“切换气象效果后播放进度不停止”。无论切换前是否在播放，一律回默认。 */
                if (isPlaying) {
                    isPlaying = false;
                    if (playbackRaf) { cancelAnimationFrame(playbackRaf); playbackRaf = null; }
                    if (playbackTimer) { clearInterval(playbackTimer); playbackTimer = null; }
                    playState = null;
                }
                currentTimeIndex = findNearestStepIndex(new Date());
                renderSingleFrame(type, currentTimeIndex);
                setParticleFxVisible(true);
                notifyTimeChange();
            } else if (isPlaying) {
                /* 切到天气等非互斥图层且正在播放：保留原有隐藏粒子行为 */
                setParticleFxVisible(false);
            }

            if (window.updateLegendUI)
                window.updateLegendUI(type, METEO_CONFIG);
            return true;
        }
        return wasActive;
    }

    /* 生成“当前选中气象要素”在 (lat,lng) 处的插值展示行，场站弹窗与地图点击共用。
       分类值（天气电码）不在此处理；无激活要素时返回空数组。 */
    function activeElementRows(lat, lng) {
        function check(v) { return (v !== undefined && v !== null && v !== 9999 && v !== 999999 && v !== -9999 && v !== -999 && !isNaN(v)); }
        function fmt(v, d) { return (+v).toFixed(d == null ? 1 : d); }
        var rows = [];
        var activeType = getActiveLayerType();
        /* 直接在点击点做 IDW 插值取该点气象值，不再找最近格点/站点 */
        if (activeType === "temp") {
            var t = interpolatePointValue("temp", lat, lng);
            if (check(t)) rows.push('<div class="popup-row">🌡️ <b>气温:</b> ' + fmt(t, 1) + "°C</div>");
        } else if (activeType === "rain") {
            var r = interpolatePointValue("rain", lat, lng);
            if (check(r)) rows.push('<div class="popup-row">💧 <b>降水:</b> ' + fmt(r, 2) + " mm</div>");
        } else if (activeType === "snow") {
            var sn = interpolatePointValue("snow", lat, lng);
            if (check(sn)) rows.push('<div class="popup-row">❄️ <b>降雪量:</b> ' + fmt(sn, 2) + " mm</div>");
        } else if (activeType === "wind" || activeType === "windSpeed") {
            var ws = interpolatePointValue("windSpeed", lat, lng);
            if (check(ws)) rows.push('<div class="popup-row">🌪 <b>实况风速:</b> ' + fmt(ws, 1) + " m/s</div>");
            if (!isPlaying && cacheData.gfs && cacheData.gfs.length >= 2) {
                var v = getGridValueAt(cacheData.gfs, lat, lng);
                if (v && v[0] != null && v[1] != null) {
                    var speed = Math.sqrt(v[0] * v[0] + v[1] * v[1]).toFixed(1),
                        dir = (((Math.atan2(-v[0], -v[1]) * 180) / Math.PI + 360) % 360).toFixed(0);
                    rows.push('<div class="popup-row">🌬️ <b>预报流线:</b> ' + speed + " m/s  (" + dir + "°)</div>");
                }
            }
        } else if (activeType === "pressure" || activeType === "isobar") {
            var ps = interpolatePointValue("pressure", lat, lng);
            if (check(ps)) rows.push('<div class="popup-row">⏱ <b>气压:</b> ' + fmt(ps, 1) + " hPa</div>");
        } else if (activeType === "humidity") {
            var rh = interpolatePointValue("humidity", lat, lng);
            if (check(rh)) rows.push('<div class="popup-row">💧 <b>相对湿度:</b> ' + fmt(rh, 0) + " %</div>");
        } else if (activeType === "radiation") {
            var rad = interpolatePointValue("radiation", lat, lng);
            if (check(rad)) rows.push('<div class="popup-row">☀️ <b>太阳辐射:</b> ' + fmt(rad, 0) + " W/m²</div>");
        } else if (activeType === "cloud") {
            var cl = interpolatePointValue("cloud", lat, lng);
            if (check(cl)) rows.push('<div class="popup-row">☁️ <b>总云量:</b> ' + fmt(cl, 0) + " %</div>");
        }
        return rows;
    }

    function bindMapPopup() {
        map.on("click", function (e) {
            var lat = e.latlng.lat, lng = e.latlng.lng;
            if (!isInsideQinghai(lat, lng)) return;
            function isOn(t) { var l = mapLayersCache[t]; return !!l && !!map._layers[l._leaflet_id]; }

            /* 点击命中附近格点（距离 < 0.02°≈2km）时显示该格点站名 s[27]；
               气象值仍用点击点插值，不受站点选择影响。 */
            var near = findNearestStation(lat, lng);
            var stationName = "";
            if (near && near[27]) {
                var ddeg = Math.sqrt((near[1] - lng) * (near[1] - lng) + (near[2] - lat) * (near[2] - lat));
                if (ddeg < 0.02) stationName = near[27];
            }

            /* 当前选中气象要素在点击点的插值展示行，与场站弹窗共用 activeElementRows */
            var rows = activeElementRows(lat, lng);

            /* 无激活要素但天气图层开启时，天气电码为分类值不插值，取点击点最近格点电码展示 */
            if (getActiveLayerType() == null && isOn("weather")) {
                var st = findNearestStation(lat, lng);
                if (st && st[4] != null) {
                    var wx = WEATHER_ICONS[String(st[4])];
                    if (wx) rows.push('<div class="popup-row">🌤️ <b>天气:</b> ' + wx.label + "</div>");
                }
            }

            var title = stationName
                ? "📍 " + stationName + "  ·  " + lat.toFixed(2) + "°N, " + lng.toFixed(2) + "°E"
                : "📍 " + lat.toFixed(2) + "°N, " + lng.toFixed(2) + "°E";
            var html = '<div class="popup-title">' + title + "</div>" + rows.join("");
            L.popup({ className: "weather-popup", maxWidth: 280, autoPan: false })
                .setLatLng(e.latlng).setContent(html).openOn(map);
        });
    }

    var MOJICB_ELEM_MAP = {
        WEATHER: { s: 4, conv: function (v) { return String(v); } },
        TT2: { s: 19, conv: function (v) { return +(+v).toFixed(1); } },
        WS: { s: 5, conv: function (v) { return +(+v).toFixed(1); } },
        RAIN: { s: 12, conv: function (v) { return +(+v).toFixed(2); } },
        SNOW: { s: 12, conv: function (v) { return +(+v).toFixed(2); } },
        PS: { s: 8, conv: function (v) { return +(+v / 100).toFixed(1); } },
    };

    function _mojicbRowToStation(lat, lng, row, elemIndex) {
        var s = new Array(28).fill(9999);
        s[0] = "mj_" + (+lat).toFixed(3) + "_" + (+lng).toFixed(3);
        s[1] = +lng;
        s[2] = +lat;
        for (var elem in MOJICB_ELEM_MAP) {
            var idx = elemIndex[elem];
            if (idx === undefined || idx >= row.length) continue;
            var raw = row[idx];
            if (raw === null || raw === undefined || raw === "" || isNaN(raw)) continue;
            s[MOJICB_ELEM_MAP[elem].s] = MOJICB_ELEM_MAP[elem].conv(raw);
        }
        s[27] = (+lat).toFixed(2) + "," + (+lng).toFixed(2);
        return s;
    }

    function _mojicbTimeLabel(ts) {
        if (!ts || String(ts).length < 12) return ts || "";
        ts = String(ts);
        return ts.substr(4, 2) + "月" + ts.substr(6, 2) + "日 " + ts.substr(8, 2) + ":" + ts.substr(10, 2);
    }

    function adaptMojicbData(data) {
        if (!data || !Array.isArray(data.values) || !data.elems) return null;
        var elemIndex = {};
        data.elems.forEach(function (e, i) { elemIndex[e] = i; });
        var multi = Array.isArray(data.lat);
        var pts = multi ? data.lat.map(function (la, i) { return { lat: la, lng: data.lng[i] }; }) : [{ lat: data.lat, lng: data.lng }];
        var values = data.values;
        var nTime = multi ? values[0] ? values[0].length : 0 : values.length;
        var perTime = [];
        for (var t = 0; t < nTime; t++) {
            var stations = [];
            for (var p = 0; p < pts.length; p++) {
                var row = multi ? values[p][t] : values[t];
                if (!Array.isArray(row)) continue;
                stations.push(_mojicbRowToStation(pts[p].lat, pts[p].lng, row, elemIndex));
            }
            perTime.push(stations);
        }
        return { timeLabels: (data.timeSeries || []).map(_mojicbTimeLabel), perTimeContours: perTime };
    }

    function fetchAllRealData(callbacks) {
        callbacks = callbacks || {};
        cacheData.cmiss = CMISS_DATA;
        var resGeo = QINGHAI_GEO;

        rebuildTimeSeries();
        currentTimeIndex = findNearestStepIndex(new Date());

        if (resGeo && resGeo.features) {
            var rings = [];
            resGeo.features.forEach(function (f) {
                var geom = f.geometry,
                    coordsList = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
                coordsList.forEach(function (polygon) {
                    var subRings = Array.isArray(polygon[0][0]) ? polygon : [polygon];
                    subRings.forEach(function (ring) { if (ring.length >= 3) rings.push(ring); });
                });
            });
            cacheData.maskRings = rings;
            qinghaiPolygons = rings;

            L.geoJSON(resGeo, {
                pane: "bordersPane",
                style: { fillOpacity: 0, color: "#9ca3af", weight: 2 },
            }).addTo(map);
            if (resGeo.features.length > 0) {
                /* 右侧预留面板宽度(380px + 边距)，把青海整体推到可视区左侧，
                    避免右上角面板盖住青海地图；左/上/下保持基础留白 */
                map.fitBounds(L.geoJSON(resGeo).getBounds(), {
                    paddingTopLeft: [88, 60],
                    paddingBottomRight: [250, 60],
                    animate: false,
                });
                applyTrueTransparentMask();
            }
        }

        if (typeof callbacks.onLoad === "function") callbacks.onLoad();
        return api;
    }

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

    function clearActiveLayers() {
        Object.keys(mapLayersCache).forEach(function (type) {
            var layer = mapLayersCache[type];
            if (layer && map._layers[layer._leaflet_id]) map.removeLayer(layer);
            delete mapLayersCache[type];
        });
    }

    function refreshCmissData(callbacks) {
        callbacks = callbacks || {};
        cacheData.cmiss = CMISS_DATA;
        rebuildTimeSeries();
        clearFrameCache();
        currentTimeIndex = findNearestStepIndex(new Date());
        clearActiveLayers();
        if (typeof callbacks.onLoad === "function") callbacks.onLoad();
        return api;
    }

    function pad2(n) { n = +n; return (n < 10 ? "0" : "") + n; }
    function formatStepDate(date) {
        if (date == null) return "";
        var d = new Date(date);
        if (isNaN(d.getTime())) return String(date);
        return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    }
    function stepDateToDate(date) {
        if (date == null) return null;
        var d = new Date(date);
        return isNaN(d.getTime()) ? null : d;
    }
    function findNearestStepIndex(targetDate) {
        var dates = cacheData.timeStepDates;
        if (!dates || !dates.length || !(targetDate instanceof Date)) return 0;
        var best = 0, bestDiff = Infinity;
        for (var i = 0; i < dates.length; i++) {
            if (!dates[i]) continue;
            var diff = Math.abs(dates[i].getTime() - targetDate.getTime());
            if (diff < bestDiff) { bestDiff = diff; best = i; }
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
                progress: typeof progress === "number" ? progress : null,
            });
    }

    /* ============================================================
       【终极核心引擎】光流平流推演缓存与插值渲染
       ============================================================ */

    function resolveMeteoType(type) {
        if (type === "wind" || type === "windSpeed") return "windSpeed";
        if (type === "isobar") return "pressure";
        return type;
    }

    function getLayerPointsAt(type, timeIndex) {
        if (type === "wind" || type === "windSpeed") {
            var built = buildStationWindField(extractWindStations(timeIndex));
            return built ? built.speed : [];
        }
        var contours = cacheData.timeSeriesCmiss[timeIndex] || [];
        return extractPointsFromContours(type, contours);
    }

    /* 单步 IDW → RGBA 像素快照（同时保留原始气象数值网格供光流推演使用） */
    function computeFrameRGBA(type, timeIndex) {
        var resolveType = resolveMeteoType(type);
        var bounds = L.latLngBounds(MAP_CONFIG.bounds);
        var west = bounds.getWest(), east = bounds.getEast(), south = bounds.getSouth(), north = bounds.getNorth();
        var cols = 240;
        var rows = Math.ceil(cols * ((north - south) / (east - west)));
        var points = getLayerPointsAt(type, timeIndex);
        var gridData = computeFloatGrid(points, resolveType, cols, rows, west, east, south, north);
        var grid = gridData.grid;
        var rgba = new Uint8ClampedArray(cols * rows * 4);
        /* 快照上色必须与 renderBlendedFrame 的光流插值走同一套 LUT，否则 t=0/t=1 贴快照时
           会与过渡中在降水阈值处出现 0↔255 的硬跳变——弱降水带每步“缩→补”一次，即过渡完成闪烁。 */
        var lutData = getFastLUT(resolveType);
        if (lutData) {
            var lut = lutData.lut, lMin = lutData.min, lMax = lutData.max, lSteps = lutData.steps;
            var span = lMax - lMin || 1;
            for (var i = 0, n = cols * rows; i < n; i++) {
                var ratio = (grid[i] - lMin) / span;
                if (ratio < 0) ratio = 0; else if (ratio > 1) ratio = 1;
                var lutIdx = ((ratio * (lSteps - 1)) | 0) * 4;
                rgba[i * 4]     = lut[lutIdx];
                rgba[i * 4 + 1] = lut[lutIdx + 1];
                rgba[i * 4 + 2] = lut[lutIdx + 2];
                rgba[i * 4 + 3] = lut[lutIdx + 3];
            }
        } else {
            for (var i = 0, n = cols * rows; i < n; i++) {
                var c = getIdwColor(resolveType, grid[i]);
                rgba[i * 4] = c.r;
                rgba[i * 4 + 1] = c.g;
                rgba[i * 4 + 2] = c.b;
                rgba[i * 4 + 3] = c.a;
            }
        }
        return { rgba: rgba, grid: grid, cols: cols, rows: rows, resolveType: resolveType };
    }

    /* 懒加载缓存：同时缓存 rgba 快照和 grid 数值网格 */
    function getCachedFrame(type, timeIndex) {
        if (!frameCache[type]) frameCache[type] = { frames: {} };
        var slot = frameCache[type];
        if (!slot.frames[timeIndex]) {
            var f = computeFrameRGBA(type, timeIndex);
            slot.cols = f.cols;
            slot.rows = f.rows;
            slot.resolveType = f.resolveType;
            slot.frames[timeIndex] = { rgba: f.rgba, grid: f.grid }; 
        }
        return slot;
    }

    /* 性能引擎：高精度颜色映射查找表 (LUT)。
       预计算 2048 级色阶，避免光流计算时动态生成对象导致掉帧。 */
    var _colorLUTs = {};
    function getFastLUT(type) {
        if (_colorLUTs[type]) return _colorLUTs[type];
        var config = METEO_CONFIG[type];
        if (!config || !config.colors) return null;
        
        // 特殊处理降水降雪：让LUT包含0到最小阈值的透明过渡带，确保雷达回波扩散时边缘干脆犀利
        var min = config.min !== undefined ? config.min : config.colors[0].val;
        if (type === "rain" || type === "snow") min = 0; 
        
        var max = config.max !== undefined ? config.max : config.colors[config.colors.length - 1].val;
        var steps = 16384; /* 提高量化精度：LUT 有效阈值从 ~0.146 收敛回 ~0.10，与 getIdwColor 的 0.1 对齐 */
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

    function clearFrameCache(type) {
        if (type == null) frameCache = {};
        else delete frameCache[type];
    }

    function trimFrameCache(type, centerIdx) {
        var slot = frameCache[type];
        if (!slot) return;
        Object.keys(slot.frames).forEach(function (k) {
            var ki = +k;
            if (ki < centerIdx - 3 || ki > centerIdx + 3) delete slot.frames[k];
        });
    }

    function getActiveLayerType() {
        var active = null;
        MUTEX_TYPES.forEach(function (type) {
            var layer = mapLayersCache[type];
            if (layer && map._layers[layer._leaflet_id]) active = type;
        });
        return active;
    }

    /* 把 fromIdx→toIdx 按 t∈[0,1] 做出物理流动感插值。
       【终极绝杀：光流平流变形 (Optical Flow Advection)】
       利用空间梯度推演运动向量，让气象锋面和雷达回波产生真正的“推移、扩散、缩放”流体物理效果！ */
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
        var cols = slot.cols, rows = slot.rows;
        var resolveType = slot.resolveType;

        if (canvas.width !== cols) { canvas.width = cols; _blendImgData = null; }
        if (canvas.height !== rows) { canvas.height = rows; _blendImgData = null; }

        var ctx = canvas.getContext("2d");
        if (!_blendImgData || _blendImgData.width !== cols || _blendImgData.height !== rows) {
            _blendImgData = ctx.createImageData(cols, rows);
        }
        var data = _blendImgData.data;

        if (t <= 0) {
            data.set(from.rgba); 
        } else if (t >= 1) {
            data.set(to.rgba);   
        } else {
            var fromGrid = from.grid;
            var toGrid = to.grid;
            var lutData = getFastLUT(resolveType);
            if (!lutData) return;

            // 缓动曲线，增强流体运动的物理惯性起步与刹车
            var easeT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

            // 光流法最大像素偏移量（控制气象锋面的最大推移距离）
            var maxShift = 18.0; 
            var epsilon = 0.2; // 阻尼参数
            var isBinary = (type === "rain" || type === "snow");

            // 内部双线性采样函数，极致压缩性能开销
            function sampleGrid(grid, x, y) {
                if (x < 0) x = 0; else if (x > cols - 1.001) x = cols - 1.001;
                if (y < 0) y = 0; else if (y > rows - 1.001) y = rows - 1.001;
                var x0 = x | 0, y0 = y | 0;
                var tx = x - x0, ty = y - y0;
                var idx0 = y0 * cols + x0;
                var idx1 = idx0 + cols;
                return grid[idx0] * (1 - tx) * (1 - ty) + grid[idx0 + 1] * tx * (1 - ty) +
                       grid[idx1] * (1 - tx) * ty + grid[idx1 + 1] * tx * ty;
            }

            for (var y = 0; y < rows; y++) {
                for (var x = 0; x < cols; x++) {
                    var idx = y * cols + x;
                    var p = idx * 4;

                    // 1. 获取空间梯度边缘
                    var xL = x > 0 ? x - 1 : 0;
                    var xR = x < cols - 1 ? x + 1 : cols - 1;
                    var yT = y > 0 ? y - 1 : 0;
                    var yB = y < rows - 1 ? y + 1 : rows - 1;

                    var vA = fromGrid[idx];
                    var vB = toGrid[idx];
                    var diff = vB - vA; // 时间差（变化趋势）

                    // 2. 计算气象数据的物理拓扑梯度 (地形斜率)
                    var dx = ((fromGrid[y * cols + xR] - fromGrid[y * cols + xL]) +
                              (toGrid[y * cols + xR] - toGrid[y * cols + xL])) * 0.25;
                    var dy = ((fromGrid[yB * cols + x] - fromGrid[yT * cols + x]) +
                              (toGrid[yB * cols + x] - toGrid[yT * cols + x])) * 0.25;

                    var magSq = dx * dx + dy * dy + epsilon;

                    // 3. 计算运动向量（核心：变化差值与梯度的叉乘得到真实的推移方向）
                    // 梯度门控：连续场只在锋面/边界（梯度大）处放大光流位移，平坦区位移趋近 0，
                    // 避免变形采样把邻近区域的值拉进来、在 a→b 之外产生多余的中间色。
                    var gradMag = Math.sqrt(magSq - epsilon);
                    var shiftScale = isBinary
                        ? 1.0
                        : ADV_SHIFT_SCALE * (gradMag / (gradMag + ADV_GRAD_REF));
                    var shiftX = - (diff * dx) / magSq * shiftScale;
                    var shiftY = - (diff * dy) / magSq * shiftScale;

                    // 限制推移长度，防止无序剧烈扭曲（连续场因 shiftScale 放大，上限相应放宽）
                    var shiftLen = Math.sqrt(shiftX * shiftX + shiftY * shiftY);
                    var shiftCap = isBinary ? maxShift : maxShift * 2;
                    if (shiftLen > shiftCap) {
                        shiftX = (shiftX / shiftLen) * shiftCap;
                        shiftY = (shiftY / shiftLen) * shiftCap;
                    }

                    // 4. 对坐标进行逆向变形 (Domain Warping)，实现气象团块的“挤压”和“扩散”
                    var sampleX_A = x - easeT * shiftX;
                    var sampleY_A = y - easeT * shiftY;

                    var sampleX_B = x + (1 - easeT) * shiftX;
                    var sampleY_B = y + (1 - easeT) * shiftY;

                    // 从变形后产生的“物理流动点”拉取历史和未来数值
                    var valA = sampleGrid(fromGrid, sampleX_A, sampleY_A);
                    var valB = sampleGrid(toGrid, sampleX_B, sampleY_B);

                    // 5. 获得当前时刻融合后的物理数值
                    var currVal = valA * (1 - easeT) + valB * easeT;
                    // 钳制到原位置 from/to(vA,vB)范围内：变形采样可能把邻近区域的值拉进来，
                    // 使 currVal 超出 [vA,vB]、映射出色带上 a/b 之外的多余色。钳制后颜色严格落在 a→b 段。
                    var _vLo = vA < vB ? vA : vB;
                    var _vHi = vA < vB ? vB : vA;
                    if (currVal < _vLo) currVal = _vLo;
                    else if (currVal > _vHi) currVal = _vHi;

                    // 6. 将物理数值重新映射回气象雷达色彩 (O(1) 极速映射)
                    var ratio = (currVal - lutData.min) / (lutData.max - lutData.min);
                    if (ratio < 0) ratio = 0; else if (ratio > 1) ratio = 1;
                    
                    var lutIdx = ((ratio * (lutData.steps - 1)) | 0) * 4;

                    data[p]   = lutData.lut[lutIdx];
                    data[p+1] = lutData.lut[lutIdx+1];
                    data[p+2] = lutData.lut[lutIdx+2];
                    data[p+3] = lutData.lut[lutIdx+3];
                }
            }
        }
        ctx.putImageData(_blendImgData, 0, 0);
    }

    function precomputeContourNext(type, idx) {
        var layer = mapLayersCache[type];
        if (!layer || !layer.contourLayer) return;
        var cl = layer.contourLayer;
        var bounds = L.latLngBounds(MAP_CONFIG.bounds);
        var cols = 150,
            rows = Math.ceil(cols * ((bounds.getNorth() - bounds.getSouth()) / (bounds.getEast() - bounds.getWest())));
        var tiles = cl._tiles;
        var keys = Object.keys(tiles).filter(function (k) { return tiles[k].current && tiles[k].coords; });
        if (!keys.length) return;
        setTimeout(function () {
            if (mapLayersCache[type] !== layer) return;
            var gData = computeFloatGrid(getLayerPointsAt(type, idx), "isobar", cols, rows, bounds.getWest(), bounds.getEast(), bounds.getSouth(), bounds.getNorth());
            var prevGlobal = cl.globalData;
            cl.globalData = gData;
            cl._nextGlobal = gData;
            cl._nextTiles = {};
            cl._nextReady = false;
            /* 同步预算所有 tile：原 requestIdleCallback 分片在光流计算占用主线程时会被饿死，
               导致 renderNext 跨步、预渲染永不就绪（等压线直接不变化）。同步算完保证下一步
               过渡前 _nextReady 就绪；代价是步结束那帧短暂阻塞（视口 tile 数有限，可接受）。 */
            for (var ki = 0; ki < keys.length; ki++) {
                if (mapLayersCache[type] !== layer) return;
                var key = keys[ki];
                var entry = tiles[key];
                if (entry && entry.coords)
                    cl._nextTiles[key] = cl.createTile(entry.coords);
            }
            if (mapLayersCache[type] !== layer) return;
            cl.globalData = prevGlobal;
            cl._nextReady = true;
        }, 0);
    }

    function syncSubLayers(type, state, t) {
        var half = t >= 0.5;
        if (half === state.lastHalf) return;
        state.lastHalf = half;
        if (!half) return; 
        var layer = mapLayersCache[type];
        if (!layer || !layer.contourLayer) return;
        if (!layer.contourLayer._nextReady) return; 
        var idx = state.toIdx;
        var cl = layer.contourLayer;
        cl.points = getLayerPointsAt(type, idx);
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

    function renderSingleFrame(type, idx) {
        if (!type) return;
        var layer = mapLayersCache[type];
        if (!layer) return;
        
        // 渲染当前帧热力图
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
        
        // 【关键修复】：确保风场粒子层在单帧渲染/拖动进度条时被彻底唤醒
        if ((type === "wind" || type === "windSpeed") && globalVelLayer) {
            var built = buildStationWindField(extractWindStations(idx));
            if (built) {
                cacheData.gfs = built.uv;
                // 必须调用原生 setData 通知插件清屏并重新启动粒子系统，绝不能只改 _data
                if (typeof globalVelLayer.setData === "function") {
                    globalVelLayer.setData(built.uv);
                } else {
                    globalVelLayer._data = built.uv;
                }
            }
        }
    }

    function renderCurrentTimeStep() {
        var activeType = getActiveLayerType();
        if (!activeType) return;
        renderSingleFrame(activeType, currentTimeIndex);
    }

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
        if (globalVelLayer && globalVelLayer._canvasLayer) {
            var vc = globalVelLayer._canvasLayer._canvas;
            if (visible) {
                if (vc) vc.style.display = "";
                if (globalVelLayer._windy && globalVelLayer._clearAndRestart) globalVelLayer._clearAndRestart(); 
            } else {
                if (globalVelLayer._timer) { clearTimeout(globalVelLayer._timer); globalVelLayer._timer = null; }
                if (globalVelLayer._windy && globalVelLayer._windy.stop) globalVelLayer._windy.stop(); 
                if (vc) vc.style.display = "none";
            }
        }
    }

    function pausePlayback() {
        isPlaying = false;
        if (playbackRaf) { cancelAnimationFrame(playbackRaf); playbackRaf = null; }
        if (playbackTimer) { clearInterval(playbackTimer); playbackTimer = null; }
        playState = null;
        renderSingleFrame(getActiveLayerType(), currentTimeIndex);
        setParticleFxVisible(true); 
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
        var progress = timeSteps.length > 1 ? (currentTimeIndex + t) / (timeSteps.length - 1) : 0;
        notifyTimeChange(progress);
        if (t >= 1) {
            currentTimeIndex = playState.toIdx;
            if (currentTimeIndex >= timeSteps.length - 1) {
                pausePlayback();
                return;
            }
            playState.fromIdx = currentTimeIndex;
            playState.toIdx = currentTimeIndex + 1;
            playState.stepStart = now;
            playState.lastHalf = false;
            if (activeType) {
                var preT = activeType, preI = playState.toIdx;
                setTimeout(function () {
                    if (isPlaying && preI < timeSteps.length) getCachedFrame(preT, preI);
                }, 0);
                trimFrameCache(activeType, currentTimeIndex);
            }
            precomputeContourNext(activeType, playState.toIdx);
        }
        playbackRaf = requestAnimationFrame(playLoop);
    }

    function startPlayback() {
        if (timeSteps.length <= 1) return;
        /* 停在末帧时点播放：立即回到首帧重新播放。用户期望“立即回起点”，
           不做末帧→首帧的平滑回绕——回绕会让 progress 短暂越过 100% 导致进度条爆表。 */
        if (currentTimeIndex >= timeSteps.length - 1) {
            currentTimeIndex = 0;
        }
        isPlaying = true;
        setParticleFxVisible(false);
        notifyTimeChange();
        var activeType = getActiveLayerType();
        if (activeType) {
            getCachedFrame(activeType, currentTimeIndex);
            if (currentTimeIndex + 1 < timeSteps.length) getCachedFrame(activeType, currentTimeIndex + 1);
        }
        precomputeContourNext(activeType, Math.min(currentTimeIndex + 1, timeSteps.length - 1));
        playState = {
            fromIdx: currentTimeIndex,
            toIdx: Math.min(currentTimeIndex + 1, timeSteps.length - 1),
            stepStart: performance.now(),
            lastHalf: false,
        };
        if (playbackTimer) { clearInterval(playbackTimer); playbackTimer = null; }
        playbackRaf = requestAnimationFrame(playLoop);
    }

    function togglePlayback() {
        isPlaying ? pausePlayback() : startPlayback();
    }
    function onSliderChange(val) {
        currentTimeIndex = parseInt(val, 10);
        notifyTimeChange();
        renderCurrentTimeStep();
        /* 播放中点击进度条：从点击的时间点重新开始计时播放，而非沿用旧的 playState
           （否则旧 stepStart/fromIdx 会把 currentTimeIndex 立即覆盖回原播放位置） */
        if (isPlaying && currentTimeIndex < timeSteps.length - 1) {
            var activeType = getActiveLayerType();
            if (activeType) {
                getCachedFrame(activeType, currentTimeIndex);
                if (currentTimeIndex + 1 < timeSteps.length) getCachedFrame(activeType, currentTimeIndex + 1);
            }
            precomputeContourNext(activeType, Math.min(currentTimeIndex + 1, timeSteps.length - 1));
            playState = {
                fromIdx: currentTimeIndex,
                toIdx: Math.min(currentTimeIndex + 1, timeSteps.length - 1),
                stepStart: performance.now(),
                lastHalf: false,
            };
        }
    }

    var api = {
        map: null,
        get timeSteps() { return timeSteps; },
        MAP_CONFIG: MAP_CONFIG,
        METEO_CONFIG: METEO_CONFIG,
        WEATHER_ICON_CODEX: WEATHER_ICON_CODEX,
        get currentTimeIndex() { return currentTimeIndex; },
        get isPlaying() { return isPlaying; },
        init: null,
        toggleLayer: null,
        fetchAllRealData: null,
        togglePlayback: null,
        onSliderChange: null,
        adaptMojicbData: adaptMojicbData,
        refreshCmissData: refreshCmissData,
        setStationConfig: function (list) {
            stationConfig = Array.isArray(list) ? list : [];
            refreshStationLayer();
            return api;
        },
        highlightStations: function (group) {
            currentHighlight = group == null ? null : String(group);
            applyHighlight();
            return api;
        },
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
            get: function () { return _onTimeChange; },
            set: function (fn) { _onTimeChange = typeof fn === "function" ? fn : null; },
        });

        bindMapPopup();
        return api;
    }

    api.init = init;
    return api;
})();