import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE = "PanoramaViewer";
const TEXT = {
  zh: {
    empty: "连接全景图并运行工作流后，在这里查看 360° 预览",
    drag: "拖动旋转 · 滚轮缩放",
    reset: "重置视角",
    fullscreen: "全屏",
    exitFullscreen: "退出全屏",
    equirectangular: "建议使用 2:1 等距柱状全景图",
    webgl: "当前浏览器不支持 WebGL，无法显示全景预览",
    loadError: "全景图预览加载失败",
    multiView: "展开多视角",
    chooseHint: "点击视角选择输出；重新运行后图像接口更新",
    front: "前",
    right: "右",
    back: "后",
    left: "左",
  },
  en: {
    empty: "Connect a panorama and run the workflow to view it here",
    drag: "Drag to look · Scroll to zoom",
    reset: "Reset view",
    fullscreen: "Fullscreen",
    exitFullscreen: "Exit fullscreen",
    equirectangular: "A 2:1 equirectangular panorama is recommended",
    webgl: "WebGL is unavailable in this browser",
    loadError: "Could not load the panorama preview",
    multiView: "Multi-view",
    chooseHint: "Select a view, then run the workflow to update the image output",
    front: "Front",
    right: "Right",
    back: "Back",
    left: "Left",
  },
};

function language(override) {
  const locale = override || app.extensionManager?.setting?.get?.("Comfy.Locale") || navigator.language || "en";
  return String(locale).toLowerCase().startsWith("zh") ? "zh" : "en";
}

