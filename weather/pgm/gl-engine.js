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
        };
        return api;
    }

    return { init: init };
})();
