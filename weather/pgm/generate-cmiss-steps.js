/*
 * 把 cmiss.json 改造成多时刻播放数据：将现有 contours 复制成 N 个时间步，
 * 每步对各气象要素做随机扰动(模拟时序变化)，date 用递增毫秒时间戳。
 *
 * 用法(在 weather/pgm 目录执行)：
 *   node generate-cmiss-steps.js                 # 默认 6 步，2026-06-17 08:00(CST) 起
 *   node generate-cmiss-steps.js 12              # 12 步
 *   node generate-cmiss-steps.js 6 1781654400000 # 6 步，自定义起始时间戳(毫秒)
 *
 * 自动备份 cmiss.json.bak；原地覆盖。兼容旧结构(data.contours)与新结构(data[0].contours)。
 * 扰动字段索引：温度19 / 降水12 / 气压8 / 风速5 / 相对湿度9 / 太阳总辐射10 / 总云量11
 *               (缺测 9999 自动跳过)。
 */
var fs = require("fs");
var path = require("path");

var file = path.join(__dirname, "..", "base", "rs", "js", "cmiss.json");
var steps = parseInt(process.argv[2], 10) || 6;
// 2026-06-17 00:00 UTC == 2026-06-17 08:00 CST
var startTs = parseInt(process.argv[3], 10) || Date.UTC(2026, 5, 17, 0, 0, 0);

var raw = fs.readFileSync(file, "utf8");
fs.writeFileSync(file + ".bak", raw, "utf8"); // 备份

var j = JSON.parse(raw);
var contours =
    j.data && j.data.contours
        ? j.data.contours
        : Array.isArray(j.data) && j.data[0]
            ? j.data[0].contours
            : [];

if (!contours.length) {
    console.error("❌ 未在 cmiss.json 中找到 contours 数据，终止。");
    process.exit(1);
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}
function valid(v) {
    return v != null && v !== 9999 && v !== 999999 && v !== -9999;
}

j.data = [];
for (var i = 0; i < steps; i++) {
    var stepContours = contours.map(function (s) {
        var ns = s.slice();
        var lat = ns[2],
            lng = ns[1];
        if (valid(ns[19]))
            ns[19] = +(ns[19] + Math.sin(i * 0.8 + lng) * 5).toFixed(1); // 温度
        if (valid(ns[12])) {
            if (ns[12] > 0)
                ns[12] = +Math.max(0, ns[12] + Math.sin(i * 1.2 + lat) * 6).toFixed(1); // 降水
            else if (Math.sin(i + lng * lat) > 0.85)
                ns[12] = +(Math.random() * 4).toFixed(1);
        }
        if (valid(ns[8]))
            ns[8] = +(ns[8] + Math.cos(i * 0.5) * 1.8).toFixed(1); // 气压
        if (valid(ns[5])) {
            ns[5] = +Math.max(0, ns[5] + Math.sin(i) * 1.1).toFixed(1); // 风速
        } else {
            // s[5] 缺测：基于经纬度生成稳定基础风速(约 2-18 m/s) + 时序扰动
            var baseWind =
                2 + Math.abs(Math.sin(ns[1] * 0.3 + ns[2] * 0.5)) * 16;
            ns[5] = +(baseWind + Math.sin(i + ns[1]) * 1.5).toFixed(1);
        }
        if (valid(ns[9])) {
            ns[9] = +clamp(ns[9] + Math.sin(i * 0.6 + lat) * 8, 5, 100).toFixed(0); // 相对湿度
        } else {
            // s[9] 缺测：基于经纬度生成稳定基础湿度(30~85%) + 时序扰动
            var baseRh = 30 + Math.abs(Math.sin(lat * 0.4 + lng * 0.3)) * 55;
            ns[9] = +clamp(baseRh + Math.sin(i * 0.6 + lat) * 8, 5, 100).toFixed(0);
        }
        if (valid(ns[10])) {
            ns[10] = +clamp(ns[10] + Math.sin(i * 0.7 + lng) * 60, 0, 1200).toFixed(0); // 太阳总辐射
        } else {
            // s[10] 缺测：基础辐射(50~900 W/m²) + 时序扰动
            var baseRad = 50 + Math.abs(Math.sin(lng * 0.5 + lat * 0.2)) * 850;
            ns[10] = +clamp(baseRad + Math.sin(i * 0.7 + lng) * 60, 0, 1200).toFixed(0);
        }
        if (valid(ns[11])) {
            ns[11] = +clamp(ns[11] + Math.sin(i * 0.5 + lng) * 10, 0, 100).toFixed(0); // 总云量
        } else {
            // s[11] 缺测：基础云量(0~80%) + 时序扰动
            var baseCloud = Math.abs(Math.sin(lat * 0.3 + lng * 0.6)) * 80;
            ns[11] = +clamp(baseCloud + Math.sin(i * 0.5 + lng) * 10, 0, 100).toFixed(0);
        }
        return ns;
    });
    j.data.push({ contours: stepContours, date: startTs + i * 3600000 });
}

fs.writeFileSync(file, JSON.stringify(j, null, 4), "utf8");
console.log("✅ 生成 " + steps + " 个时间步(各步数据已随机扰动)");
console.log("   起始: " + j.data[0].date + " (" + new Date(j.data[0].date).toLocaleString() + ")");
console.log("   结束: " + j.data[steps - 1].date + " (" + new Date(j.data[steps - 1].date).toLocaleString() + ")");
console.log("   每步站点数: " + contours.length);
console.log("   备份: " + file + ".bak");
