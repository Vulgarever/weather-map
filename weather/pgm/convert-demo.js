/**
 * 墨迹 EC1x1 原始数据 → 前端渲染数据 转换 demo（Node.js 参考实现）
 * 后端可用任意语言（Java/Python/Go...）照搬这套逻辑。
 *
 * 输入：墨迹单点查询响应数组（data.values[时间][要素]，data.elems 决定第二维顺序）
 * 输出：{ timeLabels, perTimeContours, windGrid } —— 前端拿到直接渲染，零处理
 *
 * 运行： node convert-demo.js
 */
'use strict';

/* ============================================================
 * 1. 模拟「后端从墨迹接口拿到的原始数据」
 *    假设对青海西北角附近的 2 个采样点查询墨迹（实际后端查全部 ~448 个网格点）。
 *    每个点返回标准单点响应：values[t] = [TT2, RAIN, WS, WD, PS, WEATHER]
 *    （顺序对齐 elems；us=1 使 RAIN 已是 mm）
 * ============================================================ */
var mojicbPointResponses = [
    {
        data: {
            lat: 39.3,
            lng: 89.4,
            timeSeries: ['202107142000', '202107142100'],
            elems: ['TT2', 'RAIN', 'WS', 'WD', 'PS', 'WEATHER'],
            values: [
                [26.0, 0, 3.2, 45, 94200, 1], // t=0: 26℃ / 无雨 / 3.2m/s / 风向45° / 94200Pa / 晴
                [25.0, 0.5, 3.0, 90, 94150, 8], // t=1: 25℃ / 0.5mm / 3.0m/s / 风向90° / 94150Pa / 多云
            ],
        },
    },
    {
        data: {
            lat: 39.3,
            lng: 89.9,
            timeSeries: ['202107142000', '202107142100'],
            elems: ['TT2', 'RAIN', 'WS', 'WD', 'PS', 'WEATHER'],
            values: [
                [24.0, 0, 4.0, 180, 94000, 8],
                [23.0, 1.2, 3.5, 225, 93950, 13],
            ],
        },
    },
];

/* 青海采样网格元信息（后端按实际网格填；header 必填字段） */
var gridMeta = {
    nx: 28,
    ny: 16, // 经度格点数 / 纬度格点数
    lo1: 89.4,
    la1: 39.3, // 西北角起点（经度, 纬度）
    lo2: 103.2,
    la2: 31.5, // 东南角
    dx: 0.5,
    dy: 0.5,
};

/* ============================================================
 * 2. 转换工具函数
 * ============================================================ */

/* yyyyMMddHHmm → "MM月dd日 HH:mm" */
function fmtTime(ts) {
    ts = String(ts);
    return (
        ts.substr(4, 2) +
        '月' +
        ts.substr(6, 2) +
        '日 ' +
        ts.substr(8, 2) +
        ':' +
        ts.substr(10, 2)
    );
}

/* WS/WD 标量 → u/v 分量（WD 为「风来的方向」，0=北、顺时针） */
function windToUV(ws, wd) {
    var rad = (wd * Math.PI) / 180;
    return { u: -ws * Math.sin(rad), v: -ws * Math.cos(rad) };
}

/* 一行墨迹要素值 → 28 位 cmiss s[] 站点数组 */
function rowToStation(lat, lng, row, elemIdx) {
    var s = new Array(28).fill(9999);
    s[0] = 'mj_' + (+lat).toFixed(3) + '_' + (+lng).toFixed(3);
    s[1] = +lng;
    s[2] = +lat;
    s[26] = false;
    s[27] = (+lat).toFixed(2) + ',' + (+lng).toFixed(2);

    function put(elem, idx, fn) {
        var i = elemIdx[elem];
        var v = i === undefined ? undefined : row[i];
        if (v === null || v === undefined || v === '' || isNaN(v)) return;
        s[idx] = fn ? fn(v) : v;
    }
    put('WEATHER', 4, function (v) {
        return String(v);
    });
    put('WS', 5);
    put('PS', 8, function (v) {
        return +(v / 100).toFixed(1);
    }); // Pa → hPa
    put('RAIN', 12); // us=1 已是 mm
    put('TT2', 19);
    return s;
}

/* ============================================================
 * 3. 主转换：多点墨迹响应 → 前端成品
 *    注意：pointResponses 必须按「网格行优先」顺序排列
 *    （从西北角起，先经度向东、再纬度向南），与 windGrid.data 一一对应。
 * ============================================================ */
function transform(pointResponses, gridMeta) {
    var first = pointResponses[0].data;
    var timeSeries = first.timeSeries;
    var elems = first.elems;
    var elemIdx = {};
    elems.forEach(function (e, i) {
        elemIdx[e] = i;
    });

    var nTime = timeSeries.length;
    var nPts = pointResponses.length;

    /* ① perTimeContours：每个时间步一份站点数组 */
    var perTimeContours = [];
    for (var t = 0; t < nTime; t++) {
        var step = [];
        for (var p = 0; p < nPts; p++) {
            var d = pointResponses[p].data;
            step.push(rowToStation(d.lat, d.lng, d.values[t], elemIdx));
        }
        perTimeContours.push(step);
    }

    /* ② timeLabels：时间标签格式化 */
    var timeLabels = timeSeries.map(fmtTime);

    /* ③ windGrid：第 0 时间步的 u/v 规则网格（前端流线静态单时刻） */
    var total = gridMeta.nx * gridMeta.ny;
    var uData = new Array(total).fill(0);
    var vData = new Array(total).fill(0);
    for (var p = 0; p < nPts; p++) {
        var row0 = pointResponses[p].data.values[0];
        var ws = row0[elemIdx.WS];
        var wd = row0[elemIdx.WD];
        if (ws == null || wd == null || isNaN(ws) || isNaN(wd)) continue;
        var uv = windToUV(ws, wd);
        uData[p] = +uv.u.toFixed(2);
        vData[p] = +uv.v.toFixed(2);
    }
    var baseHeader = Object.assign({}, gridMeta, {
        parameterCategory: 2,
        surface1Type: 103,
        surface1Value: 10,
        scanMode: 0,
    });
    var windGrid = [
        {
            header: Object.assign({}, baseHeader, { parameterNumber: 2 }),
            data: uData,
        },
        {
            header: Object.assign({}, baseHeader, { parameterNumber: 3 }),
            data: vData,
        },
    ];

    return {
        timeLabels: timeLabels,
        perTimeContours: perTimeContours,
        windGrid: windGrid,
    };
}

/* ============================================================
 * 4. 执行并输出
 * ============================================================ */
var result = transform(mojicbPointResponses, gridMeta);
console.log(JSON.stringify(result, null, 2));
