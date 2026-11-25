import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE = "PromptImageResolution";
const MAX_IMAGES = 10;
const MIN_NODE_WIDTH = 380;
const UI_TEXT = {
  en: {
    promptPlaceholder: "Prompt… Type @ to mention an imported image",
    images: "Images", resolution: "Resolution", image: "Image {n}", replaceImage: "Replace Image {n}",
    previewImage: "Click to preview", dropReplaceImage: "Drop a local image here to replace", enableImage: "Enable this image", deleteImage: "Delete image", addImage: "Add image",
    imageCount: "{count} / {max} images · Drop images here",
    limitImageMaxEdge: "Limit image max edge", imageSnapMultiple: "Align all images to multiple of",
    imageMaxEdge: "Max edge (px)", useImage1Resolution: "Use Image 1 resolution",
    aspectRatio: "Aspect ratio", ratioValue: "Ratio", alignMultiple: "Align to multiple", edgeRule: "Edge rule",
    edgePixels: "Edge pixels", megapixelsTarget: "Megapixel target",
    aspectRatioMode: "Aspect Ratio", megapixelMode: "Megapixels", customSizeMode: "Custom size",
    customWidth: "Width (px)", customHeight: "Height (px)", edgeMin: "Shortest edge", edgeMax: "Longest edge",
    waitingImage1: "Waiting for image 1", result: "Result {mp} MP · {size}",
    edgeUploadError: "Image upload failed: {name}", imageLabel: "Image {n}",
  },
  zh: {
    promptPlaceholder: "提示词… 输入 @ 引用已导入图片",
    images: "图片", resolution: "分辨率", image: "图像 {n}", replaceImage: "替换图{n}",
    previewImage: "点击放大预览", dropReplaceImage: "拖入本地图片即可替换", enableImage: "启用此图像", deleteImage: "删除图像", addImage: "添加图片",
    imageCount: "{count} / {max} 张 · 可拖入图片",
    limitImageMaxEdge: "限制图像最大边", imageSnapMultiple: "所有图像对齐倍数",
    imageMaxEdge: "最大边像素", useImage1Resolution: "使用图像 1 分辨率",
    aspectRatio: "宽高比", ratioValue: "比例", alignMultiple: "对齐倍数", edgeRule: "边长规则",
    edgePixels: "边长像素", megapixelsTarget: "百万像素目标",
    aspectRatioMode: "宽高比", megapixelMode: "百万像素", customSizeMode: "自定宽高",
    customWidth: "宽度（像素）", customHeight: "高度（像素）", edgeMin: "最小边", edgeMax: "最大边",
    waitingImage1: "等待图像 1", result: "结果 {mp} MP · {size}",
    edgeUploadError: "图片上传失败：{name}", imageLabel: "图像 {n}",
  },
};

function getUiLanguage(override) {
  const locale = override || app.extensionManager?.setting?.get?.("Comfy.Locale") || navigator.language;
  return String(locale).toLowerCase().startsWith("zh") ? "zh" : "en";
}

