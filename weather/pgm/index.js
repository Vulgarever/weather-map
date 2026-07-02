var app = null;

/* 固定场站配置：id / 名称 / 类型 / 经纬度 / 可选天气电码 / 分组(group)。
   类型 → 图标见 map.js 的 STATION_TYPE_ICON（直接替换对应图片文件即可换图标）；
   weather 为天气电码（参考 WEATHER_ICON_CODEX，如 1=晴、8=多云、51=小雨、53=中雨），
   留空则该场站不显示天气角标；
   group 标识所属地区/公司，可用 weatherMap.highlightStations(group) 批量高亮同组场站。
   经纬度示例落点为海北州区域，可自行调整。 */
var STATION_LIST = [
    { id: "rjgf", name: "仁佳光伏", type: "pv",      lat: 36.95, lng: 100.90, weather: "1",  group: "光伏A区" },
    { id: "scgf", name: "舒乘光伏", type: "pv",      lat: 37.12, lng: 101.35, weather: "8",  group: "光伏A区" },
    { id: "xcgf", name: "星晨光伏", type: "pv",      lat: 36.78, lng: 101.62, weather: "51", group: "光伏A区" },
    { id: "hngf", name: "辉能光伏", type: "pv",      lat: 37.32, lng: 100.45, weather: "13", group: "光伏B区" },
    { id: "ymgf", name: "宇明光伏", type: "pv",      lat: 36.58, lng: 100.95, weather: "",   group: "光伏B区" },
    { id: "pbcn", name: "蓬勃储能", type: "storage", lat: 37.05, lng: 101.85, weather: "1",  group: "储能中心" },
    { id: "wlcb", name: "乌兰察不", type: "wind",    lat: 37.45, lng: 100.20, weather: "53", group: "风电场" },
];

/* 初始化气象地图 */
window.weatherMap = WeatherMap.init("weather-map");

/* 时间变化回调 */
window.weatherMap.onTimeChange = function (state) {
    app.isPlaying = state.isPlaying;
    /* 拖拽进度条时完全接管拖把位置，忽略播放/外部进度更新，避免被覆盖 */
    if (app.isDragging) return;
    /* 播放中带连续 progress（0~1）→ 进度条像视频一样平滑向前；
       其余（暂停/拖动）按整数步对齐到点击位置 */
    app.timelineProgress =
        state.progress != null
            ? state.progress * 100
            : state.totalSteps > 1
              ? Math.round((state.timeIndex / (state.totalSteps - 1)) * 100)
              : 0;
    /* timeLabel 仅在整点（分钟为 00）刷新；非整点保持上一个整点标签。
       画面渲染不受影响，仍按正常进度推进。 */
    if (app.isHourLabel(state.timeLabel)) {
        app.timeLabel = state.timeLabel;
        app.lastHourLabel = state.timeLabel;
    } else if (app.lastHourLabel) {
        app.timeLabel = app.lastHourLabel;
    } else {
        app.timeLabel = state.timeLabel;
    }
};


