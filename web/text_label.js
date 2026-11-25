import { app } from "../../../scripts/app.js";

const NODE = "TimeTextLabel";
const DEFAULT_SIZE = 24;
const DEFAULT_COLOR = "#3CB371";
const PADDING_X = 5;
const PADDING_Y = 4;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 4096;
let activeResizeNode = null;
let resizeFinishHandlersInstalled = false;

function getTextWidget(node) {
  return node.widgets?.find((widget) => widget.name === "text");
}

function getLabelText(node) {
  return String(getTextWidget(node)?.value ?? "双击编辑文字").replace(/\\n/g, "\n");
}

function markDirty(node) {
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function getBaseLabelSize(node) {
  const widget = getTextWidget(node);
  if (!widget) return [80, 42];
  const size = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Number(node.properties?.fontSize) || DEFAULT_SIZE));
  const paddingX = Math.max(PADDING_X, size * 0.12);
  const paddingY = Math.max(PADDING_Y, size * 0.08);
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = `${size}px Arial, sans-serif`;
  const lines = getLabelText(node).split("\n");
  const width = Math.max(80, ...lines.map((line) => measure.measureText(line || " ").width)) + paddingX * 2;
  const height = lines.length * size * 1.06 + paddingY * 2;
  return [Math.ceil(width), Math.ceil(height)];
}

function resizeLabel(node) {
  const [width, height] = getBaseLabelSize(node);
  node.__timeLabelResizing = true;
  node.setSize([width, height]);
  node.__timeLabelResizing = false;
}

function finishLabelResize(node = activeResizeNode) {
  if (!node) return;
  if (activeResizeNode === node) activeResizeNode = null;
  node.__timeLabelResizeStart = null;
  resizeLabel(node);
  markDirty(node);
}

function hideTextWidget(widget) {
  if (!widget) return;
  widget.type = "hidden";
  widget.hidden = true;
  widget.options ||= {};
  widget.options.hidden = true;
  widget.computeSize = () => [0, 0];
  widget.draw = () => {};
  const element = widget.inputEl || widget.element;
  if (element) element.style.display = "none";
}

function drawTransparentLabel(node, ctx) {
  const lines = getLabelText(node).split("\n");
  const fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Number(node.properties?.fontSize) || DEFAULT_SIZE));
  const paddingX = Math.max(PADDING_X, fontSize * 0.12);
  const paddingY = Math.max(PADDING_Y, fontSize * 0.08);
  const radius = Math.min(14, node.size[1] / 2);

  ctx.save();
  if (node.is_selected) {
    ctx.beginPath();
    ctx.roundRect(0, 0, node.size[0], node.size[1], radius);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(245,245,245,.88)";
    ctx.stroke();
  }
  ctx.font = `${fontSize}px Arial, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = node.properties?.fontColor || DEFAULT_COLOR;
  lines.forEach((line, index) => ctx.fillText(line || " ", paddingX, paddingY + fontSize / 2 + index * fontSize));

  if (node.is_selected && node.resizable) {
    ctx.beginPath();
    ctx.moveTo(node.size[0] - 13, node.size[1] - 3);
    ctx.lineTo(node.size[0] - 3, node.size[1] - 13);
    ctx.moveTo(node.size[0] - 8, node.size[1] - 3);
    ctx.lineTo(node.size[0] - 3, node.size[1] - 8);
    ctx.strokeStyle = "rgba(245,245,245,.85)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

function editLabel(node, properties = false) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:100000;display:grid;place-items:center;background:rgba(0,0,0,.55);font:14px sans-serif";
  const panel = document.createElement("div");
  panel.style.cssText = "box-sizing:border-box;width:min(440px,calc(100vw - 32px));padding:18px;border:1px solid #555;border-radius:10px;background:#292929;color:#eee;box-shadow:0 12px 42px #0008";
  const heading = document.createElement("div");
  heading.textContent = properties ? "文字属性" : "编辑文字";
  heading.style.cssText = "margin-bottom:12px;font-size:17px;font-weight:600";
  panel.append(heading);

  const textArea = document.createElement("textarea");
  textArea.value = getLabelText(node);
  textArea.rows = 3;
  textArea.placeholder = "输入标签文字";
  textArea.style.cssText = "box-sizing:border-box;width:100%;resize:vertical;padding:9px;border:1px solid #555;border-radius:6px;background:#1d1d1d;color:#fff;font:14px sans-serif";
  panel.append(textArea);

  let sizeInput;
  let colorInput;
  if (properties) {
    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;align-items:center;gap:16px;margin-top:14px";
    const sizeLabel = document.createElement("label");
    sizeLabel.textContent = "字号";
    sizeLabel.style.cssText = "display:flex;align-items:center;gap:8px;flex:1";
    sizeInput = document.createElement("input");
    sizeInput.type = "range";
    sizeInput.min = "12";
    sizeInput.max = String(MAX_FONT_SIZE);
    sizeInput.min = String(MIN_FONT_SIZE);
    sizeInput.value = String(Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Number(node.properties?.fontSize) || DEFAULT_SIZE)));
    const sizeValue = document.createElement("span");
    sizeValue.textContent = sizeInput.value;
    sizeInput.addEventListener("input", () => { sizeValue.textContent = sizeInput.value; });
    sizeLabel.append(sizeInput, sizeValue);
    const colorLabel = document.createElement("label");
    colorLabel.textContent = "文字颜色";
    colorLabel.style.cssText = "display:flex;align-items:center;gap:7px";
    colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = /^#[0-9a-f]{6}$/i.test(node.properties?.fontColor || "") ? node.properties.fontColor : DEFAULT_COLOR;
    colorLabel.append(colorInput);
    controls.append(sizeLabel, colorLabel);
    panel.append(controls);
  }

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:18px";
  const close = () => overlay.remove();
  const createButton = (label, primary, callback) => {
    const button = document.createElement("button");
    button.textContent = label;
    button.style.cssText = `padding:7px 14px;border:1px solid ${primary ? "#1689e8" : "#555"};border-radius:6px;color:#fff;background:${primary ? "#1689e8" : "#3a3a3a"};cursor:pointer`;
    button.addEventListener("click", callback);
    return button;
  };
  actions.append(createButton("取消", false, close), createButton("保存", true, () => {
    const widget = getTextWidget(node);
    if (widget) widget.value = textArea.value || " ";
    if (properties) {
      node.properties.fontSize = Number(sizeInput.value);
      node.properties.fontColor = colorInput.value;
    }
    resizeLabel(node);
    markDirty(node);
    close();
  }));
  panel.append(actions);
  overlay.append(panel);
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  overlay.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  document.body.append(overlay);
  textArea.focus();
  textArea.setSelectionRange(textArea.value.length, textArea.value.length);
}