app.registerExtension({
  name: "TimeImage.PanoramaViewer",
  async nodeCreated(node) {
    if (node.comfyClass !== NODE) return;

    let locale = language();
    const t = (key) => TEXT[locale][key] || TEXT.en[key];
    const widgets = Object.fromEntries((node.widgets || []).map((widget) => [widget.name, widget]));
    const widget = (name) => widgets[name];
    for (const name of ["multi_view", "selected_view", "camera_yaw", "camera_pitch", "camera_fov", "view_aspect"]) {
      const hidden = widget(name);
      if (hidden) { hidden.computeSize = () => [0, -4]; hidden.draw = () => {}; hidden.hidden = true; }
    }
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;width:100%;height:340px;min-height:0;box-sizing:border-box;padding:8px;background:#202124;color:#f1f2f4;border:1px solid #34363a;border-radius:12px;font:12px/1.35 sans-serif";

    const toolbar = document.createElement("div");
    toolbar.style.cssText = "height:28px;flex:0 0 28px;display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;color:#aeb2b8;font-size:11px";
    const status = document.createElement("span");
    status.textContent = t("empty");
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;align-items:center";
    const makeButton = (key) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = t(key);
      button.style.cssText = "padding:4px 9px;border:1px solid #414348;border-radius:6px;background:#292a2e;color:#e7e8ea;font:11px sans-serif;cursor:pointer";
      return button;
    };
    const multiLabel = document.createElement("label");
    multiLabel.style.cssText = "display:flex;align-items:center;gap:4px;padding:4px 6px;border:1px solid #414348;border-radius:6px;background:#292a2e;color:#e7e8ea;font:11px sans-serif;cursor:pointer;white-space:nowrap";
    const multiToggle = document.createElement("input");
    multiToggle.type = "checkbox";
    multiToggle.checked = Boolean(widget("multi_view")?.value);
    multiToggle.style.cssText = "margin:0;accent-color:#08b88a";
    const multiText = document.createElement("span");
    multiText.textContent = t("multiView");
    multiLabel.append(multiToggle, multiText);
    const reset = makeButton("reset");
    const fullscreen = makeButton("fullscreen");
    actions.append(multiLabel, reset, fullscreen);
    toolbar.append(status, actions);

    const viewport = document.createElement("div");
    viewport.style.cssText = "position:relative;flex:1 1 auto;width:100%;height:280px;min-height:160px;overflow:hidden;border-radius:8px;background:#090a0b";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;cursor:grab";
    const empty = document.createElement("div");
    empty.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;text-align:center;color:#8b9098;font:12px/1.5 sans-serif;pointer-events:none";
    empty.textContent = t("empty");
    viewport.append(canvas, empty);

    const gallery = document.createElement("div");
    gallery.style.cssText = "display:none;flex:0 0 auto;margin-top:7px;padding:7px;background:#191a1c;border:1px solid #303236;border-radius:8px;box-sizing:border-box";
    const galleryHint = document.createElement("div");
    galleryHint.textContent = t("chooseHint");
    galleryHint.style.cssText = "margin:0 0 6px;color:#9ea3aa;font-size:10px";
    const galleryGrid = document.createElement("div");
    galleryGrid.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px";
    gallery.append(galleryHint, galleryGrid);
    root.append(toolbar, viewport, gallery);

    let gl = null;
    let program = null;
    let texture = null;
    let image = null;
    let yaw = 0;
    let pitch = 0;
    let fov = 82;
    let pointer = null;
    let disposed = false;
    let viewFiles = [];
    const viewYaw = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const viewNames = ["front", "right", "back", "left"];
    let compactNodeHeight = Math.max(430, (node.size?.[1] || 430) - (multiToggle.checked ? 140 : 0));

    const setWidget = (name, value) => { const target = widget(name); if (target) target.value = value; };
    const syncCamera = () => {
      setWidget("camera_yaw", yaw);
      setWidget("camera_pitch", pitch);
      setWidget("camera_fov", fov);
      const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
      setWidget("view_aspect", clamp(aspect || 1.6, 0.5, 3.0));
    };
    const applySelectedView = (index) => {
      index = clamp(Number(index) || 0, 0, 3);
      setWidget("selected_view", index);
      yaw = viewYaw[index];
      pitch = 0;
      syncCamera();
      draw();
    };
    const renderViewCards = () => {
      galleryGrid.replaceChildren();
      const selected = Number(widget("selected_view")?.value || 0);
      viewFiles.forEach((file, index) => {
        const card = document.createElement("button");
        card.type = "button";
        card.style.cssText = `position:relative;display:block;padding:0;overflow:hidden;border:2px solid ${index === selected ? "#08b88a" : "#414349"};border-radius:7px;background:#111;cursor:pointer;min-width:0`;
        const thumb = document.createElement("img");
        const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "temp", t: String(Date.now()) });
        thumb.src = api.apiURL(`/view?${params.toString()}`);
        thumb.alt = t(viewNames[index]);
        thumb.style.cssText = "display:block;width:100%;height:82px;object-fit:cover";
        const caption = document.createElement("span");
        caption.textContent = t(viewNames[index]);
        caption.style.cssText = "position:absolute;left:5px;bottom:5px;padding:2px 5px;border-radius:4px;background:#111c;color:#fff;font-size:10px";
        card.append(thumb, caption);
        card.addEventListener("click", () => { applySelectedView(index); renderViewCards(); });
        galleryGrid.append(card);
      });
    };
    const updateMultiView = () => {
      const enabled = multiToggle.checked;
      setWidget("multi_view", enabled);
      gallery.style.display = enabled ? "block" : "none";
      if (enabled) renderViewCards();
      if (enabled && node.size && node.size[1] < 570) { compactNodeHeight = node.size[1]; node.setSize([node.size[0], 570]); }
      else if (!enabled && node.size && node.size[1] >= 570) node.setSize([node.size[0], compactNodeHeight]);
      requestAnimationFrame(syncViewerSize);
    };
    multiToggle.addEventListener("change", updateMultiView);
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const vertexSource = `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;
    const fragmentSource = `
      precision highp float;
      varying vec2 v_uv;
      uniform sampler2D u_panorama;
      uniform vec2 u_resolution;
      uniform float u_yaw;
      uniform float u_pitch;
      uniform float u_fov;
      const float PI = 3.141592653589793;
      void main() {
        vec2 screen = v_uv * 2.0 - 1.0;
        float aspect = u_resolution.x / max(1.0, u_resolution.y);
        float focal = tan(radians(u_fov) * 0.5);
        vec3 ray = normalize(vec3(screen.x * aspect * focal, screen.y * focal, 1.0));
        float cp = cos(u_pitch), sp = sin(u_pitch);
        ray = vec3(ray.x, cp * ray.y - sp * ray.z, sp * ray.y + cp * ray.z);
        float cy = cos(u_yaw), sy = sin(u_yaw);
        ray = vec3(cy * ray.x + sy * ray.z, ray.y, -sy * ray.x + cy * ray.z);
        vec2 uv = vec2(atan(ray.x, ray.z) / (2.0 * PI) + 0.5,
                       0.5 + asin(clamp(ray.y, -1.0, 1.0)) / PI);
        gl_FragColor = texture2D(u_panorama, uv);
      }
    `;

    const compileShader = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || "Shader compilation failed";
        gl.deleteShader(shader);
        throw new Error(message);
      }
      return shader;
    };
    try {
      gl = canvas.getContext("webgl", { alpha: false, antialias: false });
      if (!gl) throw new Error("WebGL unavailable");
      program = gl.createProgram();
      gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexSource));
      gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentSource));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "Program link failed");
      gl.useProgram(program);

      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } catch (error) {
      console.warn("[Time image] panorama viewer initialization failed", error);
      status.textContent = t("webgl");
      empty.textContent = t("webgl");
    }

    const draw = () => {
      if (!gl || !program || !texture || !image || disposed) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), width, height);
      gl.uniform1f(gl.getUniformLocation(program, "u_yaw"), yaw);
      gl.uniform1f(gl.getUniformLocation(program, "u_pitch"), pitch);
      gl.uniform1f(gl.getUniformLocation(program, "u_fov"), fov);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const observer = new ResizeObserver(draw);
    observer.observe(viewport);

    const resetView = () => { yaw = 0; pitch = 0; fov = 82; syncCamera(); draw(); };
    reset.onclick = resetView;
    fullscreen.onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await viewport.requestFullscreen();
      } catch (error) { console.warn("[Time image] fullscreen request failed", error); }
    };
    const onFullscreenChange = () => {
      draw();
      fullscreen.textContent = document.fullscreenElement === viewport ? t("exitFullscreen") : t("fullscreen");
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);

    canvas.addEventListener("pointerdown", (event) => {
      if (!image) return;
      pointer = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture?.(event.pointerId);
      canvas.style.cursor = "grabbing";
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!pointer) return;
      yaw -= (event.clientX - pointer.x) * (2 * Math.PI / Math.max(1, canvas.clientWidth));
      pitch = clamp(pitch + (event.clientY - pointer.y) * (Math.PI / Math.max(1, canvas.clientHeight)), -Math.PI / 2, Math.PI / 2);
      pointer = { x: event.clientX, y: event.clientY };
      syncCamera();
      draw();
    });
    const stopDrag = () => { pointer = null; canvas.style.cursor = "grab"; };
    canvas.addEventListener("pointerup", stopDrag);
    canvas.addEventListener("pointercancel", stopDrag);
    canvas.addEventListener("wheel", (event) => {
      if (!image) return;
      event.preventDefault();
      fov = clamp(fov + event.deltaY * 0.06, 12, 150);
      syncCamera();
      draw();
    }, { passive: false });

    const showPreview = (file) => {
      if (!file?.filename) return;
      if (image) image.onload = image.onerror = null;
      image = new Image();
      image.onload = () => {
        if (!gl || !texture) return;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        empty.style.display = "none";
        const ratio = image.naturalWidth / Math.max(1, image.naturalHeight);
        const note = Math.abs(ratio - 2) < 0.08 ? t("drag") : `${t("drag")} · ${t("equirectangular")}`;
        status.textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${note}`;
        yaw = Number(widget("camera_yaw")?.value || 0);
        pitch = Number(widget("camera_pitch")?.value || 0);
        fov = Number(widget("camera_fov")?.value || 82);
        syncCamera();
        draw();
      };
      image.onerror = () => { status.textContent = t("loadError"); empty.style.display = "flex"; empty.textContent = t("loadError"); };
      const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "temp", t: String(Date.now()) });
      image.src = api.apiURL(`/view?${params.toString()}`);
    };

    const originalExecuted = node.onExecuted;
    node.onExecuted = function (message) {
      const files = message?.panorama || message?.output?.panorama;
      const views = message?.views || message?.output?.views;
      if (Array.isArray(views)) { viewFiles = views; if (multiToggle.checked) renderViewCards(); }
      if (Array.isArray(files) && files[0]) showPreview(files[0]);
      return originalExecuted?.apply(this, arguments);
    };

    const onLocaleChange = (event) => {
      locale = language(event?.detail?.value);
      reset.textContent = t("reset");
      multiText.textContent = t("multiView");
      galleryHint.textContent = t("chooseHint");
      if (multiToggle.checked) renderViewCards();
      onFullscreenChange();
      if (!image) { status.textContent = t("empty"); empty.textContent = t("empty"); }
    };
    app.ui?.settings?.addEventListener?.("Comfy.Locale.change", onLocaleChange);

    let viewerWidgetHeight = 340;
    const syncViewerSize = () => {
      // Leave roughly 90 px for the node title and footer. The original
      // widget was fixed at 340 px, which made vertical node resizing inert.
      const galleryHeight = multiToggle.checked ? 140 : 0;
      viewerWidgetHeight = Math.max(340 + galleryHeight, (node.size?.[1] || 430) - 90);
      root.style.height = `${viewerWidgetHeight}px`;
      viewport.style.height = `${Math.max(160, viewerWidgetHeight - 60 - galleryHeight)}px`;
      syncCamera();
      draw();
    };

    node.addDOMWidget("panorama_viewer", "div", root, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => viewerWidgetHeight,
      getMaxHeight: () => viewerWidgetHeight,
    });
    if (!node.size) node.setSize([540, 430]);
    else if (node.size[0] < 500 || node.size[1] < 380) {
      node.setSize([Math.max(500, node.size[0]), Math.max(380, node.size[1])]);
    }
    syncViewerSize();
    updateMultiView();

    const originalResize = node.onResize;
    node.onResize = function () {
      const result = originalResize?.apply(this, arguments);
      requestAnimationFrame(syncViewerSize);
      return result;
    };

    const originalRemoved = node.onRemoved;
    node.onRemoved = function () {
      disposed = true;
      observer.disconnect();
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      app.ui?.settings?.removeEventListener?.("Comfy.Locale.change", onLocaleChange);
      if (image) image.onload = image.onerror = null;
      return originalRemoved?.apply(this, arguments);
    };
  },
});