function liemsOnLoad() {
    app = new Vue({
        el: "#liEMSAPP",
        data: function () {
            return {
                queryDate: ['' , ''],
                currentTab: "weather",
                currentTag: "仁佳光伏",
                isPlaying: false,
                timelineProgress: 0,
                timeLabel: "2026-06-22 08:00",
                lastHourLabel: "", // 上一个整点的 timeLabel，非整点播放时保持显示它
                timelineScale: [], // 时间轴刻度（{pct,isHour,hour}，由 buildTimelineScale 填充）
                isDragging: false, // 进度条拖拽态
                wasPlayingBeforeDrag: false, // 拖拽开始时是否在播放（松手后据此自动恢复）
                hoverPct: 0, // hover/拖拽预览气泡位置（百分比，首次渲染兜底用）
                hoverBoxLeft: 0, // 气泡框左边相对容器 px（视口约束后）
                hoverArrowLeft: 0, // 箭头在气泡框内偏移 px（指向真实步位置）
                hoverLabel: "", // hover/拖拽预览气泡文字
                hoverAlign: "center", // 气泡对齐方式：custom(框/箭头独立定位)/center(兜底)

                // 图例数据
                showLegend: false,
                legendTitle: "",
                legendGradient: "",
                legendLabels: [],

                /* sidebar ID → 地图图层类型映射 */
                layerMap: {
                    weather: "weather",
                    temp: "temp",
                    humidity: "rain",
                    rh: "humidity", // 相对湿度（热力）
                    radiation: "radiation", // 太阳总辐射（热力）
                    cloud: "cloud", // 总云量（热力）
                    wind: "wind",
                    isobar: "isobar",
                    snow: "snow", // 【这里修改】：将原本的 windSpeed 改为 wind，两者统一调用风场复合引擎
                },

                sidebarItems: [
                    {
                        id: "weather",
                        label: "天气",
                        isComplex: true,
                        // 【优化】原版只有一个太阳，现在替换为“太阳被云层部分遮挡”的组合图标，更符合图片的层次感
                        iconPath:
                            "M17.5 11.2C17.7 11.2 17.9 11.2 18.1 11.2C17.5 8.8 15.3 7 12.8 7C10.5 7 8.6 8.3 7.7 10.2C7.3 10.1 6.9 10 6.5 10C4.3 10 2.5 11.8 2.5 14S4.3 18 6.5 18H12.2C11.9 17.3 11.8 16.6 11.8 15.8C11.8 12.7 14.3 10.2 17.5 11.2M11.5 4H14V2H11.5V4M4.9 6.3L6.7 4.5L4.9 2.8L3.1 4.5L4.9 6.3M18.9 6.3L20.7 4.5L18.9 2.8L17.1 4.5L18.9 6.3Z",
                    },
                    {
                        id: "temp",
                        label: "温度",
                        iconPath:
                            "M15 13V5c0-1.66-1.34-3-3-3S9 3.34 9 5v8c-2.21 1.66-2.66 4.79-1 7s4.79 2.66 7 1 2.66-4.79 1-7c-.3-.38-.63-.71-1-1zm-3-9c.55 0 1 .45 1 1v3h-2V5c0-.55.45-1 1-1zm0 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm9-13v2h-3V5h3zm-1 4v2h-2V9h2zm1 4v2h-3v-2h3z",
                    },
                    {
                        id: "humidity",
                        label: "降水",
                        iconPath:
                            "M17.66 8L12 2.35 6.34 8C4.78 9.56 4 11.64 4 13.64s.78 4.08 2.34 5.64 3.64 2.34 5.66 2.34 4.1-.78 5.66-2.34S20 15.64 20 13.64 19.22 9.56 17.66 8zM6 14c.01-2 .62-3.27 1.76-4.4L12 5.27l4.24 4.38C17.38 10.77 17.99 12 18 14H6z",
                    },
                    {
                        id: "wind",
                        label: "风速",
                        iconPath:
                            "M4 14v-3h13.5c1.38 0 2.5-1.12 2.5-2.5S18.88 6 17.5 6 15 7.12 15 8.5h-2c0-2.47 2.03-4.5 4.5-4.5S22 6.03 22 8.5 19.97 13 17.5 13H4v1zm4.5 6C10.43 20 12 18.43 12 16.5S10.43 13 8.5 13 5 14.57 5 16.5h2c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5H5c0 1.93 1.57 3.5 3.5 3.5zm4-2c1.38 0 2.5-1.12 2.5-2.5S13.88 13 12.5 13 10 14.12 10 15.5h2c0-.28.22-.5.5-.5s.5.22.5.5-.22.5-.5.5h-2c0 1.38 1.12 2.5 2.5 2.5z",
                    },
                    {
                        id: "isobar",
                        label: "气压",
                        iconPath:
                            "M12 22A10 10 0 0 1 2 12A10 10 0 0 1 12 2A10 10 0 0 1 22 12A10 10 0 0 1 12 22M12 4A8 8 0 0 0 4 12A8 8 0 0 0 12 20A8 8 0 0 0 20 12A8 8 0 0 0 12 4M11 14H13L14.5 8.5L12 7L9.5 8.5L11 14Z",
                    },
                    {
                        id: "snow",
                        label: "降雪量",
                        iconPath:
                            "M14.5 4l-2.5 2.5L9.5 4 8.09 5.41 11 8.33V11H8.33L5.41 8.09 4 9.5 6.5 12 4 14.5l1.41 1.41L8.33 13H11v2.67l-2.91 2.92L9.5 20l2.5-2.5 2.5 2.5 1.41-1.41L13 15.67V13h2.67l2.92 2.91L20 14.5 17.5 12 20 9.5l-1.41-1.41L15.67 11H13V8.33l2.91-2.92L14.5 4z",
                    },
                    {
                        id: "rh",
                        label: "相对湿度",
                        iconPath:
                            "M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2c0-3.32-2.67-7.25-8-11.8z",
                    },
                    {
                        id: "radiation",
                        label: "太阳辐射",
                        iconPath:
                            "M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM1 13h3v-2H1v2zm10-12.45V3.5h2V.55h-2zm8.45 4.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zM17.24 21.16l1.8 1.79 1.41-1.41-1.79-1.79-1.42 1.41zM20 13h3v-2h-3v2zm-8-7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 19.45h2V20.5h-2v2.95zM5.64 19.95l1.79-1.79-1.41-1.41-1.79 1.79 1.41 1.41z",
                    },
                    {
                        id: "cloud",
                        label: "总云量",
                        iconPath:
                            "M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z",
                    },
                ],

                stationTags: [
                    "仁佳光伏",
                    "舒乘光伏",
                    "星晨光伏",
                    "辉能光伏",
                    "宇明光伏",
                    "蓬勃储能",
                    "乌兰察不",
                ],

                /* 站点标签折叠/展开状态：超过两行时折叠，末尾出现展开按钮 */
                tagOverflow: false, // 标签是否超过两行（需要折叠）
                tagExpanded: false, // 当前是否展开全部
                collapsedTagCount: 0, // 折叠态下显示的标签数量（由 measureTags 计算填入）

                forecastData: [
                    {
                        date: "06-21",
                        tempHigh: "22℃",
                        tempLow: "12℃",
                        code: '1'
                    },
                    {
                        date: "06-22",
                        tempHigh: "22℃",
                        tempLow: "12℃",
                        code: '13'
                    },
                    {
                        date: "06-23",
                        tempHigh: "22℃",
                        tempLow: "12℃",
                        code: '8'
                    },
                    {
                        date: "06-24",
                        tempHigh: "22℃",
                        tempLow: "12℃",
                        code: '51'
                    },
                    {
                        date: "06-25",
                        tempHigh: "24℃",
                        tempLow: "13℃",
                        code: '1'
                    },
                    {
                        date: "06-26",
                        tempHigh: "21℃",
                        tempLow: "11℃",
                        code: '8'
                    },
                    {
                        date: "06-27",
                        tempHigh: "19℃",
                        tempLow: "10℃",                        
                        code: '51'
                    },
                ],
                // 预报 carousel 状态
                forecastOffset: 0,
                forecastVisibleCount: 4,

                tableColumns: [
                    "00:00-00:15",
                    "00:15-00:30",
                    "00:30-00:45",
                    "00:45-01:00",
                    "01:00-01:15",
                    "01:15-01:30",
                    "01:30-01:45",
                    "01:45-02:00",
                    "02:00-02:15",
                    "02:15-02:30",
                ],

                tableRows: [
                    {
                        type: "100m高度",
                        values: [
                            180, 180, 180, 180, 180, 180, 180, 180, 180,
                            180,
                        ],
                    },
                    {
                        type: "80m高度",
                        values: [
                            180, 180, 180, 180, 180, 180, 180, 180, 180,
                            180,
                        ],
                    },
                    {
                        type: "70m高度",
                        values: [
                            180, 180, 180, 180, 180, 180, 180, 180, 180,
                            180,
                        ],
                    },
                    {
                        type: "50m高度",
                        values: [
                            180, 180, 180, 180, 180, 180, 180, 180, 180,
                            180,
                        ],
                    },
                ],

            };
        },
        computed: {
            forecastMaxOffset: function () {
                return Math.max(
                    0,
                    this.forecastData.length - this.forecastVisibleCount,
                );
            },
            canSlidePrev: function () {
                return this.forecastOffset > 0;
            },
            canSlideNext: function () {
                return this.forecastOffset < this.forecastMaxOffset;
            },
            forecastTrackStyle: function () {
                return {
                    transform:
                        "translateX(" + -this.forecastOffset * 60 + "px)",
                };
            },
            /* 折叠态只渲染前 collapsedTagCount 个；展开或不溢出时渲染全部 */
            visibleStationTags: function () {
                var list = this.stationTags;
                var withIndex = list.map(function (tag, idx) {
                    return { tag: tag, index: idx };
                });
                if (!this.tagOverflow || this.tagExpanded) {
                    return withIndex;
                }
                var limit = this.collapsedTagCount;
                return withIndex.filter(function (item) {
                    return item.index < limit;
                });
            },
            /* hover 气泡定位 style：custom 态框用 px 左对齐 + 箭头独立 px；
               center 兜底态用百分比居中（首次渲染未挂载时）。 */
            hoverStyle: function () {
                if (this.hoverAlign === "custom") {
                    return {
                        left: this.hoverBoxLeft + "px",
                        transform: "none",
                    };
                }
                return { left: this.hoverPct + "%", transform: "translateX(-50%)" };
            },
            /* 箭头定位 style：custom 态用独立 px 指向真实步位置；
               center 兜底态箭头居中。 */
            hoverArrowStyle: function () {
                if (this.hoverAlign === "custom") {
                    return { left: this.hoverArrowLeft + "px", transform: "translateX(-50%)" };
                }
                return { left: "50%", transform: "translateX(-50%)" };
            },
        },
        methods: {
            handleSearch: function () {
                var self = this;
                if (!window.weatherMap) return;
                /* 查询按钮：慢接口在调地图刷新之前——先 showLoading 覆盖全程(慢接口+刷新)。
                   TODO: 此处调用实际查询接口，完成后调 refreshCmissData 重建视图。
                   onLoad/onError 里务必 hideLoading()，避免遮罩卡死。 */
                window.weatherMap.showLoading();
                if (typeof window.weatherMap.refreshCmissData !== "function") {
                    window.weatherMap.hideLoading();
                    return;
                }
                window.weatherMap.refreshCmissData({
                    /* loading 默认 true：refreshCmissData 内部会再 show(计数式不叠加)，
                       finally 里 hide 一次；此处 onLoad/onError 里再 hide 一次抵消 handleSearch 的 show。 */
                    onLoad: function () {
                        var layerType = self.layerMap[self.currentTab];
                        if (layerType) window.weatherMap.toggleLayer(layerType, true);
                        self.syncTimeAfterRefresh();
                        window.weatherMap.hideLoading();
                    },
                    onError: function (msg) {
                        console.error("[查询] " + msg);
                        window.weatherMap.hideLoading();
                    },
                });
            },
            /* 刷新 cmiss 数据 + 视图（点击"刷新数据"按钮调用） */
            refreshCmiss: function () {
                var self = this;
                if (
                    !window.weatherMap ||
                    !window.weatherMap.refreshCmissData
                )
                    return;
                window.weatherMap.refreshCmissData({
                    loading: false, /* 刷新按钮不显示 loading（仅查询按钮显示） */
                    onLoad: function () {
                        /* 重新激活当前选中图层（缓存已清，用新数据重建） */
                        var layerType = self.layerMap[self.currentTab];
                        if (layerType)
                            window.weatherMap.toggleLayer(layerType, true);
                        self.syncTimeAfterRefresh();
                    },
                    onError: function (msg) {
                        console.error("[刷新cmiss] " + msg);
                    },
                });
            },
            /* 刷新后重置时间轴到当前时间最近步 */
            syncTimeAfterRefresh: function () {
                var idx = window.weatherMap.currentTimeIndex || 0;
                var steps = window.weatherMap.timeSteps || [];
                if (steps.length) {
                    this.timeLabel = steps[idx] || steps[0];
                    this.timelineProgress =
                        steps.length > 1
                            ? Math.round((idx / (steps.length - 1)) * 100)
                            : 0;
                }
                this.timelineScale = this.buildTimelineScale();
                this.isPlaying = false;
            },
            slideForecast: function (direction) {
                if (direction === "left" && this.canSlidePrev) {
                    this.forecastOffset--;
                } else if (direction === "right" && this.canSlideNext) {
                    this.forecastOffset++;
                }
            },
            // 根据容器实际宽度计算一屏可显示的预报项数（单项固定 60px）
            updateForecastVisible: function () {
                var list = this.$refs.forecastList;
                if (list) {
                    this.forecastVisibleCount = Math.max(
                        1,
                        Math.floor(list.clientWidth / 60),
                    );
                }
            },

            /* 测量站点标签真实布局：超过两行则启用折叠，并计算折叠态下
               第二行能容纳的标签数（为末尾“展开”按钮预留空间）。
               注：gap 需与 CSS 中 .tag-container 的 gap 保持一致 */
            measureTags: function () {
                var self = this;
                var prevExpanded = this.tagExpanded;
                /* 切到全渲染状态，保证测量的是标签的真实两行容量 */
                this.tagOverflow = false;
                this.$nextTick(function () {
                    var container = self.$refs.tagContainer;
                    if (!container) return;
                    var tagEls = container.querySelectorAll(
                        ".station-tag:not(.tag-toggle-btn)",
                    );
                    if (!tagEls.length) {
                        self.tagOverflow = false;
                        return;
                    }

                    /* 按行分组（同一行 offsetTop 相同） */
                    var rows = [];
                    var rowMap = {};
                    Array.prototype.forEach.call(tagEls, function (el) {
                        var key = el.offsetTop;
                        if (!rowMap[key]) {
                            rowMap[key] = [];
                            rows.push(rowMap[key]);
                        }
                        rowMap[key].push(el);
                    });

                    if (rows.length <= 2) {
                        /* 未超过两行，无需折叠 */
                        self.tagOverflow = false;
                        self.tagExpanded = false;
                        self.collapsedTagCount = self.stationTags.length;
                        return;
                    }

                    /* 超过两行 → 折叠 */
                    self.tagOverflow = true;

                    var containerWidth = container.clientWidth;
                    var gap = 6; // 与 .tag-container 的 gap 保持一致
                    var btnEl = self.$refs.tagToggleBtn;
                    /* 按钮宽度 + 与前一标签的间距（首次测量按钮尚未渲染，给兜底值） */
                    var btnWidth = (btnEl ? btnEl.offsetWidth : 44) + gap;

                    /* 第一行全部保留；第二行从左到右取，直到放不下按钮为止 */
                    var count = rows[0].length;
                    var secondRow = rows[1];
                    var fitInSecondRow = 0;
                    for (var i = 0; i < secondRow.length; i++) {
                        var el = secondRow[i];
                        var rightEdge = el.offsetLeft + el.offsetWidth;
                        if (rightEdge + btnWidth <= containerWidth) {
                            fitInSecondRow = i + 1;
                        } else {
                            break;
                        }
                    }
                    count += fitInSecondRow;
                    self.collapsedTagCount = count;
                    /* 保持用户当前的展开/折叠意愿 */
                    self.tagExpanded = prevExpanded;
                });
            },

            /* 时间轴标签：仅首/中/尾 3 个，由 CSS flex 两端对齐定位，无需计算位置 */
            buildTimelineScale: function () {
                var steps =
                    window.weatherMap && window.weatherMap.timeSteps
                        ? window.weatherMap.timeSteps
                        : [];
                var n = steps.length;
                if (!n) return [];
                var out = [{ label: steps[0] }];
                if (n >= 3) out.push({ label: steps[Math.floor((n - 1) / 2)] });
                if (n >= 2) out.push({ label: steps[n - 1] });
                return out;
            },
            /* 鼠标事件 → {pct,index,label}：吸附到最近时间步，pct 由 index 反算，
               保证拖把/气泡始终对齐刻度，不会停在两步之间。 */
            timelinePointFromEvent: function (e) {
                var el = this.$refs.timeline;
                if (!el) return null;
                var rect = el.getBoundingClientRect();
                var ratio =
                    rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
                ratio = Math.max(0, Math.min(1, ratio));
                var steps = window.weatherMap ? window.weatherMap.timeSteps : [];
                var n = steps.length;
                var index = n > 1 ? Math.round(ratio * (n - 1)) : 0;
                index = Math.max(0, Math.min(n - 1, index));
                /* 对用户而言不存在非整点：鼠标位置一律吸附到下一个整点步，
                   hover/拖拽/松手统一走此路径，拖把与气泡永远只落在整点。 */
                index = this.snapToNextHour(index);
                return {
                    pct: n > 1 ? (index / (n - 1)) * 100 : 0,
                    index: index,
                    label: steps[index] || "",
                };
            },
            /* 统一设置 hover 气泡：气泡框以视口为界约束（绝不出屏幕），
               箭头则始终指向真实步位置（对齐拖把/鼠标），二者独立定位。 */
            setHover: function (p) {
                this.hoverLabel = p.label;
                var el = this.$refs.timeline;
                var rect = el ? el.getBoundingClientRect() : null;
                var hv = el ? el.querySelector(".timeline-hover") : null;
                if (!rect || !hv || !hv.offsetWidth) {
                    /* 首次渲染气泡尚未挂载，退回居中百分比方案 */
                    this.hoverPct = p.pct;
                    this.hoverAlign = "center";
                    return;
                }
                var bw = hv.offsetWidth;
                /* 步位置（容器内 px）= 箭头要指向的位置 */
                var center = (p.pct / 100) * rect.width;
                var vw = window.innerWidth;
                var pad = 6;
                /* 气泡框理想左边（容器内 px），居中于步位置 */
                var boxLeft = center - bw / 2;
                /* 视口约束：框左边相对视口 ≥ pad，框右边相对视口 ≤ vw-pad */
                var boxLeftVx = rect.left + boxLeft;
                if (boxLeftVx < pad) boxLeft = pad - rect.left;
                if (rect.left + boxLeft + bw > vw - pad)
                    boxLeft = vw - pad - rect.left - bw;
                /* 箭头在框内偏移 = 步位置 - 框左边（始终指向步位置），
                   夹到框内避免箭头跑出气泡 */
                var arrowLeft = center - boxLeft;
                if (arrowLeft < 6) arrowLeft = 6;
                if (arrowLeft > bw - 6) arrowLeft = bw - 6;
                this.hoverBoxLeft = boxLeft;
                this.hoverArrowLeft = arrowLeft;
                this.hoverAlign = "custom";
            },
            /* hover 预览（非拖拽态）：显示鼠标处时间步 */
            onTimelineHover: function (e) {
                if (this.isDragging) return;
                var p = this.timelinePointFromEvent(e);
                if (!p) return;
                this.setHover(p);
            },
            onTimelineLeave: function () {
                /* 拖拽中移出容器不清气泡，由全局 move 继续更新 */
                if (this.isDragging) return;
                this.hoverLabel = "";
            },
            /* 拖拽起点：进入拖拽态，拖把实时跟手到点击的步位置（不切帧） */
            onTimelinePointerDown: function (e) {
                if (e.button !== undefined && e.button !== 0) return;
                var p = this.timelinePointFromEvent(e);
                if (!p) return;
                /* 拖拽时暂停播放，避免画面继续推进而拖把被拖在别处造成割裂；
                   记录是否因拖拽暂停，松手后据此自动恢复播放。 */
                this.wasPlayingBeforeDrag = false;
                if (this.isPlaying && window.weatherMap) {
                    window.weatherMap.togglePlayback();
                    this.wasPlayingBeforeDrag = true;
                }
                this.isDragging = true;
                this.timelineProgress = p.pct;
                this.setHover(p);
                e.preventDefault();
            },
            /* 全局拖拽移动：拖把实时跟手，仅更新预览不切地图帧 */
            onTimelineDragMove: function (e) {
                if (!this.isDragging) return;
                var p = this.timelinePointFromEvent(e);
                if (!p) return;
                this.timelineProgress = p.pct;
                this.setHover(p);
            },
            /* 松手：切到吸附后的整点帧（index 已由 timelinePointFromEvent 吸附整点） */
            onTimelineDragEnd: function (e) {
                if (!this.isDragging) return;
                this.isDragging = false;
                this.hoverLabel = "";
                var p = this.timelinePointFromEvent(e);
                if (!p || !window.weatherMap) return;
                /* 切到该整点帧（此时已暂停，仅渲染单帧） */
                window.weatherMap.onSliderChange(p.index);
                /* 因拖拽暂停的，松手后自动恢复播放；
                   但吸附到末帧时不恢复——恢复会回绕到首帧，与“拖到哪停到哪”冲突。 */
                var shouldResume = this.wasPlayingBeforeDrag;
                this.wasPlayingBeforeDrag = false;
                if (
                    shouldResume &&
                    window.weatherMap.timeSteps.length > 1 &&
                    p.index < window.weatherMap.timeSteps.length - 1
                ) {
                    window.weatherMap.togglePlayback();
                }
            },

            /** 切换左侧 sidebar 对应的地图图层 */
            switchMapLayer: function (item) {
                if (!window.weatherMap) return;

                var layerType = this.layerMap[item.id];
                if (!layerType) return;

                /* 点击同一项 → 关闭 */
                if (this.currentTab === item.id) {
                    return;
                }

                /* 关闭旧图层 */
                if (this.currentTab) {
                    var oldType = this.layerMap[this.currentTab];
                    if (oldType)
                        window.weatherMap.toggleLayer(oldType, false);
                }

                /* 激活新图层 */
                this.currentTab = item.id;
                window.weatherMap.toggleLayer(layerType, true);
            },

            togglePlay: function () {
                if (!window.weatherMap) return;
                window.weatherMap.togglePlayback();
            },

            isHourLabel: function (label) {
                /* timeLabel 形如 "06月26日 14:00"，末尾 ":00" 即整点 */
                return typeof label === "string" && /:00\s*$/.test(label.trim());
            },
            /* 进度条非整点吸附：取下一个整点步索引。已是整点则不变；
               后面没有整点时回退到上一个整点，避免末段非整点点击无响应。 */
            snapToNextHour: function (index) {
                var steps = window.weatherMap.timeSteps;
                if (!steps || !steps.length) return index;
                index = Math.max(0, Math.min(steps.length - 1, index));
                if (this.isHourLabel(steps[index])) return index;
                for (var i = index + 1; i < steps.length; i++) {
                    if (this.isHourLabel(steps[i])) return i;
                }
                for (var j = index - 1; j >= 0; j--) {
                    if (this.isHourLabel(steps[j])) return j;
                }
                return index;
            },
            renderComplexIcon: function (item) {
                if (item.id === "weather") {
                    var maskId = "cloud-gap-mask-" + item.id;
                    return (
                        "<defs>" +
                        '<mask id="' +
                        maskId +
                        '">' +
                        '<rect width="100%" height="100%" fill="white" />' +
                        '<path d="M6.5 17.5 H17.5 A4.5 4.5 0 0 0 17.5 8.5 A5.5 5.5 0 0 0 7.5 9 A4 4 0 0 0 6.5 17.5 Z" fill="black" stroke="black" stroke-width="2" stroke-linejoin="round" />' +
                        "</mask>" +
                        "</defs>" +
                        '<g fill="currentColor">' +
                        '<g mask="url(#' +
                        maskId +
                        ')">' +
                        '<circle cx="8" cy="8" r="3.5" />' +
                        '<g stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
                        '<line x1="8" y1="2.5" x2="8" y2="0.5" />' +
                        '<line x1="4" y1="4" x2="2.5" y2="2.5" />' +
                        '<line x1="2.5" y1="8" x2="0.5" y2="8" />' +
                        "</g>" +
                        "</g>" +
                        '<path d="M6.5 17.5 H17.5 A4.5 4.5 0 0 0 17.5 8.5 A5.5 5.5 0 0 0 7.5 9 A4 4 0 0 0 6.5 17.5 Z" />' +
                        "</g>"
                    );
                }
                return "";
            },
            getWeatherIconLabel: function (code) {
                if (!window.weatherMap) {
                    return '';
                }
                return window.weatherMap.WEATHER_ICON_CODEX[code];
            },
        },
        mounted: function () {
            /* 加载气象数据 */
            window.weatherMap.fetchAllRealData({
                onLoad: function () {
                    console.log("[WeatherMap] 数据加载完成");
                    /* 默认仅激活天气图层；风场等其它图层由左侧栏手动开启 */
                    window.weatherMap.toggleLayer("weather", true);
                    /* 注入固定场站（常驻展示；当前天气图层已激活，场站会叠加天气角标） */
                    if (window.weatherMap.setStationConfig) {
                        window.weatherMap.setStationConfig(STATION_LIST);
                        weatherMap.highlightStations('光伏A区')            
                    }
                    /* 初始化时间标签 + 进度条到当前时间最近的时间步 */
                    var _idx = window.weatherMap.currentTimeIndex || 0;
                    var _steps = window.weatherMap.timeSteps || [];
                    if (_steps.length) {
                        this.timeLabel = _steps[_idx] || _steps[0];
                        this.timelineProgress =
                            _steps.length > 1
                                ? Math.round((_idx / (_steps.length - 1)) * 100)
                                : 0;
                    }
                    /* 时间轴刻度随 timeSteps 动态生成（app 为模块级变量，此处已就绪） */
                    this.timelineScale = this.buildTimelineScale();
                    this.currentTab = "weather";
                }.bind(this),
                onError: function (msg) {
                    console.error("[WeatherMap] " + msg);
                },
            });
            var self = this;
            this.$nextTick(function () {
                self.updateForecastVisible();
                self.measureTags();
                /* 兜底生成时间轴刻度：若 onLoad 已生成则覆盖为同值，否则补齐，
                   避免因 onLoad/app 时序问题导致刻度标签缺失。 */
                self.timelineScale = self.buildTimelineScale();
            });
            window.addEventListener("resize", this.updateForecastVisible);
            /* 标签折叠状态随容器尺寸变化重新测量（debounce，避免高频抖动） */
            var resizeTimer = null;
            this._measureResizeHandler = function () {
                if (resizeTimer) {
                    clearTimeout(resizeTimer);
                }
                resizeTimer = setTimeout(function () {
                    self.measureTags();
                }, 200);
            };
            window.addEventListener("resize", this._measureResizeHandler);
            /* 进度条拖拽：move/up 绑到 window，使鼠标移出进度条容器后仍能跟手、
               且在容器外松手也能正确结束拖拽并吸附。down/hover/leave 在元素内处理。 */
            window.addEventListener("pointermove", this.onTimelineDragMove);
            window.addEventListener("pointerup", this.onTimelineDragEnd);
        },
        beforeDestroy: function () {
            window.removeEventListener(
                "resize",
                this.updateForecastVisible,
            );
            window.removeEventListener("resize", this._measureResizeHandler);
            window.removeEventListener("pointermove", this.onTimelineDragMove);
            window.removeEventListener("pointerup", this.onTimelineDragEnd);
            if (window.weatherMap && window.weatherMap.isPlaying) {
                window.weatherMap.togglePlayback();
            }
        },
    });
    return app;
}