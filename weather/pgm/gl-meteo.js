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