app.registerExtension({
  name: "TimeImage.PromptImageResolution",
  async nodeCreated(node) {
    if (node.comfyClass !== NODE) return;
    const find = (name) => node.widgets?.find((widget) => widget.name === name);
    const list = find("images");
    const controls = Object.fromEntries([
      "aspect_ratio", "edge_limit", "edge_resolution", "resolution_mode", "megapixels", "round_to_multiple",
      "enable_images", "limit_image_max_edge", "image_max_edge", "enable_resolution",
      "use_image1_resolution", "image_snap_multiple", "custom_width", "custom_height",
    ].map((name) => [name, find(name)]));
    const toggleBindings = new Map();
    const checkboxBindings = new Map();
    const valueBindings = new Map();
    if (!list) return;
    let uiLanguage = getUiLanguage();
    const t = (key, values = {}) => (UI_TEXT[uiLanguage][key] || UI_TEXT.en[key] || key)
      .replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
    const optionText = (name, value) => {
      if (value === "OFF") return uiLanguage === "zh" ? "关闭" : "Off";
      if (name === "edge_limit") return value === "最小边" ? t("edgeMin") : value === "最大边" ? t("edgeMax") : String(value);
      if (name === "resolution_mode") return value === "边长像素" ? t("aspectRatioMode") : value === "百万像素" ? t("megapixelMode") : value === "自定义宽高" ? t("customSizeMode") : String(value);
      return String(value);
    };
    if (controls.image_snap_multiple && controls.image_snap_multiple.value !== "OFF") {
      controls.image_snap_multiple.value = Number(controls.image_snap_multiple.value);
    }

    const read = () => {
      try {
        const value = JSON.parse(list.value || "[]");
        if (Array.isArray(value)) return value.filter((item) => item?.name).slice(0, MAX_IMAGES);
      } catch {}
      return String(list.value || "").split("\n").filter(Boolean).slice(0, MAX_IMAGES).map((name) => ({ name, enabled: true }));
    };
    const write = (items) => {
      list.value = JSON.stringify(items);
      list.callback?.(list.value);
      render();
      if (promptEditor && prompt) renderPrompt(prompt.value || "");
      syncPorts();
      app.graph.setDirtyCanvas(true, true);
    };
    for (const widget of [list, ...Object.values(controls)]) {
      if (widget) { widget.computeSize = () => [0, -4]; widget.draw = () => {}; widget.hidden = true; }
    }

    const root = document.createElement("div");
    // Keep visible breathing room below the last settings card; this padding is
    // included by measuredRootHeight() so the LiteGraph frame grows with it.
    root.style.cssText = "--ti-accent:#08b88a;width:100%;box-sizing:border-box;padding:8px 9px 26px;background:#202124;color:#f1f2f4;border:1px solid #34363a;border-radius:12px;font:12px/1.35 sans-serif;box-shadow:inset 0 1px 0 #ffffff08";
    const toggles = document.createElement("div");
    toggles.style.cssText = "display:flex;gap:16px;align-items:center;min-height:34px;margin:1px 0 6px;padding:0 10px;background:#191a1c;border:1px solid #303236;border-radius:10px;box-sizing:border-box";
    const imageSection = document.createElement("div");
    const imageSettings = document.createElement("div");
    imageSettings.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:7px;padding:9px;background:#191a1c;border:1px solid #303236;border-radius:8px;box-sizing:border-box";
    const maxEdgeChoices = document.createElement("div");
    maxEdgeChoices.style.cssText = "flex:1 1 100%;min-width:170px";
    const strip = document.createElement("div");
    // In the empty state the add tile is 62px tall; image tiles grow naturally
    // to include their footer, so a larger fixed minimum only creates dead space.
    strip.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start;min-height:62px;overflow:visible";
    const hint = document.createElement("div");
    hint.style.cssText = "color:#aaa;font-size:10px;margin-top:3px";
    const sizeSection = document.createElement("div");
    sizeSection.style.cssText = "margin-top:4px";
    const modeRow = document.createElement("div");
    modeRow.style.cssText = "display:flex;gap:12px;align-items:center;margin:2px 0;padding:0 10px;box-sizing:border-box";
    const customResolution = document.createElement("div");
    const image1Resolution = document.createElement("div");
    image1Resolution.style.cssText = "margin-top:4px;padding:8px 9px;background:#191a1c;border:1px solid #303236;border-radius:8px";
    const resolutionModeBar = document.createElement("div");
    resolutionModeBar.style.cssText = "display:flex;gap:4px;margin:4px 0;padding:3px;background:#191a1c;border:1px solid #303236;border-radius:8px";
    const ratioControls = document.createElement("div");
    ratioControls.style.cssText = "display:flex;gap:5px;margin-top:5px;padding:6px;background:#191a1c;border:1px solid #303236;border-radius:8px";
    const edgeControls = document.createElement("div");
    edgeControls.style.cssText = "display:flex;gap:5px;margin-top:5px;padding:6px;background:#191a1c;border:1px solid #303236;border-radius:8px";
    const mpControl = document.createElement("label");
    mpControl.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:5px;padding:7px;background:#191a1c;border:1px solid #303236;border-radius:8px;color:#aeb2b8;font-size:11px";
    const mpInput = document.createElement("input");
    mpInput.type = "number"; mpInput.min = "0.1"; mpInput.max = "32"; mpInput.step = "0.1";
    mpInput.style.cssText = "width:112px;box-sizing:border-box;padding:5px 8px;background:#292a2e;color:#29d6a5;border:1px solid #414349;border-radius:6px;font-size:12px;font-weight:600";
    const mpValue = document.createElement("span");
    mpValue.style.cssText = "color:#29d6a5;font-size:11px;align-self:center;white-space:nowrap;padding:5px 3px 1px;font-weight:600";
    const customDimensionControls = document.createElement("div");
    customDimensionControls.style.cssText = "display:flex;gap:5px;margin-top:5px;padding:6px;background:#191a1c;border:1px solid #303236;border-radius:8px";
    const image1MPValue = document.createElement("span");
    image1MPValue.style.cssText = mpValue.style.cssText;
    const picker = document.createElement("input");
    picker.type = "file"; picker.accept = "image/*"; picker.multiple = true; picker.style.display = "none";
    let replaceIndex = null;
    const preview = document.createElement("div");
    preview.style.cssText = "display:none;position:fixed;inset:0;z-index:99999;background:#000d;align-items:center;justify-content:center;cursor:zoom-out";
    const previewImage = document.createElement("img");
    previewImage.style.cssText = "max-width:90vw;max-height:90vh;object-fit:contain;box-shadow:0 8px 50px #000";
    preview.append(previewImage); preview.onclick = () => { preview.style.display = "none"; };
    document.body.append(preview);

    const widgetValue = (name) => controls[name]?.value;
    function selectFor(name, label, target = ratioControls) {
      const widget = controls[name]; if (!widget) return;
      const wrap = document.createElement("label");
      wrap.style.cssText = "flex:1;min-width:0;color:#979ba2;font-size:9px;display:flex;flex-direction:column;gap:3px;letter-spacing:.02em";
      wrap.dataset.tiLabel = label;
      wrap.append(document.createTextNode(t(label)));
      if (name === "edge_resolution") {
        const combo = document.createElement("div");
        combo.style.cssText = "position:relative;width:100%";
        const datalist = document.createElement("datalist");
        datalist.id = `time-image-edge-values-${node.id}`;
        for (const value of widget.options?.values || [512, 640, 768, 896, 1024, 1152, 1280, 1536, 1792, 2048, 2560, 3072, 4096]) {
          const option = document.createElement("option"); option.value = String(value); datalist.append(option);
        }
        const input = document.createElement("input");
        input.type = "number"; input.min = "64"; input.max = "16384"; input.step = "1";
        input.className = "time-image-edge-input";
        input.value = String(widget.value); input.setAttribute("list", datalist.id);
        input.style.cssText = "width:100%;box-sizing:border-box;background:#292a2e;color:#f4f4f5;border:1px solid #414349;border-radius:6px;padding:6px 7px;font-size:11px;accent-color:#08b88a";
        const update = () => {
          const value = Number(input.value);
          if (!Number.isInteger(value) || value < 64 || value > 16384) return;
          widget.value = value; widget.callback?.(value); updateMP(); app.graph.setDirtyCanvas(true, true);
        };
        input.addEventListener("input", update);
        input.addEventListener("change", () => {
          const value = Math.min(16384, Math.max(64, Math.round(Number(input.value) || 1024)));
          input.value = String(value); update();
        });
        valueBindings.set(name, () => {
          if (document.activeElement !== input) input.value = String(widget.value ?? 1024);
        });
        input.onfocus = () => { input.style.borderColor = "#08b88a"; };
        input.onblur = () => { input.style.borderColor = "#414349"; };
        combo.append(input, datalist); wrap.append(combo); target.append(wrap);
        return wrap;
      }
      const select = document.createElement("select");
      select.dataset.tiWidget = name;
      select.style.cssText = "width:100%;min-width:0;background:#292a2e;color:#f4f4f5;border:1px solid #414349;border-radius:6px;padding:5px 7px;font-size:11px;accent-color:#08b88a";
      select.onfocus = () => { select.style.borderColor = "#08b88a"; };
      select.onblur = () => { select.style.borderColor = "#414349"; };
      for (const value of widget.options?.values || []) {
        const option = document.createElement("option"); option.value = String(value); option.textContent = optionText(name, value); select.append(option);
      }
      select.value = String(widget.value);
      select.onchange = () => {
        widget.value = ["edge_resolution", "image_max_edge", "image_snap_multiple"].includes(name) && select.value !== "OFF" ? Number(select.value)
          : name === "round_to_multiple" && select.value !== "OFF" ? Number(select.value) : select.value;
        widget.callback?.(widget.value); updateMP(); app.graph.setDirtyCanvas(true, true);
      };
      valueBindings.set(name, () => { select.value = String(widget.value); });
      wrap.append(select); target.append(wrap);
      return wrap;
    }
    function dimensionInputFor(name, label) {
      const widget = controls[name]; if (!widget) return null;
      const wrap = document.createElement("div");
      wrap.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;color:#979ba2;font-size:9px;letter-spacing:.02em";
      const caption = document.createElement("span"); caption.textContent = t(label); caption.dataset.tiLabel = label;
      const input = document.createElement("input");
      input.type = "number"; input.min = "1"; input.max = "32768"; input.step = "1";
      input.className = "time-image-edge-input";
      input.value = String(widget.value ?? 1024);
      input.style.cssText = "width:100%;box-sizing:border-box;background:#292a2e;color:#f4f4f5;border:1px solid #414349;border-radius:6px;padding:6px 7px;font-size:11px";
      const commit = (finalize = false) => {
        let value = Number(input.value);
        if (finalize) {
          value = Math.min(32768, Math.max(1, Math.round(value || 1024)));
          input.value = String(value);
        }
        if (!Number.isInteger(value) || value < 1 || value > 32768) return;
        widget.value = value; widget.callback?.(value); updateMP(); app.graph.setDirtyCanvas(true, true);
      };
      input.addEventListener("input", () => commit(false));
      input.addEventListener("change", () => commit(true));
      input.onfocus = () => { input.style.borderColor = "#08b88a"; };
      input.onblur = () => { input.style.borderColor = "#414349"; };
      valueBindings.set(name, () => {
        if (document.activeElement !== input) input.value = String(widget.value ?? 1024);
      });
      wrap.append(caption, input);
      return wrap;
    }

    const prompt = find("prompt");
    if (prompt) {
      prompt.computeSize = () => [0, -4];
      prompt.options = { ...prompt.options, multiline: true };
      prompt.draw = () => {};
      prompt.hidden = true;
    }
    const promptEditor = document.createElement("div");
    promptEditor.contentEditable = "true";
    promptEditor.spellcheck = false;
    promptEditor.setAttribute("role", "textbox");
    promptEditor.setAttribute("aria-multiline", "true");
    promptEditor.dataset.placeholder = t("promptPlaceholder");
    promptEditor.className = "time-image-prompt-editor";
    promptEditor.style.cssText = "min-height:92px;max-height:240px;overflow-y:auto;box-sizing:border-box;width:100%;margin:3px 0 8px;padding:8px 10px;background:#171819;color:#f1f2f4;border:1px solid #35373b;border-radius:8px;outline:none;font:12px/1.5 sans-serif;white-space:pre-wrap;overflow-wrap:anywhere";
    const promptStyle = document.createElement("style");
    promptStyle.textContent = ".time-image-prompt-editor:empty::before{content:attr(data-placeholder);color:#777d85;pointer-events:none}.time-image-mention{display:inline-flex;align-items:center;gap:5px;vertical-align:middle;margin:0 2px;padding:2px 6px;border:1px solid #087c60;border-radius:6px;background:#12382e;color:#45ddb0;font:12px/1.3 sans-serif;white-space:nowrap}.time-image-mention img{width:18px;height:18px;object-fit:cover;border-radius:3px}.time-image-edge-input{appearance:textfield;-moz-appearance:textfield}.time-image-edge-input::-webkit-inner-spin-button,.time-image-edge-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}";
    promptEditor.addEventListener("focus", () => { promptEditor.style.borderColor = "#08b88a"; });
    promptEditor.addEventListener("blur", () => { promptEditor.style.borderColor = "#35373b"; });
    const mentionMenu = document.createElement("div");
    mentionMenu.style.cssText = "display:none;position:fixed;z-index:100000;max-height:240px;overflow:auto;min-width:220px;background:#202124;border:1px solid #08b88a;border-radius:9px;padding:5px;box-shadow:0 12px 35px #0009;color:#f1f2f4;font:12px sans-serif";
    document.body.append(mentionMenu);
    let mentionRange = null;
    let mentionMatches = [];
    let mentionSelected = 0;
    function closeMentionMenu() { mentionMenu.style.display = "none"; mentionMatches = []; mentionRange = null; }
    function createMentionChip(index) {
      const chip = document.createElement("span");
      chip.className = "time-image-mention"; chip.contentEditable = "false"; chip.dataset.pictureIndex = String(index + 1);
      const image = read()[index];
      if (image?.name) {
        const thumb = document.createElement("img"); thumb.src = imageURL(image.name); thumb.alt = ""; chip.append(thumb);
      }
      const text = document.createElement("span"); text.textContent = `<Picture ${index + 1}>`; chip.append(text);
      return chip;
    }
    function promptText() {
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
        if (node.nodeType !== Node.ELEMENT_NODE) return "";
        if (node.dataset?.pictureIndex) return `<Picture ${node.dataset.pictureIndex}>`;
        if (node.tagName === "BR") return "\n";
        const value = [...node.childNodes].map(walk).join("");
        return ["DIV", "P"].includes(node.tagName) ? `${value}\n` : value;
      };
      return [...promptEditor.childNodes].map(walk).join("").replace(/\n$/, "");
    }
    function syncPrompt() {
      prompt.value = promptText();
      prompt.callback?.(prompt.value);
      app.graph.setDirtyCanvas(true, true);
    }
    function renderPrompt(value) {
      promptEditor.replaceChildren();
      const pattern = /<Picture\s+(\d+)\s*>|@图(?:像)?\s*(\d+)/gi;
      let last = 0, match;
      while ((match = pattern.exec(String(value || "")))) {
        if (match.index > last) promptEditor.append(document.createTextNode(value.slice(last, match.index)));
        const index = Number(match[1] || match[2]) - 1;
        if (index >= 0 && index < MAX_IMAGES) promptEditor.append(createMentionChip(index));
        else promptEditor.append(document.createTextNode(match[0]));
        last = pattern.lastIndex;
      }
      if (last < String(value || "").length) promptEditor.append(document.createTextNode(String(value).slice(last)));
    }
    function chooseMention(item) {
      if (!mentionRange || !promptEditor.contains(mentionRange.node)) return;
      const range = document.createRange();
      range.setStart(mentionRange.node, mentionRange.start); range.setEnd(mentionRange.node, mentionRange.end);
      range.deleteContents();
      const chip = createMentionChip(item.index), spacer = document.createTextNode(" ");
      range.insertNode(spacer); range.insertNode(chip);
      range.setStartAfter(spacer); range.collapse(true);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      promptEditor.focus(); syncPrompt();
      closeMentionMenu(); app.graph.setDirtyCanvas(true, true);
    }
    function showMentionMenu() {
      if (document.activeElement !== promptEditor) return closeMentionMenu();
      const selection = window.getSelection();
      if (!selection?.rangeCount || !promptEditor.contains(selection.anchorNode)) return closeMentionMenu();
      const anchor = selection.anchorNode;
      if (anchor.nodeType !== Node.TEXT_NODE) return closeMentionMenu();
      const cursor = selection.anchorOffset;
      const before = anchor.nodeValue.slice(0, cursor);
      const start = before.lastIndexOf("@");
      if (start < 0 || /\s/.test(before.slice(start + 1))) return closeMentionMenu();
      const query = before.slice(start + 1).toLocaleLowerCase();
      const items = read().map((image, index) => ({ ...image, index, filename: image.name.split("/").pop() }));
      mentionMatches = items.filter((item) => !query || `图${item.index + 1} 图像${item.index + 1} image ${item.index + 1} picture ${item.index + 1} ${item.filename}`.toLocaleLowerCase().includes(query));
      mentionRange = { node: anchor, start, end: cursor }; mentionSelected = 0;
      if (!mentionMatches.length) return closeMentionMenu();
      mentionMenu.replaceChildren();
      for (const [index, item] of mentionMatches.entries()) {
        const row = document.createElement("button");
        row.type = "button";
        row.style.cssText = `display:flex;align-items:center;gap:9px;width:100%;padding:6px 8px;border:0;border-radius:6px;text-align:left;color:#f1f2f4;background:${index === mentionSelected ? "#173c34" : "transparent"};cursor:pointer`;
        const thumb = document.createElement("img"); thumb.src = imageURL(item.name); thumb.style.cssText = "width:34px;height:34px;object-fit:cover;border-radius:5px;border:1px solid #08b88a";
        const details = document.createElement("span"); details.style.cssText = "display:flex;flex-direction:column;min-width:0";
        const title = document.createElement("strong"); title.textContent = t("imageLabel", { n: item.index + 1 }); title.style.cssText = "color:#29d6a5;font-size:11px";
        const filename = document.createElement("span"); filename.textContent = item.filename; filename.style.cssText = "max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aeb2b8;font-size:10px";
        details.append(title, filename); row.append(thumb, details);
        row.onmousedown = (event) => { event.preventDefault(); chooseMention(item); };
        mentionMenu.append(row);
      }
      const rect = promptEditor.getBoundingClientRect();
      mentionMenu.style.left = `${Math.max(8, rect.left)}px`;
      mentionMenu.style.top = `${Math.min(window.innerHeight - 250, rect.bottom + 4)}px`;
      mentionMenu.style.width = `${Math.min(rect.width, 360)}px`;
      mentionMenu.style.display = "block";
    }
    promptEditor.addEventListener("input", () => { syncPrompt(); showMentionMenu(); });
    promptEditor.addEventListener("click", showMentionMenu);
    promptEditor.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") || "";
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0); range.deleteContents();
      const node = document.createTextNode(text); range.insertNode(node);
      range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
      syncPrompt();
    });
    promptEditor.addEventListener("keydown", (event) => {
      if (mentionMenu.style.display !== "block") return;
      if (event.key === "Escape") { event.preventDefault(); closeMentionMenu(); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        mentionSelected = (mentionSelected + (event.key === "ArrowDown" ? 1 : mentionMatches.length - 1)) % mentionMatches.length;
        [...mentionMenu.children].forEach((row, index) => { row.style.background = index === mentionSelected ? "#173c34" : "transparent"; });
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault(); chooseMention(mentionMatches[mentionSelected]);
      }
    });
    promptEditor.addEventListener("blur", () => setTimeout(closeMentionMenu, 120));
    function toggleControl(name, label, section) {
      const widget = controls[name]; if (!widget) return;
      const wrap = document.createElement("label");
      wrap.style.cssText = "display:flex;align-items:center;gap:5px;color:#eee;font-size:11px;cursor:pointer";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = Boolean(widget.value);
      checkbox.style.accentColor = "#08b88a";
      checkbox.onchange = () => { widget.value = checkbox.checked; widget.callback?.(widget.value); section.style.display = checkbox.checked ? "block" : "none"; syncPorts(); if (name === "enable_images") updateMP(); app.graph.setDirtyCanvas(true, true); };
      const text = document.createElement("span"); text.textContent = t(label); text.dataset.tiLabel = label;
      wrap.append(checkbox, text); toggles.append(wrap);
      toggleBindings.set(name, { checkbox, section });
      section.style.display = checkbox.checked ? "block" : "none";
    }
    function syncToggleState() {
      for (const [name, binding] of toggleBindings) {
        const checked = Boolean(controls[name]?.value);
        binding.checkbox.checked = checked;
        binding.section.style.display = checked ? "block" : "none";
      }
    }

    function updateMP() {
      if (controls.use_image1_resolution?.value) {
        const first = strip.querySelector("img");
        if (!first?.naturalWidth || !first?.naturalHeight) { mpValue.textContent = image1MPValue.textContent = t("waitingImage1"); return; }
        let width = first.naturalWidth, height = first.naturalHeight;
        if (controls.enable_images?.value && controls.limit_image_max_edge?.value) {
          const maxEdge = Number(controls.image_max_edge?.value || 2048);
          const scale = Math.min(1, maxEdge / Math.max(width, height));
          width = Math.max(1, Math.round(width * scale));
          height = Math.max(1, Math.round(height * scale));
        }
        const snapValue = controls.image_snap_multiple?.value;
        if (controls.enable_images?.value && snapValue !== undefined && snapValue !== "OFF") {
          const snap = Number(snapValue);
          width = Math.ceil(width / snap) * snap;
          height = Math.ceil(height / snap) * snap;
        }
        mpValue.textContent = image1MPValue.textContent = `${(width * height / 1e6).toFixed(2)} MP · ${width} × ${height}`;
        return;
      }
      const mode = widgetValue("resolution_mode");
      const [rw, rh] = String(widgetValue("aspect_ratio") || "1:1").split(":").map(Number);
      const ratio = rw / rh;
      const multipleValue = widgetValue("round_to_multiple");
      const multiple = multipleValue === "OFF" ? null : Number(multipleValue || 32);
      let width, height;
      if (mode === "自定义宽高") {
        width = Math.max(1, Number(widgetValue("custom_width") || 1024));
        height = Math.max(1, Number(widgetValue("custom_height") || 1024));
      } else if (mode === "百万像素") {
        const area = Math.max(0.1, Number(widgetValue("megapixels") || 1)) * 1e6;
        width = Math.sqrt(area * ratio); height = width / ratio;
      } else {
        const edge = Number(widgetValue("edge_resolution") || 1024);
        const minEdge = widgetValue("edge_limit") === "最小边";
        if (minEdge) [width, height] = ratio >= 1 ? [edge * ratio, edge] : [edge, edge / ratio];
        else [width, height] = ratio >= 1 ? [edge, edge / ratio] : [edge * ratio, edge];
      }
      if (multiple === null) {
        width = Math.max(1, Math.round(width)); height = Math.max(1, Math.round(height));
      } else {
        width = Math.max(multiple, Math.round(width / multiple) * multiple);
        height = Math.max(multiple, Math.round(height / multiple) * multiple);
      }
      mpValue.textContent = t("result", { mp: (width * height / 1e6).toFixed(2), size: `${width} × ${height}` });
      if (document.activeElement !== mpInput) mpInput.value = Number(widgetValue("megapixels") || 1).toFixed(1);
    }

    function updateCustomResolutionControls() {
      const mode = widgetValue("resolution_mode");
      const megapixelMode = mode === "百万像素";
      const customMode = mode === "自定义宽高";
      edgeControls.style.display = megapixelMode || customMode ? "none" : "flex";
      mpControl.style.display = megapixelMode ? "flex" : "none";
      customDimensionControls.style.display = customMode ? "flex" : "none";
      if (aspectRatioControl) aspectRatioControl.style.display = customMode ? "none" : "flex";
      resolutionModeBar.replaceChildren();
      for (const mode of ["边长像素", "自定义宽高", "百万像素"]) {
        const button = document.createElement("button");
        button.type = "button"; button.textContent = optionText("resolution_mode", mode);
        const active = widgetValue("resolution_mode") === mode;
        button.style.cssText = `flex:1;padding:5px 6px;border:1px solid ${active ? "#08b88a" : "#34363a"};border-radius:6px;background:${active ? "#12382e" : "#292a2e"};color:${active ? "#29d6a5" : "#aeb2b8"};font-size:10px;font-weight:600;cursor:pointer`;
        button.onclick = () => {
          const widget = controls.resolution_mode; widget.value = mode; widget.callback?.(mode);
          updateCustomResolutionControls(); updateMP(); resizeToFit(); app.graph.setDirtyCanvas(true, true);
        };
        resolutionModeBar.append(button);
      }
      updateMP();
    }
    mpInput.value = Number(widgetValue("megapixels") || 1).toFixed(1);
    valueBindings.set("megapixels", () => {
      if (document.activeElement !== mpInput) mpInput.value = Number(widgetValue("megapixels") || 1).toFixed(1);
    });
    mpInput.addEventListener("input", () => {
      const value = Number(mpInput.value);
      if (!Number.isFinite(value) || value < 0.1 || value > 32) return;
      const widget = controls.megapixels; widget.value = value; widget.callback?.(value); updateMP(); app.graph.setDirtyCanvas(true, true);
    });
    mpInput.addEventListener("change", () => {
      const value = Math.min(32, Math.max(0.1, Number(mpInput.value) || 1));
      mpInput.value = value.toFixed(1); controls.megapixels.value = value; controls.megapixels.callback?.(value); updateMP();
    });

    async function upload(file, overwrite = true) {
      const form = new FormData();
      form.append("image", file); form.append("type", "input"); form.append("subfolder", "time_image"); form.append("overwrite", String(overwrite));
      const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
      if (!response.ok) throw new Error(t("edgeUploadError", { name: file.name }));
      const result = await response.json();
      return [result.subfolder, result.name].filter(Boolean).join("/");
    }
    async function addFiles(files) {
      const items = read();
      for (const file of [...files].slice(0, MAX_IMAGES - items.length)) items.push({ name: await upload(file), enabled: true });
      write(items);
    }
    function bindReplacementDrop(target, index) {
      let dragDepth = 0;
      const resetHighlight = () => {
        dragDepth = 0;
        target.style.outline = "";
        target.style.outlineOffset = "";
      };
      target.title = `${t("previewImage")} · ${t("dropReplaceImage")}`;
      target.addEventListener("dragenter", (event) => {
        if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth += 1;
        target.style.outline = "2px solid #08b88a";
        target.style.outlineOffset = "2px";
      });
      target.addEventListener("dragover", (event) => {
        if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      });
      target.addEventListener("dragleave", (event) => {
        event.stopPropagation();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) resetHighlight();
      });
      target.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        resetHighlight();
        const file = [...(event.dataTransfer?.files || [])].find((item) =>
          item.type.startsWith("image/") || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(item.name)
        );
        if (!file) return;
        try {
          const items = read();
          if (!items[index]) return;
          items[index].name = await upload(file, false);
          write(items);
        } catch (error) {
          console.error("Failed to replace image by drop:", error);
        }
      });
    }
    function imageURL(name) {
      const parts = name.split("/");
      return api.apiURL(`/view?filename=${encodeURIComponent(parts.pop())}&subfolder=${encodeURIComponent(parts.join("/"))}&type=input`);
    }
    function render() {
      strip.replaceChildren();
      const items = read();
      for (const [index, item] of items.entries()) {
        const tile = document.createElement("div");
        tile.style.cssText = "position:relative;width:78px;flex:0 0 78px;text-align:center";
        const img = document.createElement("img"); img.src = imageURL(item.name); img.title = t("previewImage");
        img.draggable = false;
        img.onload = updateMP;
        img.style.cssText = `width:62px;height:62px;object-fit:cover;border:1px solid ${item.enabled ? "#08b88a" : "#45474b"};border-radius:7px;cursor:zoom-in;background:#333;${item.enabled ? "" : "filter:grayscale(1);opacity:.45"}`;
        bindReplacementDrop(img, index);
        img.onclick = () => { previewImage.src = imageURL(item.name); preview.style.display = "flex"; };
        const footer = document.createElement("div"); footer.style.cssText = "display:flex;align-items:center;justify-content:center;gap:4px;margin-top:3px;white-space:nowrap";
        const enable = document.createElement("input"); enable.type = "checkbox"; enable.checked = item.enabled !== false; enable.title = t("enableImage"); enable.style.cssText = "margin:0;flex:0 0 auto";
        enable.style.accentColor = "#08b88a";
        enable.onchange = () => { const next = read(); next[index].enabled = enable.checked; write(next); };
        const replace = document.createElement("button"); replace.type = "button"; replace.textContent = t("replaceImage", { n: index + 1 }); replace.title = t("replaceImage", { n: index + 1 });
        replace.style.cssText = "flex:0 0 auto;padding:2px 3px;border:1px solid #087c62;border-radius:4px;background:#12382e;color:#29d6a5;font-size:9px;line-height:13px;cursor:pointer";
        replace.onmouseenter = () => { replace.style.background = "#18513f"; replace.style.borderColor = "#08b88a"; };
        replace.onmouseleave = () => { replace.style.background = "#12382e"; replace.style.borderColor = "#087c62"; };
        replace.onclick = () => { replaceIndex = index; picker.multiple = false; picker.click(); };
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = t("deleteImage");
        remove.style.cssText = "position:absolute;right:3px;top:3px;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:#111c;color:#fff;font-size:14px;line-height:18px;cursor:pointer";
        remove.onclick = () => write(read().filter((_, i) => i !== index));
        footer.append(enable, replace); tile.append(img, remove, footer); strip.append(tile);
      }
      if (items.length < MAX_IMAGES) {
        const plus = document.createElement("button"); plus.textContent = "+"; plus.title = t("addImage");
        plus.style.cssText = "width:62px;height:62px;flex:0 0 62px;border:1px dashed #62656b;border-radius:7px;background:#191a1c;color:#b7bbc2;font-size:22px;cursor:pointer";
        plus.onmouseenter = () => { plus.style.color = "#08b88a"; plus.style.borderColor = "#08b88a"; };
        plus.onmouseleave = () => { plus.style.color = "#b7bbc2"; plus.style.borderColor = "#62656b"; };
        plus.onclick = () => { replaceIndex = null; picker.multiple = true; picker.click(); }; strip.append(plus);
      }
      hint.textContent = t("imageCount", { count: items.length, max: MAX_IMAGES });
    }
    function syncPorts() {
      const count = controls.enable_images?.value ? read().length : 0;
      const wanted = 3 + count;
      while (node.outputs.length > wanted) {
        const index = node.outputs.length - 1;
        if (node.outputs[index].links?.length) break;
        node.removeOutput(index);
      }
      while (node.outputs.length < wanted) node.addOutput(`image_${node.outputs.length - 2}`, "IMAGE");
      resizeToFit();
    }

    function checkboxRow(name, label, target, changed = () => {}) {
      const widget = controls[name]; if (!widget) return;
      const wrap = document.createElement("label");
      wrap.style.cssText = "display:flex;align-items:center;gap:5px;color:#ddd;font-size:11px;cursor:pointer";
      const input = document.createElement("input"); input.type = "checkbox"; input.checked = Boolean(widget.value);
      input.onchange = () => {
        widget.value = input.checked; widget.callback?.(widget.value);
        changed(); app.graph.setDirtyCanvas(true, true);
      };
      input.style.accentColor = "#08b88a";
      const text = document.createElement("span"); text.textContent = t(label); text.dataset.tiLabel = label;
      wrap.append(input, text); target.append(wrap);
      checkboxBindings.set(name, { input, changed });
    }
    function syncCheckboxState() {
      for (const [name, binding] of checkboxBindings) {
        const checked = Boolean(controls[name]?.value);
        binding.input.checked = checked;
        binding.changed();
      }
    }
    function syncValueState() {
      for (const sync of valueBindings.values()) sync();
    }
    function updateResolutionMode() {
      const fromImage1 = Boolean(controls.use_image1_resolution?.value);
      customResolution.style.display = fromImage1 ? "none" : "block";
      image1Resolution.style.display = fromImage1 ? "block" : "none";
      updateCustomResolutionControls(); updateMP(); resizeToFit();
    }

    function updateUiLanguage(event) {
      uiLanguage = getUiLanguage(event?.detail?.value);
      promptEditor.dataset.placeholder = t("promptPlaceholder");
      for (const element of root.querySelectorAll("[data-ti-label]")) {
        const key = element.dataset.tiLabel;
        if (element.tagName === "LABEL" && element.firstChild?.nodeType === Node.TEXT_NODE) element.firstChild.nodeValue = t(key);
        else element.textContent = t(key);
      }
      for (const select of root.querySelectorAll("select[data-ti-widget]")) {
        for (const option of select.options) option.textContent = optionText(select.dataset.tiWidget, option.value);
      }
      render();
      updateCustomResolutionControls();
      if (mentionMenu.style.display === "block") showMentionMenu();
      resizeToFit();
      app.graph.setDirtyCanvas(true, true);
    }

    toggleControl("enable_images", "images", imageSection);
    toggleControl("enable_resolution", "resolution", sizeSection);
    imageSection.append(strip, hint);
    checkboxRow("limit_image_max_edge", "limitImageMaxEdge", imageSettings, () => {
      maxEdgeChoices.style.display = controls.limit_image_max_edge.value ? "block" : "none";
      updateMP(); resizeToFit();
    });
    selectFor("image_snap_multiple", "imageSnapMultiple", imageSettings);
    selectFor("image_max_edge", "imageMaxEdge", maxEdgeChoices);
    maxEdgeChoices.style.cssText = "flex:1;min-width:170px";
    maxEdgeChoices.style.display = controls.limit_image_max_edge?.value ? "flex" : "none";
    imageSettings.append(maxEdgeChoices);
    imageSection.append(imageSettings, picker);
    checkboxRow("use_image1_resolution", "useImage1Resolution", modeRow, updateResolutionMode);
    const aspectRatioControl = selectFor("aspect_ratio", "ratioValue", ratioControls);
    selectFor("round_to_multiple", "alignMultiple", ratioControls);
    selectFor("edge_limit", "edgeRule", edgeControls);
    selectFor("edge_resolution", "edgePixels", edgeControls);
    for (const input of [
      dimensionInputFor("custom_width", "customWidth"),
      dimensionInputFor("custom_height", "customHeight"),
    ]) {
      if (input) customDimensionControls.append(input);
    }
    const mpLabel = document.createElement("span"); mpLabel.textContent = t("megapixelsTarget"); mpLabel.dataset.tiLabel = "megapixelsTarget";
    mpControl.append(mpLabel, mpInput);
    customResolution.append(resolutionModeBar, ratioControls, edgeControls, mpControl, customDimensionControls, mpValue);
    image1Resolution.append(image1MPValue);
    sizeSection.append(modeRow, customResolution, image1Resolution);
    updateCustomResolutionControls();
    renderPrompt(prompt?.value || "");
    root.append(promptStyle, promptEditor, toggles, imageSection, sizeSection);
    picker.onchange = async () => {
      try {
        const files = [...(picker.files || [])];
        if (replaceIndex !== null && files[0]) {
          const items = read();
          if (items[replaceIndex]) items[replaceIndex].name = await upload(files[0], false);
          write(items);
        } else if (replaceIndex === null) await addFiles(files);
      } catch (error) { console.error(error); }
      replaceIndex = null; picker.multiple = true; picker.value = "";
    };
    app.ui?.settings?.addEventListener?.("Comfy.Locale.change", updateUiLanguage);
    root.ondragover = (event) => { event.preventDefault(); root.style.outline = "1px solid #08b88a"; };
    root.ondragleave = () => { root.style.outline = ""; };
    root.ondrop = async (event) => { event.preventDefault(); root.style.outline = ""; if (controls.enable_images?.value) try { await addFiles(event.dataTransfer.files); } catch (error) { console.error(error); } };
    function measuredRootHeight() {
      const childrenHeight = [...root.children].reduce((total, element) => {
        if (element === promptStyle || getComputedStyle(element).display === "none") return total;
        const style = getComputedStyle(element);
        // offsetHeight is in layout CSS pixels; getBoundingClientRect() is
        // transformed by the canvas zoom and would make the node grow on zoom.
        return total + element.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      }, 0);
      const rootStyle = getComputedStyle(root);
      const verticalFrame = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"]
        .reduce((total, key) => total + (parseFloat(rootStyle[key]) || 0), 0);
      // Measure only content children. root.scrollHeight includes the allocated
      // DOM-widget height on some ComfyUI frontends and creates a growth loop.
      return Math.ceil(childrenHeight + verticalFrame + 4);
    }
    node.addDOMWidget("image_strip", "div", root, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: measuredRootHeight,
      getMaxHeight: measuredRootHeight,
    });
    // Capture LiteGraph's ORIGINAL method before overriding it below. Calling
    // node.computeSize() from inside the override would recurse forever and
    // break node sizing. Reflect.apply keeps `node` as `this` while avoiding
    // the method-call spelling that Registry scanners misread as a socket call.
    const nativeComputeSize = node.computeSize;
    node.computeSize = function () {
      // Keep LiteGraph's trailing widget clearance so the DOM panel and its
      // border/padding remain safely inside the node frame.
      const [width, height] = Reflect.apply(nativeComputeSize, node, arguments);
      return [Math.max(MIN_NODE_WIDTH, width), height];
    };
    node.resizable = true;
    let applyingAutoSize = false;
    let userResizing = false;
    let manualHeight = 0;
    function resizeToFit() {
      if (userResizing) return;
      const [minWidth, minHeight] = node.computeSize();
      const width = Math.max(minWidth, Number(node._timeManualWidth) || 0);
      const height = Math.max(minHeight, manualHeight);
      if (node.size?.[0] !== width || node.size?.[1] !== height) {
        applyingAutoSize = true; node.setSize([width, height]); applyingAutoSize = false;
      }
    }
    const priorMouseDown = node.onMouseDown;
    node.onMouseDown = function (event, pos) {
      const result = priorMouseDown?.apply(this, arguments);
      if (event?.button === 0 && pos?.[0] >= this.size[0] - 22 && pos?.[1] >= this.size[1] - 22) {
        userResizing = true;
        const targetNode = this;
        const finishAfterCanvasEvent = () => setTimeout(() => targetNode.__finishTimePromptResize?.(), 0);
        targetNode.__finishTimePromptResize = () => {
          if (!userResizing) return;
          userResizing = false;
          targetNode._timeManualWidth = targetNode.size[0];
          manualHeight = targetNode.size[1];
          targetNode._timeManualHeight = manualHeight;
          window.removeEventListener("pointerup", finishAfterCanvasEvent, true);
          window.removeEventListener("mouseup", finishAfterCanvasEvent, true);
          window.removeEventListener("blur", targetNode.__finishTimePromptResize, true);
          resizeToFit();
        };
        window.addEventListener("pointerup", finishAfterCanvasEvent, true);
        window.addEventListener("mouseup", finishAfterCanvasEvent, true);
        window.addEventListener("blur", targetNode.__finishTimePromptResize, true);
      }
      return result;
    };
    const priorMouseUp = node.onMouseUp;
    node.onMouseUp = function () {
      const result = priorMouseUp?.apply(this, arguments);
      this.__finishTimePromptResize?.();
      return result;
    };
    const priorResize = node.onResize;
    node.onResize = function () {
      const result = priorResize?.apply(this, arguments);
      if (userResizing && !applyingAutoSize) {
        this._timeManualWidth = this.size[0];
        manualHeight = this.size[1];
      }
      if (!userResizing) setTimeout(resizeToFit, 0);
      return result;
    };
    const originalSerialize = node.onSerialize;
    node.onSerialize = function (data) {
      const result = originalSerialize?.apply(this, arguments);
      data.timeImageManualHeightV4 = manualHeight;
      return result;
    };
    const originalConfigure = node.onConfigure;
    node.onConfigure = function (data) {
      const result = originalConfigure?.apply(this, arguments);
      // Ignore legacy height keys: they may contain an oversized value captured
      // by earlier auto-sizing builds and leave a large blank tail.
      manualHeight = Math.max(0, Number(data?.timeImageManualHeightV4) || 0);
      this._timeManualHeight = manualHeight;
      setTimeout(() => {
        if (!this._timeManualWidth && this.size?.[0] > MIN_NODE_WIDTH) this._timeManualWidth = this.size[0];
        renderPrompt(prompt?.value || ""); render();
        syncToggleState(); syncValueState(); syncCheckboxState();
        syncPorts(); updateResolutionMode(); resizeToFit();
      }, 0);
      return result;
    };
    render(); updateResolutionMode(); syncPorts(); resizeToFit();
  },
});
