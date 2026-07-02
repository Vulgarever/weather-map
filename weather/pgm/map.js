/**
 * WeatherMap 气象地图核心模块
 * 搭载高颜值气象色带引擎 & 全局 Canvas 粒子动画引擎 (无痛解耦复合风场)
 * 【已集成：光流法平流变形 (Optical Flow Advection) 物理流动引擎】
 * 【已集成：时间切片异步预取引擎 (Async Time-Slicing) 与视频级防断流】
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
    var globalVelLayer = null;
    var cacheData = {
        gfs: null,
        cmiss: null,
        maskRings: [],
        timeSeriesCmiss: [],
        timeStepDates: [],
    };
    var qinghaiPolygons = [];
    var mapLayersCache = {};
    var currentTimeIndex = 0;
    var isPlaying = false;
    var playbackTimer = null;

    /* 播放帧缓存：为每个 (图层类型, 时间步) 预计算 IDW 热力网格的 RGBA 像素快照。 */
    var frameCache = {};
    var _blendImgData = null;

    // --- 【异步调度与宏任务切片核心】 --------------------
    var CLOUD_PREFETCH_AHEAD = 10; // 预取队列深度
    var _prefetchQueue = []; // { type, idx, key } 任务队列
    var _prefetchPending = {}; // 排队状态字典
    var _isPrefetching = false; // 处理器是否在运行

    // 高优先级宏任务调度器（解决 Idle 被饿死的问题）
    var _macroTask = (function () {
        if (typeof MessageChannel !== "undefined") {
            var channel = new MessageChannel();
            var callbacks = [];
            channel.port1.onmessage = function () {
                var fn = callbacks.shift();
                if (fn) fn();
            };
            return function (fn) {
                callbacks.push(fn);
                channel.port2.postMessage(null);
            };
        } else {
            return function (fn) {
                setTimeout(fn, 0);
            };
        }
    })();

    /**
     * 异步时间切片引擎：将一帧的 IDW 计算切分，每次只算几行，
     * 保证单次占用主线程不超过 6ms，彻底消灭渲染掉帧卡顿。
     */
    function asyncPrefetchFrame(type, timeIndex, onComplete) {
        var resolveType = resolveMeteoType(type);
        var bounds = L.latLngBounds(MAP_CONFIG.bounds);
        var west = bounds.getWest(),
            east = bounds.getEast(),
            south = bounds.getSouth(),
            north = bounds.getNorth();
        var cols = 240;
        var rows = Math.ceil(cols * ((north - south) / (east - west)));
        var points = getLayerPointsAt(type, timeIndex) || [];

        var dx = (east - west) / cols;
        var dy = (north - south) / rows;
        var cosLat = Math.cos((((south + north) / 2) * Math.PI) / 180);
        var grid = new Float32Array(cols * rows);
        var rgba =
            type !== "cloud" ? new Uint8ClampedArray(cols * rows * 4) : null;
        var lutData = type !== "cloud" ? getFastLUT(resolveType) : null;
        var R = 5.0,
            R2 = R * R,
            smoothing = 0.05;
        var isPrecip = resolveType === "rain" || resolveType === "snow";

        var gy = 0; // 当前计算的行号

        function processChunk() {
            var timeLimit = 6; // 严格限制：每帧切片最多只占 6ms
            var startT = performance.now();

            while (gy < rows) {
                var endY = Math.min(gy + 2, rows);
                for (; gy < endY; gy++) {
                    var lat = north - gy * dy;
                    for (var gx = 0; gx < cols; gx++) {
                        var lng = west + gx * dx;
                        var sumV = 0,
                            sumW = 0,
                            closestVal = 0,
                            minDist2 = Infinity;
                        for (var i = 0; i < points.length; i++) {
                            var p = points[i];
                            var dl = (lng - p.lng) * cosLat,
                                da = lat - p.lat;
                            var d2 = dl * dl + da * da;
                            if (d2 < minDist2) {
                                minDist2 = d2;
                                closestVal = p.value;
                            }
                            if (d2 > R2) continue;
                            var w = isPrecip
                                ? 1.0 /
                                  ((d2 + smoothing) *
                                      (d2 + smoothing) *
                                      (d2 + smoothing))
                                : 1.0 / (d2 + smoothing);
                            sumV += p.value * w;
                            sumW += w;
                        }
                        var val = sumW > 0 ? sumV / sumW : closestVal;
                        var idx = gy * cols + gx;
                        grid[idx] = val;

                        if (rgba && lutData) {
                            var span = lutData.max - lutData.min || 1;
                            var ratio = (val - lutData.min) / span;
                            if (ratio < 0) ratio = 0;
                            else if (ratio > 1) ratio = 1;
                            var lutIdx =
                                ((ratio * (lutData.steps - 1)) | 0) * 4;
                            rgba[idx * 4] = lutData.lut[lutIdx];
                            rgba[idx * 4 + 1] = lutData.lut[lutIdx + 1];
                            rgba[idx * 4 + 2] = lutData.lut[lutIdx + 2];
                            rgba[idx * 4 + 3] = lutData.lut[lutIdx + 3];
                        } else if (rgba) {
                            var c = getIdwColor(resolveType, val);
                            rgba[idx * 4] = c.r;
                            rgba[idx * 4 + 1] = c.g;
                            rgba[idx * 4 + 2] = c.b;
                            rgba[idx * 4 + 3] = c.a;
                        }
                    }
                }

                if (performance.now() - startT >= timeLimit) {
                    break; // 超时，让出主线程
                }
            }

            if (gy < rows) {
                // 强行插入渲染间隙，防止预取任务被饿死
                _macroTask(processChunk);
            } else {
                onComplete({
                    rgba: rgba,
                    grid: grid,
                    cols: cols,
                    rows: rows,
                    resolveType: resolveType,
                });
            }
        }

        _macroTask(processChunk);
    }

    /**
     * 单线程任务处理器：每次只处理一帧，算完主动让出主线程。
     */
    function processPrefetchQueue() {
        if (!isPlaying || _prefetchQueue.length === 0) {
            _isPrefetching = false;
            return;
        }
        _isPrefetching = true;

        // 动态调度：优先算离目前播放进度最近的帧
        _prefetchQueue.sort(function (a, b) {
            return a.idx - b.idx;
        });
        var task = _prefetchQueue.shift();
        delete _prefetchPending[task.key];

        if (!frameCache[task.type]) {
            frameCache[task.type] = { frames: {} };
        }
        var slot = frameCache[task.type];

        // 只有未被缓存时才去计算
        if (!slot.frames[task.idx]) {
            asyncPrefetchFrame(task.type, task.idx, function (f) {
                slot.cols = f.cols;
                slot.rows = f.rows;
                slot.resolveType = f.resolveType;
                slot.frames[task.idx] = { rgba: f.rgba, grid: f.grid };
                processPrefetchQueue();
            });
        } else {
            processPrefetchQueue();
        }
    }

    /**
     * 滚动预取队列：确保往后 N 步以内的帧都进入排队机制
     */
    function ensurePrefetchQueue(type, fromIdx) {
        if (!type) return;
        var added = false;
        for (var k = 1; k <= CLOUD_PREFETCH_AHEAD; k++) {
            var idx = fromIdx + k;
            if (idx >= timeSteps.length) break;

            var slot = frameCache[type];
            if (slot && slot.frames[idx]) continue;
            var key = type + "_" + idx;
            if (_prefetchPending[key]) continue;

            _prefetchPending[key] = true;
            _prefetchQueue.push({ type: type, idx: idx, key: key });
            added = true;
        }

        if (added && !_isPrefetching) {
            processPrefetchQueue();
        }
    }
    // ---------------------------------------------

    var _cloudIntermediateGrid = null;
    var _cloudShiftGridSize = 0;
    var playbackRaf = null;
    var playState = null;
    var PLAY_STEP_MS = 1000;
    var ADV_SHIFT_SCALE = 1;
    var ADV_GRAD_REF = 0.3;

    var CLOUD_MULT = 3;

    var PERM_SIZE = 256;
    var _cloudPerm = new Uint8Array(PERM_SIZE * 2);
    (function initPerm(seed) {
        var p = new Uint8Array(PERM_SIZE);
        for (var i = 0; i < PERM_SIZE; i++) p[i] = i;
        var s = seed || 1337;
        function rnd() {
            s ^= s << 13;
            s ^= s >>> 17;
            s ^= s << 5;
            return ((s >>> 0) % 100000) / 100000;
        }
        for (var i = PERM_SIZE - 1; i > 0; i--) {
            var j = Math.floor(rnd() * (i + 1));
            var t = p[i];
            p[i] = p[j];
            p[j] = t;
        }
        for (var i = 0; i < PERM_SIZE * 2; i++)
            _cloudPerm[i] = p[i % PERM_SIZE];
    })(20240601);

    function _cloudFade(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }
    function _cloudLerp(a, b, t) {
        return a + t * (b - a);
    }
    function _cloudGrad2(hash, x, y) {
        switch (hash & 7) {
            case 0:
                return x + y;
            case 1:
                return -x + y;
            case 2:
                return x - y;
            case 3:
                return -x - y;
            case 4:
                return x;
            case 5:
                return -x;
            case 6:
                return y;
            default:
                return -y;
        }
    }

    function _perlin2(x, y) {
        var X = Math.floor(x) & 255,
            Y = Math.floor(y) & 255;
        var xf = x - Math.floor(x),
            yf = y - Math.floor(y);
        var u = _cloudFade(xf),
            v = _cloudFade(yf);
        var aa = _cloudPerm[_cloudPerm[X] + Y];
        var ab = _cloudPerm[_cloudPerm[X] + Y + 1];
        var ba = _cloudPerm[_cloudPerm[X + 1] + Y];
        var bb = _cloudPerm[_cloudPerm[X + 1] + Y + 1];
        var x1 = _cloudLerp(
            _cloudGrad2(aa, xf, yf),
            _cloudGrad2(ba, xf - 1, yf),
            u,
        );
        var x2 = _cloudLerp(
            _cloudGrad2(ab, xf, yf - 1),
            _cloudGrad2(bb, xf - 1, yf - 1),
            u,
        );
        return _cloudLerp(x1, x2, v);
    }

    function _cloudFbm(x, y, octaves, baseFreq, persistence, lacunarity) {
        var amp = 1,
            freq = baseFreq,
            sum = 0,
            norm = 0;
        for (var i = 0; i < octaves; i++) {
            sum += _perlin2(x * freq, y * freq) * amp;
            norm += amp;
            amp *= persistence;
            freq *= lacunarity;
        }
        return (sum / norm) * 0.5 + 0.5;
    }

    var _cloudNoiseSize = 1024;
    var _cloudNoiseMain = null;
    var _cloudNoiseThick = null;
    var _cloudNoiseGrain = null;

    function initCloudNoiseGrid() {
        if (_cloudNoiseMain) return;
        var S = _cloudNoiseSize;
        _cloudNoiseMain = new Float32Array(S * S);
        _cloudNoiseThick = new Float32Array(S * S);
        _cloudNoiseGrain = new Float32Array(S * S);
        var cfg = CLOUD_FX_CONFIG;
        for (var y = 0; y < S; y++) {
            for (var x = 0; x < S; x++) {
                var idx = y * S + x;
                _cloudNoiseMain[idx] = _cloudFbm(
                    x,
                    y,
                    cfg.octaves,
                    cfg.noiseScale,
                    cfg.persistence,
                    cfg.lacunarity,
                );
                _cloudNoiseThick[idx] = _cloudFbm(
                    x,
                    y,
                    3,
                    cfg.thicknessNoiseScale,
                    0.6,
                    2.0,
                );
                _cloudNoiseGrain[idx] = _perlin2(
                    x * cfg.grainScale,
                    y * cfg.grainScale,
                );
            }
        }
    }

    var CLOUD_FX_CONFIG = {
        noiseScale: 0.055,
        octaves: 4,
        persistence: 0.55,
        lacunarity: 2.05,
        coverageToThreshold: function (coverPct) {
            var t = Math.max(0, Math.min(1, coverPct / 100));
            return 0.9 - t * 0.82;
        },
        edgeFeather: 0.26,
        thicknessNoiseScale: 0.02,
        colorLit: { r: 255, g: 255, b: 255 },
        colorShadow: { r: 232, g: 235, b: 240 },
        maxAlpha: 255,
        alphaFloor: 0.72,
        grainScale: 0.35,
        grainStrength: 10,
    };

    initCloudNoiseGrid();

    function _sampleNoiseGrid(grid, x, y) {
        var ix = Math.floor(x) & (_cloudNoiseSize - 1);
        var iy = Math.floor(y) & (_cloudNoiseSize - 1);
        return grid[iy * _cloudNoiseSize + ix];
    }

    function cloudPixelColor(gx, gy, coverPct, cfg, out, outOffset) {
        cfg = cfg || CLOUD_FX_CONFIG;
        if (coverPct <= 0.5) return false;

        var threshold = cfg.coverageToThreshold(coverPct);
        var n = _sampleNoiseGrid(_cloudNoiseMain, gx, gy);

        if (n < threshold - cfg.edgeFeather) return false;

        var edgeT = (n - (threshold - cfg.edgeFeather)) / (cfg.edgeFeather * 2);
        edgeT = edgeT < 0 ? 0 : edgeT > 1 ? 1 : edgeT;
        var alphaShape = edgeT * edgeT * (3 - 2 * edgeT);

        var thick = _sampleNoiseGrid(_cloudNoiseThick, gx, gy);
        var coverT = coverPct / 100;
        coverT = coverT < 0 ? 0 : coverT > 1 ? 1 : coverT;
        var lightT = thick * 0.6 + coverT * 0.4;
        lightT = lightT < 0 ? 0 : lightT > 1 ? 1 : lightT;

        var grain =
            _sampleNoiseGrid(_cloudNoiseGrain, gx, gy) * cfg.grainStrength;

        var r =
            cfg.colorShadow.r +
            (cfg.colorLit.r - cfg.colorShadow.r) * lightT +
            grain;
        var g =
            cfg.colorShadow.g +
            (cfg.colorLit.g - cfg.colorShadow.g) * lightT +
            grain;
        var b =
            cfg.colorShadow.b +
            (cfg.colorLit.b - cfg.colorShadow.b) * lightT +
            grain;

        var a =
            alphaShape *
            cfg.maxAlpha *
            (cfg.alphaFloor + (1 - cfg.alphaFloor) * coverT);
        if (a <= 1) return false;

        out[outOffset] = r < 0 ? 0 : r > 255 ? 255 : r;
        out[outOffset + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        out[outOffset + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
        out[outOffset + 3] = a > 255 ? 255 : a;
        return true;
    }

    function bilinearSample(grid, cols, rows, x, y) {
        if (x < 0) x = 0;
        else if (x > cols - 1.001) x = cols - 1.001;
        if (y < 0) y = 0;
        else if (y > rows - 1.001) y = rows - 1.001;
        var x0 = x | 0,
            y0 = y | 0;
        var tx = x - x0,
            ty = y - y0;
        var idx0 = y0 * cols + x0;
        var idx1 = idx0 + cols;
        return (
            grid[idx0] * (1 - tx) * (1 - ty) +
            grid[idx0 + 1] * tx * (1 - ty) +
            grid[idx1] * (1 - tx) * ty +
            grid[idx1 + 1] * tx * ty
        );
    }

    var _cloudImgData = null;
    var _cloudImgW = 0,
        _cloudImgH = 0;

    function renderHighResCloud(
        canvas,
        grid,
        _shiftXGrid,
        _shiftYGrid,
        _easeT,
        cols,
        rows,
        globalTime,
    ) {
        initCloudNoiseGrid();
        var hrCols = cols * CLOUD_MULT;
        var hrRows = rows * CLOUD_MULT;
        if (canvas.width !== hrCols) canvas.width = hrCols;
        if (canvas.height !== hrRows) canvas.height = hrRows;

        var ctx = canvas.getContext("2d");
        if (!_cloudImgData || _cloudImgW !== hrCols || _cloudImgH !== hrRows) {
            _cloudImgData = ctx.createImageData(hrCols, hrRows);
            _cloudImgW = hrCols;
            _cloudImgH = hrRows;
        }
        var imgData = _cloudImgData;
        var data = imgData.data;
        data.fill(0);

        var driftX = (globalTime || 0) * 45.0;
        var driftY = (globalTime || 0) * 12.0;
        var cfg = CLOUD_FX_CONFIG;

        for (var hy = 0; hy < hrRows; hy++) {
            for (var hx = 0; hx < hrCols; hx++) {
                var lx = hx / CLOUD_MULT;
                var ly = hy / CLOUD_MULT;
                var coverPct = bilinearSample(grid, cols, rows, lx, ly);
                if (coverPct < 0.5) continue;

                var noiseX = (hx - driftX) / CLOUD_MULT;
                var noiseY = (hy - driftY) / CLOUD_MULT;
                var p = (hy * hrCols + hx) * 4;
                cloudPixelColor(noiseX, noiseY, coverPct, cfg, data, p);
            }
        }
        ctx.putImageData(imgData, 0, 0);
    }

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
    var STATION_TYPE_FALLBACK = {
        pv: "☀️",
        storage: "🔋",
        wind: "🌬️",
        hydro: "💧",
        default: "📍",
    };

    var stationConfig = [];
    var stationLayer = null;
    var showStationWeather = false;
    var currentHighlight = null;

    var METEO_CONFIG = {
        temp: {
            min: -30,
            max: 40,
            colors: [
                {
                    val: -30,
                    r: 30,
                    g: 0,
                    b: 140,
                    a: 255,
                    hex: "rgba(30,0,140,1)",
                },
                {
                    val: -20,
                    r: 60,
                    g: 10,
                    b: 180,
                    a: 250,
                    hex: "rgba(60,10,180,0.98)",
                },
                {
                    val: -10,
                    r: 30,
                    g: 70,
                    b: 220,
                    a: 248,
                    hex: "rgba(30,70,220,0.97)",
                },
                {
                    val: 0,
                    r: 20,
                    g: 180,
                    b: 200,
                    a: 248,
                    hex: "rgba(20,180,200,0.97)",
                },
                {
                    val: 10,
                    r: 80,
                    g: 200,
                    b: 70,
                    a: 250,
                    hex: "rgba(80,200,70,0.98)",
                },
                {
                    val: 20,
                    r: 255,
                    g: 220,
                    b: 0,
                    a: 252,
                    hex: "rgba(255,220,0,0.99)",
                },
                {
                    val: 30,
                    r: 255,
                    g: 130,
                    b: 0,
                    a: 252,
                    hex: "rgba(255,130,0,0.99)",
                },
                {
                    val: 40,
                    r: 210,
                    g: 0,
                    b: 30,
                    a: 255,
                    hex: "rgba(210,0,30,1)",
                },
            ],
        },
        rain: {
            min: 0.1,
            max: 50,
            colors: [
                {
                    val: 0.1,
                    r: 160,
                    g: 230,
                    b: 130,
                    a: 200,
                    hex: "rgba(160,230,130,0.78)",
                },
                {
                    val: 5,
                    r: 50,
                    g: 180,
                    b: 50,
                    a: 245,
                    hex: "rgba(50,180,50,0.96)",
                },
                {
                    val: 15,
                    r: 255,
                    g: 225,
                    b: 0,
                    a: 250,
                    hex: "rgba(255,225,0,0.98)",
                },
                {
                    val: 30,
                    r: 255,
                    g: 120,
                    b: 0,
                    a: 252,
                    hex: "rgba(255,120,0,0.99)",
                },
                { val: 50, r: 230, g: 0, b: 0, a: 255, hex: "rgba(230,0,0,1)" },
            ],
        },
        snow: {
            min: 0.1,
            max: 30,
            colors: [
                {
                    val: 0.1,
                    r: 180,
                    g: 150,
                    b: 200,
                    a: 230,
                    hex: "rgba(180,150,200,0.90)",
                },
                {
                    val: 2.5,
                    r: 190,
                    g: 120,
                    b: 180,
                    a: 240,
                    hex: "rgba(190,120,180,0.94)",
                },
                {
                    val: 5.0,
                    r: 210,
                    g: 90,
                    b: 160,
                    a: 248,
                    hex: "rgba(210,90,160,0.97)",
                },
                {
                    val: 10,
                    r: 200,
                    g: 40,
                    b: 110,
                    a: 252,
                    hex: "rgba(200,40,110,0.99)",
                },
                {
                    val: 20,
                    r: 140,
                    g: 0,
                    b: 70,
                    a: 255,
                    hex: "rgba(140,0,70,1)",
                },
                {
                    val: 30,
                    r: 80,
                    g: 0,
                    b: 110,
                    a: 255,
                    hex: "rgba(80,0,110,1)",
                },
            ],
        },
        windSpeed: {
            min: 0,
            max: 30,
            colors: [
                {
                    val: 0,
                    r: 110,
                    g: 200,
                    b: 100,
                    a: 0,
                    hex: "rgba(110,200,100,0)",
                },
                {
                    val: 2,
                    r: 110,
                    g: 200,
                    b: 100,
                    a: 215,
                    hex: "rgba(110,200,100,0.84)",
                },
                {
                    val: 5,
                    r: 30,
                    g: 160,
                    b: 70,
                    a: 245,
                    hex: "rgba(30,160,70,0.96)",
                },
                {
                    val: 10,
                    r: 255,
                    g: 220,
                    b: 0,
                    a: 246,
                    hex: "rgba(255,220,0,0.96)",
                },
                {
                    val: 15,
                    r: 255,
                    g: 140,
                    b: 0,
                    a: 250,
                    hex: "rgba(255,140,0,0.98)",
                },
                {
                    val: 20,
                    r: 240,
                    g: 80,
                    b: 40,
                    a: 252,
                    hex: "rgba(240,80,40,0.99)",
                },
                {
                    val: 25,
                    r: 200,
                    g: 30,
                    b: 50,
                    a: 255,
                    hex: "rgba(200,30,50,1)",
                },
                {
                    val: 30,
                    r: 120,
                    g: 0,
                    b: 30,
                    a: 255,
                    hex: "rgba(120,0,30,1)",
                },
            ],
        },
        pressure: {
            min: 500,
            max: 1000,
            colors: [
                {
                    val: 500,
                    r: 80,
                    g: 60,
                    b: 160,
                    a: 255,
                    hex: "rgba(80,60,160,1)",
                },
                {
                    val: 600,
                    r: 40,
                    g: 120,
                    b: 180,
                    a: 250,
                    hex: "rgba(40,120,180,0.98)",
                },
                {
                    val: 700,
                    r: 40,
                    g: 150,
                    b: 120,
                    a: 250,
                    hex: "rgba(40,150,120,0.98)",
                },
                {
                    val: 800,
                    r: 180,
                    g: 200,
                    b: 60,
                    a: 250,
                    hex: "rgba(180,200,60,0.98)",
                },
                {
                    val: 900,
                    r: 250,
                    g: 150,
                    b: 70,
                    a: 252,
                    hex: "rgba(250,150,70,0.99)",
                },
                {
                    val: 1000,
                    r: 200,
                    g: 50,
                    b: 70,
                    a: 255,
                    hex: "rgba(200,50,70,1)",
                },
            ],
        },
        humidity: {
            min: 0,
            max: 100,
            colors: [
                {
                    val: 0,
                    r: 100,
                    g: 50,
                    b: 5,
                    a: 250,
                    hex: "rgba(100,50,5,0.98)",
                },
                {
                    val: 25,
                    r: 190,
                    g: 130,
                    b: 60,
                    a: 245,
                    hex: "rgba(190,130,60,0.96)",
                },
                {
                    val: 55,
                    r: 220,
                    g: 200,
                    b: 150,
                    a: 242,
                    hex: "rgba(220,200,150,0.95)",
                },
                {
                    val: 75,
                    r: 30,
                    g: 130,
                    b: 125,
                    a: 250,
                    hex: "rgba(30,130,125,0.98)",
                },
                {
                    val: 100,
                    r: 0,
                    g: 80,
                    b: 70,
                    a: 252,
                    hex: "rgba(0,80,70,0.99)",
                },
            ],
        },
        radiation: {
            min: 0,
            max: 1000,
            colors: [
                { val: 0, r: 30, g: 0, b: 60, a: 255, hex: "rgba(30,0,60,1)" },
                {
                    val: 200,
                    r: 120,
                    g: 0,
                    b: 30,
                    a: 252,
                    hex: "rgba(120,0,30,0.99)",
                },
                {
                    val: 400,
                    r: 220,
                    g: 30,
                    b: 30,
                    a: 252,
                    hex: "rgba(220,30,30,0.99)",
                },
                {
                    val: 600,
                    r: 250,
                    g: 130,
                    b: 50,
                    a: 252,
                    hex: "rgba(250,130,50,0.99)",
                },
                {
                    val: 800,
                    r: 255,
                    g: 180,
                    b: 80,
                    a: 254,
                    hex: "rgba(255,180,80,1)",
                },
                {
                    val: 1000,
                    r: 255,
                    g: 250,
                    b: 180,
                    a: 255,
                    hex: "rgba(255,250,180,1)",
                },
            ],
        },
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
                {
                    val: 15,
                    r: 220,
                    g: 220,
                    b: 230,
                    a: 100,
                    hex: "rgba(220,220,230,0.4)",
                },
                {
                    val: 40,
                    r: 200,
                    g: 200,
                    b: 210,
                    a: 180,
                    hex: "rgba(200,200,210,0.7)",
                },
                {
                    val: 70,
                    r: 240,
                    g: 240,
                    b: 245,
                    a: 230,
                    hex: "rgba(240,240,245,0.9)",
                },
                {
                    val: 100,
                    r: 255,
                    g: 255,
                    b: 255,
                    a: 255,
                    hex: "rgba(255,255,255,1)",
                },
            ],
        },
        isobar: {
            interval: 10,
            lineColor: "rgba(20, 20, 20, 0.95)",
            lineWidth: 1.4,
            labelColor: "#0a0a0a",
        },
    };

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
        ["baseImagePane", "heatPane", "overlayPane"].forEach(
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
        var h = rawData[0].header;
        var nx = h.nx,
            ny = h.ny,
            lo1 = h.lo1,
            la1 = h.la1;
        var dx = h.dx != null ? h.dx : nx > 1 ? (h.lo2 - h.lo1) / (nx - 1) : 1;
        var dy = h.dy != null ? h.dy : ny > 1 ? (h.la1 - h.la2) / (ny - 1) : 1;
        var gi = Math.floor((lng - lo1) / dx);
        var gj = Math.floor((la1 - lat) / dy);
        if (gi < 0 || gi >= nx || gj < 0 || gj >= ny) return null;
        return rawData.map(function (comp) {
            return comp.data[gj * nx + gi];
        });
    }

    function interpolatePointValue(type, lat, lng) {
        var contours = cacheData.timeSeriesCmiss[currentTimeIndex];
        var points = extractPointsFromContours(type, contours);
        if (!points || points.length === 0) return null;
        var b = L.latLngBounds(MAP_CONFIG.bounds);
        var cosLat = Math.cos(
            (((b.getSouth() + b.getNorth()) / 2) * Math.PI) / 180,
        );
        var R = 5.0,
            R2 = R * R,
            smoothing = 0.05;
        var sumV = 0,
            sumW = 0,
            closestVal = null,
            minDist2 = Infinity;
        for (var i = 0; i < points.length; i++) {
            var p = points[i];
            var dl = (lng - p.lng) * cosLat,
                da = lat - p.lat;
            var d2 = dl * dl + da * da;
            if (d2 < minDist2) {
                minDist2 = d2;
                closestVal = p.value;
            }
            if (d2 > R2) continue;
            var w =
                type === "rain" || type === "snow"
                    ? 1.0 / Math.pow(d2 + smoothing, 3)
                    : 1.0 / (d2 + smoothing);
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
        _buildMask: function () {
            var b = L.latLngBounds(MAP_CONFIG.bounds);
            var west = b.getWest(),
                east = b.getEast(),
                south = b.getSouth(),
                north = b.getNorth();
            var cols = 240,
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
                    )
                        this._mask[gy * g.cols + gx] = 1;
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
            for (var i = 0; i < 220; i++)
                this._particles.push({
                    x: r.x + Math.random() * r.w,
                    y: r.y + Math.random() * r.h,
                    r: Math.random() * 2.5 + 1,
                    d: Math.random() * 20,
                });
        },
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
                for (var j = 0; j < ps.length; j++) {
                    var pj = ps[j];
                    pj.y += Math.cos(pj.d) + 1 + pj.r / 2;
                    pj.x += Math.sin(pj.d) * 1.5;
                    if (
                        pj.x > r.x + r.w + 5 ||
                        pj.x < r.x - 5 ||
                        pj.y > r.y + r.h
                    ) {
                        if (j % 3 > 0)
                            ps[j] = {
                                x: r.x + Math.random() * r.w,
                                y: r.y - 10,
                                r: pj.r,
                                d: pj.d,
                            };
                        else if (Math.sin(pj.d) > 0)
                            ps[j] = {
                                x: r.x - 5,
                                y: r.y + Math.random() * r.h,
                                r: pj.r,
                                d: pj.d,
                            };
                        else
                            ps[j] = {
                                x: r.x + r.w + 5,
                                y: r.y + Math.random() * r.h,
                                r: pj.r,
                                d: pj.d,
                            };
                    }
                }
            }
            this._raf = requestAnimationFrame(this._animate.bind(this));
        },
    });

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
        _buildMask: function () {
            var b = L.latLngBounds(MAP_CONFIG.bounds);
            var west = b.getWest(),
                east = b.getEast(),
                south = b.getSouth(),
                north = b.getNorth();
            var cols = 240,
                rows = Math.ceil(cols * ((north - south) / (east - west)));
            this._grid = computeFloatGrid(
                this._points,
                "rain",
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
                    )
                        this._mask[gy * g.cols + gx] = 1;
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
                var slant = 0.22;
                ctx.beginPath();
                ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
                ctx.lineWidth = 0.8;
                for (var i = 0; i < ps.length; i++) {
                    var p = ps[i];
                    if (p.w > 1) continue;
                    if (
                        this._isRaining(p.x, p.y) &&
                        this._isRaining(p.x + p.len * slant, p.y + p.len)
                    ) {
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
                    if (
                        this._isRaining(q.x, q.y) &&
                        this._isRaining(q.x + q.len * slant, q.y + q.len)
                    ) {
                        ctx.moveTo(q.x, q.y);
                        ctx.lineTo(q.x + q.len * slant, q.y + q.len);
                    }
                }
                ctx.stroke();
                for (var si = sp.length - 1; si >= 0; si--) {
                    var s = sp[si];
                    var alpha = s.life / s.maxLife;
                    ctx.beginPath();
                    ctx.strokeStyle =
                        "rgba(255, 255, 255, " + (alpha * 0.7).toFixed(2) + ")";
                    ctx.lineWidth = 1;
                    ctx.arc(
                        s.x,
                        s.y,
                        s.radius * (1 - alpha * 0.3),
                        -Math.PI,
                        0,
                        false,
                    );
                    ctx.stroke();
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
                    var w =
                        type === "rain" || type === "snow"
                            ? 1.0 / Math.pow(d2 + smoothing, 3)
                            : 1.0 / (d2 + smoothing);
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
            east = bounds.getEast(),
            south = bounds.getSouth(),
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

        if (type === "cloud") {
            renderHighResCloud(
                displayCanvas,
                grid,
                null,
                null,
                0,
                cols,
                rows,
                currentTimeIndex,
            );
            return;
        }

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
        var blendMode = type === "cloud" ? "normal" : "multiply";

        var layer = new CanvasOverlay(displayCanvas, bounds, {
            opacity: type === "cloud" ? 0.92 : 1.0,
            pane: "baseImagePane",
            mixBlendMode: blendMode,
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

    function buildStationPopupHtml(st) {
        var typeKey =
            st.type && STATION_TYPE_ICON[st.type] ? st.type : "default";
        var html = '<div class="popup-title">📍 ' + (st.name || "") + "</div>";
        html +=
            '<div class="popup-row">🏷️ 类型: ' +
            (STATION_TYPE_LABEL[typeKey] || typeKey) +
            "</div>";
        html +=
            '<div class="popup-row">🧭 经纬度: ' +
            (+st.lat).toFixed(3) +
            "°N, " +
            (+st.lng).toFixed(3) +
            "°E</div>";
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
            var typeKey =
                st.type && STATION_TYPE_ICON[st.type] ? st.type : "default";
            var iconUrl = STATION_TYPE_ICON[typeKey];
            var fallback =
                STATION_TYPE_FALLBACK[typeKey] || STATION_TYPE_FALLBACK.default;
            var html =
                '<div class="wm-station"><div class="wm-station-icon" data-fallback="' +
                fallback +
                '">' +
                '<img class="wm-station-pic" src="' +
                iconUrl +
                '" alt="' +
                (st.name || "") +
                "\" onerror=\"this.style.display='none';this.parentNode.classList.add('is-fallback')\" />";
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
                '</div><div class="wm-station-name">' +
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
                pane: "stationPane",
            });
            marker._stationGroup = st.group || "";
            marker.bindPopup(
                function () {
                    return buildStationPopupHtml(st);
                },
                { className: "weather-popup", maxWidth: 240 },
            );
            markers.push(marker);
        });
        return L.layerGroup(markers);
    }

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
                applyHighlight();
            }
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
        var contours =
            cacheData.timeSeriesCmiss.length > 0
                ? cacheData.timeSeriesCmiss[timeIndex]
                : null;
        if (!contours) return [];
        var list = [];
        contours.forEach(function (s) {
            var speed = s[5],
                dir = s[6];
            if (speed == null || speed === 9999 || dir == null || dir === 9999)
                return;
            list.push({ lat: s[2], lng: s[1], speed: speed, dir: dir });
        });
        return list;
    }

    function buildStationWindField(stations) {
        if (!stations || !stations.length) return null;
        var b = MAP_CONFIG.bounds;
        var south = b[0][0],
            west = b[0][1],
            north = b[1][0],
            east = b[1][1];
        var step = 0.5;
        var cols = Math.round((east - west) / step) + 1,
            rows = Math.round((north - south) / step) + 1;
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

    function buildWeatherLayer(type) {
        if (type === "weather") return buildWeatherIconLayer();
        if (type === "snow") {
            var compositeGroup = L.layerGroup();
            var currentContours =
                cacheData.timeSeriesCmiss.length > 0
                    ? cacheData.timeSeriesCmiss[currentTimeIndex]
                    : null;
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
            var rainContours =
                cacheData.timeSeriesCmiss.length > 0
                    ? cacheData.timeSeriesCmiss[currentTimeIndex]
                    : null;
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
            var built = buildStationWindField(
                extractWindStations(currentTimeIndex),
            );
            if (built) {
                cacheData.gfs = built.uv;
                var heatLayer = createPerformanceIdwLayer(
                    built.speed,
                    "windSpeed",
                );
                compositeGroup.heatLayer = heatLayer;
                compositeGroup.addLayer(heatLayer);
                if (!globalVelLayer) globalVelLayer = createVelLayer(built.uv);
                else if (globalVelLayer.setData)
                    globalVelLayer.setData(built.uv);
                if (globalVelLayer) {
                    compositeGroup.velLayer = globalVelLayer;
                    compositeGroup.addLayer(globalVelLayer);
                }
            }
            compositeGroup.points = built ? built.speed : [];
            return compositeGroup;
        }
        if (type === "isobar") {
            var compositeGroup = L.layerGroup();
            var pressureContours =
                cacheData.timeSeriesCmiss.length > 0
                    ? cacheData.timeSeriesCmiss[currentTimeIndex]
                    : null;
            var pressurePoints = extractPointsFromContours(
                "pressure",
                pressureContours,
            );
            if (pressurePoints && pressurePoints.length > 0) {
                var heatLayer = createPerformanceIdwLayer(
                    pressurePoints,
                    "pressure",
                );
                compositeGroup.heatLayer = heatLayer;
                compositeGroup.addLayer(heatLayer);
                var contourLayer = createContourVectorLayer(pressurePoints);
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
        if (map) map.closePopup();
        var wasActive =
            !!mapLayersCache[type] &&
            map._layers[mapLayersCache[type]._leaflet_id];
        var willBeActive =
            typeof forceState === "boolean" ? forceState : !wasActive;
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
                if (isPlaying) {
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
                }
                currentTimeIndex = findNearestStepIndex(new Date());
                renderSingleFrame(type, currentTimeIndex);
                setParticleFxVisible(true);
                notifyTimeChange();
            } else if (isPlaying) {
                setParticleFxVisible(false);
            }
            if (window.updateLegendUI)
                window.updateLegendUI(type, METEO_CONFIG);
            return true;
        }
        return wasActive;
    }

    function activeElementRows(lat, lng) {
        function check(v) {
            return (
                v !== undefined &&
                v !== null &&
                v !== 9999 &&
                v !== 999999 &&
                v !== -9999 &&
                v !== -999 &&
                !isNaN(v)
            );
        }
        function fmt(v, d) {
            return (+v).toFixed(d == null ? 1 : d);
        }
        var rows = [];
        var activeType = getActiveLayerType();
        if (activeType === "temp") {
            var t = interpolatePointValue("temp", lat, lng);
            if (check(t))
                rows.push(
                    '<div class="popup-row">🌡️ <b>气温:</b> ' +
                        fmt(t, 1) +
                        "°C</div>",
                );
        } else if (activeType === "rain") {
            var r = interpolatePointValue("rain", lat, lng);
            if (check(r))
                rows.push(
                    '<div class="popup-row">💧 <b>降水:</b> ' +
                        fmt(r, 2) +
                        " mm</div>",
                );
        } else if (activeType === "snow") {
            var sn = interpolatePointValue("snow", lat, lng);
            if (check(sn))
                rows.push(
                    '<div class="popup-row">❄️ <b>降雪量:</b> ' +
                        fmt(sn, 2) +
                        " mm</div>",
                );
        } else if (activeType === "wind" || activeType === "windSpeed") {
            var ws = interpolatePointValue("windSpeed", lat, lng);
            if (check(ws))
                rows.push(
                    '<div class="popup-row">🌪 <b>实况风速:</b> ' +
                        fmt(ws, 1) +
                        " m/s</div>",
                );
            if (!isPlaying && cacheData.gfs && cacheData.gfs.length >= 2) {
                var v = getGridValueAt(cacheData.gfs, lat, lng);
                if (v && v[0] != null && v[1] != null) {
                    var speed = Math.sqrt(v[0] * v[0] + v[1] * v[1]).toFixed(1),
                        dir = (
                            ((Math.atan2(-v[0], -v[1]) * 180) / Math.PI + 360) %
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
        } else if (activeType === "pressure" || activeType === "isobar") {
            var ps = interpolatePointValue("pressure", lat, lng);
            if (check(ps))
                rows.push(
                    '<div class="popup-row">⏱ <b>气压:</b> ' +
                        fmt(ps, 1) +
                        " hPa</div>",
                );
        } else if (activeType === "humidity") {
            var rh = interpolatePointValue("humidity", lat, lng);
            if (check(rh))
                rows.push(
                    '<div class="popup-row">💧 <b>相对湿度:</b> ' +
                        fmt(rh, 0) +
                        " %</div>",
                );
        } else if (activeType === "radiation") {
            var rad = interpolatePointValue("radiation", lat, lng);
            if (check(rad))
                rows.push(
                    '<div class="popup-row">☀️ <b>太阳辐射:</b> ' +
                        fmt(rad, 0) +
                        " W/m²</div>",
                );
        } else if (activeType === "cloud") {
            var cl = interpolatePointValue("cloud", lat, lng);
            if (check(cl))
                rows.push(
                    '<div class="popup-row">☁️ <b>总云量:</b> ' +
                        fmt(cl, 0) +
                        " %</div>",
                );
        }
        return rows;
    }

    function bindMapPopup() {
        map.on("click", function (e) {
            var lat = e.latlng.lat,
                lng = e.latlng.lng;
            if (!isInsideQinghai(lat, lng)) return;
            function isOn(t) {
                var l = mapLayersCache[t];
                return !!l && !!map._layers[l._leaflet_id];
            }
            var near = findNearestStation(lat, lng);
            var stationName = "";
            if (near && near[27]) {
                var ddeg = Math.sqrt(
                    (near[1] - lng) * (near[1] - lng) +
                        (near[2] - lat) * (near[2] - lat),
                );
                if (ddeg < 0.02) stationName = near[27];
            }
            var rows = activeElementRows(lat, lng);
            if (getActiveLayerType() == null && isOn("weather")) {
                var st = findNearestStation(lat, lng);
                if (st && st[4] != null) {
                    var wx = WEATHER_ICONS[String(st[4])];
                    if (wx)
                        rows.push(
                            '<div class="popup-row">🌤️ <b>天气:</b> ' +
                                wx.label +
                                "</div>",
                        );
                }
            }
            var title = stationName
                ? "📍 " +
                  stationName +
                  "  ·  " +
                  lat.toFixed(2) +
                  "°N, " +
                  lng.toFixed(2) +
                  "°E"
                : "📍 " + lat.toFixed(2) + "°N, " + lng.toFixed(2) + "°E";
            var html =
                '<div class="popup-title">' + title + "</div>" + rows.join("");
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

    var MOJICB_ELEM_MAP = {
        WEATHER: {
            s: 4,
            conv: function (v) {
                return String(v);
            },
        },
        TT2: {
            s: 19,
            conv: function (v) {
                return +(+v).toFixed(1);
            },
        },
        WS: {
            s: 5,
            conv: function (v) {
                return +(+v).toFixed(1);
            },
        },
        RAIN: {
            s: 12,
            conv: function (v) {
                return +(+v).toFixed(2);
            },
        },
        SNOW: {
            s: 12,
            conv: function (v) {
                return +(+v).toFixed(2);
            },
        },
        PS: {
            s: 8,
            conv: function (v) {
                return +(+v / 100).toFixed(1);
            },
        },
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
            if (raw === null || raw === undefined || raw === "" || isNaN(raw))
                continue;
            s[MOJICB_ELEM_MAP[elem].s] = MOJICB_ELEM_MAP[elem].conv(raw);
        }
        s[27] = (+lat).toFixed(2) + "," + (+lng).toFixed(2);
        return s;
    }

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
        var nTime = multi ? (values[0] ? values[0].length : 0) : values.length;
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
        cacheData.cmiss = CMISS_DATA;
        var resGeo = QINGHAI_GEO;
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

    var _loadingDepth = 0,
        _loadingMask = null,
        _interactSaved = null;
    var _INTERACT_HANDLERS = [
        "dragging",
        "scrollWheelZoom",
        "doubleClickZoom",
        "boxZoom",
        "keyboard",
        "touchZoom",
    ];

    function _disableInteract() {
        if (!map || _interactSaved) return;
        _interactSaved = {};
        _INTERACT_HANDLERS.forEach(function (name) {
            var h = map[name];
            if (h && typeof h.enabled === "function") {
                _interactSaved[name] = h.enabled();
                if (_interactSaved[name]) h.disable();
            }
        });
    }

    function _restoreInteract() {
        if (!map || !_interactSaved) return;
        _INTERACT_HANDLERS.forEach(function (name) {
            var h = map[name];
            if (h && _interactSaved[name] && typeof h.enable === "function")
                h.enable();
        });
        _interactSaved = null;
    }

    function _ensureLoadingMask() {
        if (_loadingMask) return _loadingMask;
        var c = map
            ? map.getContainer()
            : document.getElementById("weather-map");
        if (!c) return null;
        _loadingMask = document.createElement("div");
        _loadingMask.className = "wm-loading-mask";
        _loadingMask.innerHTML =
            '<div class="wm-loading-box"><div class="wm-loading-spinner"></div><div class="wm-loading-text">加载中…</div></div>';
        var block = function (e) {
            e.stopPropagation();
            e.preventDefault();
        };
        [
            "mousedown",
            "mousemove",
            "mouseup",
            "click",
            "dblclick",
            "contextmenu",
        ].forEach(function (ev) {
            _loadingMask.addEventListener(ev, block);
        });
        ["wheel", "touchstart", "touchmove", "touchend"].forEach(function (ev) {
            _loadingMask.addEventListener(ev, block, { passive: false });
        });
        c.appendChild(_loadingMask);
        return _loadingMask;
    }

    function showLoading() {
        var first = _loadingDepth === 0;
        _loadingDepth++;
        var m = _ensureLoadingMask();
        if (m) {
            if (first) void m.offsetWidth;
            m.classList.add("is-visible");
        }
        if (first) _disableInteract();
        return api;
    }

    function hideLoading() {
        if (_loadingDepth > 0) _loadingDepth--;
        if (_loadingDepth === 0) {
            if (_loadingMask) _loadingMask.classList.remove("is-visible");
            _restoreInteract();
        }
        return api;
    }

    function refreshCmissData(callbacks) {
        callbacks = callbacks || {};
        var showL = callbacks.loading !== false;
        if (showL) showLoading();
        try {
            cacheData.cmiss = CMISS_DATA;
            rebuildTimeSeries();
            clearFrameCache();
            currentTimeIndex = findNearestStepIndex(new Date());
            clearActiveLayers();
            if (typeof callbacks.onLoad === "function") callbacks.onLoad();
        } catch (err) {
            if (typeof callbacks.onError === "function")
                callbacks.onError((err && err.message) || String(err));
            else console.error("[refreshCmissData]", err);
        } finally {
            if (showL) hideLoading();
        }
        return api;
    }

    function pad2(n) {
        n = +n;
        return (n < 10 ? "0" : "") + n;
    }
    function formatStepDate(date) {
        if (date == null) return "";
        var d = new Date(date);
        if (isNaN(d.getTime())) return String(date);
        return (
            d.getFullYear() +
            "-" +
            pad2(d.getMonth() + 1) +
            "-" +
            pad2(d.getDate()) +
            " " +
            pad2(d.getHours()) +
            ":" +
            pad2(d.getMinutes())
        );
    }
    function stepDateToDate(date) {
        if (date == null) return null;
        var d = new Date(date);
        return isNaN(d.getTime()) ? null : d;
    }
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
        if (typeof _onTimeChange === "function") {
            _onTimeChange({
                timeIndex: currentTimeIndex,
                timeLabel: timeSteps[currentTimeIndex],
                isPlaying: isPlaying,
                totalSteps: timeSteps.length,
                progress: typeof progress === "number" ? progress : null,
            });
        }
    }

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

    function getCachedFrame(type, timeIndex) {
        if (!frameCache[type]) frameCache[type] = { frames: {} };
        var slot = frameCache[type];
        if (!slot.frames[timeIndex]) {
            // Note: For sync fallback if something breaks (should not be hit in normal playback anymore)
            // Need a fast path to synchronously compute it if dragged
            var f = computeFloatGridAndRGBA(type, timeIndex);
            slot.cols = f.cols;
            slot.rows = f.rows;
            slot.resolveType = f.resolveType;
            slot.frames[timeIndex] = { rgba: f.rgba, grid: f.grid };
        }
        return slot;
    }

    function computeFloatGridAndRGBA(type, timeIndex) {
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

        var rgba = null;
        if (type !== "cloud") {
            rgba = new Uint8ClampedArray(cols * rows * 4);
            var lutData = getFastLUT(resolveType);
            if (lutData) {
                var lut = lutData.lut,
                    lMin = lutData.min,
                    lMax = lutData.max,
                    lSteps = lutData.steps;
                var span = lMax - lMin || 1;
                for (var i = 0, n = cols * rows; i < n; i++) {
                    var ratio = (grid[i] - lMin) / span;
                    if (ratio < 0) ratio = 0;
                    else if (ratio > 1) ratio = 1;
                    var lutIdx = ((ratio * (lSteps - 1)) | 0) * 4;
                    rgba[i * 4] = lut[lutIdx];
                    rgba[i * 4 + 1] = lut[lutIdx + 1];
                    rgba[i * 4 + 2] = lut[lutIdx + 2];
                    rgba[i * 4 + 3] = lut[lutIdx + 3];
                }
            } else {
                for (var j = 0, len = cols * rows; j < len; j++) {
                    var c = getIdwColor(resolveType, grid[j]);
                    rgba[j * 4] = c.r;
                    rgba[j * 4 + 1] = c.g;
                    rgba[j * 4 + 2] = c.b;
                    rgba[j * 4 + 3] = c.a;
                }
            }
        }
        return {
            rgba: rgba,
            grid: grid,
            cols: cols,
            rows: rows,
            resolveType: resolveType,
        };
    }

    var _colorLUTs = {};
    function getFastLUT(type) {
        if (_colorLUTs[type]) return _colorLUTs[type];
        var config = METEO_CONFIG[type];
        if (!config || !config.colors) return null;
        var min = config.min !== undefined ? config.min : config.colors[0].val;
        if (type === "rain" || type === "snow") min = 0;
        var max =
            config.max !== undefined
                ? config.max
                : config.colors[config.colors.length - 1].val;
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

    function clearFrameCache(type) {
        if (type == null) frameCache = {};
        else delete frameCache[type];
    }

    function trimFrameCache(type, centerIdx) {
        var slot = frameCache[type];
        var keepAhead = CLOUD_PREFETCH_AHEAD + 4;
        var keepBehind = 4;

        for (var i = _prefetchQueue.length - 1; i >= 0; i--) {
            var task = _prefetchQueue[i];
            if (
                task.type === type &&
                (task.idx < centerIdx - keepBehind ||
                    task.idx > centerIdx + keepAhead)
            ) {
                delete _prefetchPending[task.key];
                _prefetchQueue.splice(i, 1);
            }
        }

        if (!slot) return;
        Object.keys(slot.frames).forEach(function (k) {
            var ki = parseInt(k, 10);
            if (ki < centerIdx - keepBehind || ki > centerIdx + keepAhead) {
                delete slot.frames[k];
            }
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
        var resolveType = slot.resolveType;

        var easeT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        var fromGrid = from.grid,
            toGrid = to.grid;
        var globalTime = fromIdx === toIdx ? fromIdx : fromIdx + t;

        if (type === "cloud") {
            var n = cols * rows;
            if (!_cloudIntermediateGrid || _cloudShiftGridSize !== n) {
                _cloudIntermediateGrid = new Float32Array(n);
                _cloudShiftGridSize = n;
            }
            var intermediateGrid = _cloudIntermediateGrid;
            for (var i = 0; i < n; i++) {
                intermediateGrid[i] =
                    fromGrid[i] + (toGrid[i] - fromGrid[i]) * easeT;
            }
            renderHighResCloud(
                canvas,
                intermediateGrid,
                null,
                null,
                easeT,
                cols,
                rows,
                globalTime,
            );
            return;
        }

        if (canvas.width !== cols) {
            canvas.width = cols;
            _blendImgData = null;
        }
        if (canvas.height !== rows) {
            canvas.height = rows;
            _blendImgData = null;
        }

        var ctx = canvas.getContext("2d");
        if (
            !_blendImgData ||
            _blendImgData.width !== cols ||
            _blendImgData.height !== rows
        ) {
            _blendImgData = ctx.createImageData(cols, rows);
        }
        var data = _blendImgData.data;

        if (t <= 0) {
            data.set(from.rgba);
        } else if (t >= 1) {
            data.set(to.rgba);
        } else {
            var lutData = getFastLUT(resolveType);
            if (!lutData) return;
            var maxShift = 18.0;
            var epsilon = 0.2;
            var isBinary = type === "rain" || type === "snow";

            for (var y = 0; y < rows; y++) {
                for (var x = 0; x < cols; x++) {
                    var idx = y * cols + x;
                    var p = idx * 4;

                    var xL = x > 0 ? x - 1 : 0;
                    var xR = x < cols - 1 ? x + 1 : cols - 1;
                    var yT = y > 0 ? y - 1 : 0;
                    var yB = y < rows - 1 ? y + 1 : rows - 1;

                    var vA = fromGrid[idx],
                        vB = toGrid[idx];
                    var diff = vB - vA;

                    var dx =
                        (fromGrid[y * cols + xR] -
                            fromGrid[y * cols + xL] +
                            (toGrid[y * cols + xR] - toGrid[y * cols + xL])) *
                        0.25;
                    var dy =
                        (fromGrid[yB * cols + x] -
                            fromGrid[yT * cols + x] +
                            (toGrid[yB * cols + x] - toGrid[yT * cols + x])) *
                        0.25;

                    var magSq = dx * dx + dy * dy + epsilon;
                    var gradMag = Math.sqrt(magSq - epsilon);
                    var shiftScale = isBinary
                        ? 1.0
                        : ADV_SHIFT_SCALE *
                          (gradMag / (gradMag + ADV_GRAD_REF));
                    var shiftX = (-(diff * dx) / magSq) * shiftScale;
                    var shiftY = (-(diff * dy) / magSq) * shiftScale;

                    var shiftLen = Math.sqrt(shiftX * shiftX + shiftY * shiftY);
                    var shiftCap = isBinary ? maxShift : maxShift * 2;
                    if (shiftLen > shiftCap) {
                        shiftX = (shiftX / shiftLen) * shiftCap;
                        shiftY = (shiftY / shiftLen) * shiftCap;
                    }

                    var valA = bilinearSample(
                        fromGrid,
                        cols,
                        rows,
                        x - easeT * shiftX,
                        y - easeT * shiftY,
                    );
                    var valB = bilinearSample(
                        toGrid,
                        cols,
                        rows,
                        x + (1 - easeT) * shiftX,
                        y + (1 - easeT) * shiftY,
                    );

                    var currVal = valA * (1 - easeT) + valB * easeT;
                    var _vLo = vA < vB ? vA : vB,
                        _vHi = vA < vB ? vB : vA;
                    if (currVal < _vLo) currVal = _vLo;
                    else if (currVal > _vHi) currVal = _vHi;

                    var ratio =
                        (currVal - lutData.min) / (lutData.max - lutData.min);
                    if (ratio < 0) ratio = 0;
                    else if (ratio > 1) ratio = 1;
                    var lutIdx = ((ratio * (lutData.steps - 1)) | 0) * 4;

                    data[p] = lutData.lut[lutIdx];
                    data[p + 1] = lutData.lut[lutIdx + 1];
                    data[p + 2] = lutData.lut[lutIdx + 2];
                    data[p + 3] = lutData.lut[lutIdx + 3];
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
        setTimeout(function () {
            if (mapLayersCache[type] !== layer) return;
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
            var prevGlobal = cl.globalData;
            cl.globalData = gData;
            cl._nextGlobal = gData;
            cl._nextTiles = {};
            cl._nextReady = false;
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
        var nt = cl._nextTiles,
            tiles = cl._tiles;
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

        renderBlendedFrame(type, idx, idx, 1);
        var pts = getLayerPointsAt(type, idx);
        if (layer.points) layer.points = pts;
        var heatLayer = layer.heatLayer ? layer.heatLayer : layer;
        if (heatLayer.points) heatLayer.points = pts;

        if (layer.contourLayer) {
            layer.contourLayer.points = pts;
            if (layer.contourLayer.smoothRedraw)
                layer.contourLayer.smoothRedraw();
        }
        if (layer.rainFx) layer.rainFx.setData(pts);
        if (layer.snowFx) layer.snowFx.setData(pts);

        if ((type === "wind" || type === "windSpeed") && globalVelLayer) {
            var built = buildStationWindField(extractWindStations(idx));
            if (built) {
                cacheData.gfs = built.uv;
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
                if (!fx._raf && typeof fx._animate === "function")
                    fx._animate();
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
                if (globalVelLayer._windy && globalVelLayer._clearAndRestart)
                    globalVelLayer._clearAndRestart();
            } else {
                if (globalVelLayer._timer) {
                    clearTimeout(globalVelLayer._timer);
                    globalVelLayer._timer = null;
                }
                if (globalVelLayer._windy && globalVelLayer._windy.stop)
                    globalVelLayer._windy.stop();
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
        renderSingleFrame(getActiveLayerType(), currentTimeIndex);
        setParticleFxVisible(true);
        notifyTimeChange();
    }

    function playLoop() {
        if (!isPlaying) return;

        var now = performance.now();
        var activeType = getActiveLayerType();
        var isReady = true;

        // === 【关键防御：视频级缓冲机制】 ===
        if (activeType) {
            var slot = frameCache[activeType];
            if (
                !slot ||
                !slot.frames[playState.fromIdx] ||
                !slot.frames[playState.toIdx]
            ) {
                isReady = false;
            }
        }

        if (!isReady) {
            if (activeType) ensurePrefetchQueue(activeType, playState.fromIdx);
            playState.stepStart += now - (playState.lastFrameTime || now);
            playState.lastFrameTime = now;
            playbackRaf = requestAnimationFrame(playLoop);
            return;
        }

        playState.lastFrameTime = now;
        var t = Math.min(1, (now - playState.stepStart) / PLAY_STEP_MS);

        if (activeType) {
            renderBlendedFrame(
                activeType,
                playState.fromIdx,
                playState.toIdx,
                t,
            );
            syncSubLayers(activeType, playState, t);
        }

        var progress =
            timeSteps.length > 1
                ? (currentTimeIndex + t) / (timeSteps.length - 1)
                : 0;
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
            playState.lastFrameTime = now;
            playState.lastHalf = false;

            if (activeType) {
                ensurePrefetchQueue(activeType, playState.toIdx);
                trimFrameCache(activeType, currentTimeIndex);
            }
            precomputeContourNext(activeType, playState.toIdx);
        }
        playbackRaf = requestAnimationFrame(playLoop);
    }

    function startPlayback() {
        if (timeSteps.length <= 1) return;
        if (currentTimeIndex >= timeSteps.length - 1) {
            currentTimeIndex = 0;
        }
        isPlaying = true;
        setParticleFxVisible(false);
        notifyTimeChange();
        var activeType = getActiveLayerType();
        if (activeType) {
            getCachedFrame(activeType, currentTimeIndex);
            if (currentTimeIndex + 1 < timeSteps.length)
                getCachedFrame(activeType, currentTimeIndex + 1);
            ensurePrefetchQueue(activeType, currentTimeIndex + 1);
        }
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
        if (isPlaying && currentTimeIndex < timeSteps.length - 1) {
            var activeType = getActiveLayerType();
            if (activeType) {
                getCachedFrame(activeType, currentTimeIndex);
                if (currentTimeIndex + 1 < timeSteps.length)
                    getCachedFrame(activeType, currentTimeIndex + 1);
                ensurePrefetchQueue(activeType, currentTimeIndex + 1);
            }
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
        }
    }

    // 暴露核心 API
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
        toggleLayer: toggleLayer,
        fetchAllRealData: fetchAllRealData,
        togglePlayback: togglePlayback,
        onSliderChange: onSliderChange,
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
        showLoading: function () {
            return showLoading();
        },
        hideLoading: function () {
            return hideLoading();
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