app.registerExtension({
  name: "TimeImage.TextLabel",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;
    if (!resizeFinishHandlersInstalled) {
      const finishAfterCanvasEvent = () => setTimeout(() => finishLabelResize(), 0);
      window.addEventListener("pointerup", finishAfterCanvasEvent, true);
      window.addEventListener("mouseup", finishAfterCanvasEvent, true);
      window.addEventListener("blur", () => finishLabelResize(), true);
      resizeFinishHandlersInstalled = true;
    }
    const originalDrawNode = LGraphCanvas.prototype.drawNode;
    LGraphCanvas.prototype.drawNode = function (node, ctx) {
      if (node.comfyClass === NODE || node.type === NODE) {
        drawTransparentLabel(node, ctx);
        return true;
      }
      return originalDrawNode.apply(this, arguments);
    };
    nodeType.title_mode = LiteGraph.NO_TITLE;
    nodeType.collapsable = false;
    const originalNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalNodeCreated?.apply(this, arguments);
      this.properties ||= {};
      this.properties.fontSize ||= DEFAULT_SIZE;
      this.properties.fontColor ||= DEFAULT_COLOR;
      delete this.properties.labelScale;
      this.color = "rgba(0,0,0,0)";
      this.bgcolor = "rgba(0,0,0,0)";
      this.shape = LiteGraph.ROUND_SHAPE;
      this.resizable = true;
      const widget = getTextWidget(this);
      hideTextWidget(widget);
      resizeLabel(this);
      const originalDblClick = this.onDblClick;
      this.onDblClick = function () {
        editLabel(this, false);
        return originalDblClick?.apply(this, arguments);
      };
      resizeLabel(this);
    };
    const originalResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      const result = originalResize?.apply(this, arguments);
      const resizeStart = this.__timeLabelResizeStart;
      if (!this.__timeLabelResizing && resizeStart && size?.[0] > 0) {
        this.properties ||= {};
        const fontScale = size[0] / Math.max(1, resizeStart.width);
        this.properties.fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(resizeStart.fontSize * fontScale)));
        markDirty(this);
      }
      return result;
    };
    const originalMouseDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (event, pos) {
      const result = originalMouseDown?.apply(this, arguments);
      if (event?.button === 0 && pos?.[0] >= this.size[0] - 20 && pos?.[1] >= this.size[1] - 20) {
        activeResizeNode = this;
        this.__timeLabelResizeStart = {
          width: this.size[0],
          fontSize: Number(this.properties?.fontSize) || DEFAULT_SIZE,
        };
      }
      return result;
    };
    const originalMouseUp = nodeType.prototype.onMouseUp;
    nodeType.prototype.onMouseUp = function () {
      const result = originalMouseUp?.apply(this, arguments);
      if (activeResizeNode === this) finishLabelResize(this);
      return result;
    };
    const originalPropertyChanged = nodeType.prototype.onPropertyChanged;
    nodeType.prototype.onPropertyChanged = function (name, value) {
      const result = originalPropertyChanged?.apply(this, arguments);
      if (name === "fontSize") {
        this.properties.fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Number(value) || DEFAULT_SIZE));
        resizeLabel(this);
        markDirty(this);
      } else if (name === "fontColor") {
        markDirty(this);
      }
      return result;
    };
    nodeType["@fontSize"] = { type: "number", min: MIN_FONT_SIZE, max: MAX_FONT_SIZE };
    nodeType["@fontColor"] = { type: "string" };
    const originalMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_canvas, options) {
      originalMenuOptions?.apply(this, arguments);
      options.push({ content: "文字属性…", callback: () => editLabel(this, true) });
    };
  },
  async nodeCreated(node) {
    if (node.comfyClass !== NODE) return;
    hideTextWidget(getTextWidget(node));
    resizeLabel(node);
  },
});
