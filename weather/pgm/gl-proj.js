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
