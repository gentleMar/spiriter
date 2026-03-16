const fileInput = document.getElementById("fileInput");
const tolerance = document.getElementById("tolerance");
const minArea = document.getElementById("minArea");
const tolValue = document.getElementById("tolValue");
const areaValue = document.getElementById("areaValue");
const processBtn = document.getElementById("processBtn");
const exportBtn = document.getElementById("exportBtn");
const cloneBtn = document.getElementById("cloneBtn");
const deleteBtn = document.getElementById("deleteBtn");
const magicEraseBtn = document.getElementById("magicEraseBtn");
const playBtn = document.getElementById("playBtn");
const stopBtn = document.getElementById("stopBtn");
const canvasColorInput = document.getElementById("canvasColor");
const resetCanvasColorBtn = document.getElementById("resetCanvasColorBtn");
const fpsInput = document.getElementById("fpsInput");
const previewInfo = document.getElementById("previewInfo");
const spriteCanvas = document.getElementById("spriteCanvas");
const statusEl = document.getElementById("status");
const cellWInput = document.getElementById("cellW");
const cellHInput = document.getElementById("cellH");
const gridColsInput = document.getElementById("gridCols");
const gridRowsInput = document.getElementById("gridRows");
const exportSizeEl = document.getElementById("exportSize");
const stageWrap = document.getElementById("stageWrap");
const downloadLink = document.getElementById("downloadLink");

const GRID_MARGIN = 24;
const DEFAULT_CANVAS_COLOR = "#f5f3ec";
const previewCtx = spriteCanvas.getContext("2d");

let sessionId = null;
let stage = null;
let gridLayer = null;
let objectLayer = null;
let transformer = null;
let gridGroup = null;
let spriteNodes = [];
let currentLayoutCount = 0;
let previewSheetImage = null;
let previewFrameIndex = 0;
let previewAnimationId = null;
let previewLastTimestamp = 0;
let previewPlaying = false;
let workspaceScale = 1;
let isPanningWorkspace = false;
let panStartX = 0;
let panStartY = 0;
let panScrollLeft = 0;
let panScrollTop = 0;
let isMagicEraseMode = false;

function createInstanceId(sourceId) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return `${sourceId}__${globalThis.crypto.randomUUID()}`;
  }

  return `${sourceId}__${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

tolerance.addEventListener("input", () => {
  tolValue.textContent = tolerance.value;
});

minArea.addEventListener("input", () => {
  areaValue.textContent = minArea.value;
});

function setStatus(text) {
  statusEl.textContent = text;
}

function setCanvasBackgroundColor(color) {
  document.documentElement.style.setProperty("--canvas-bg", color);
}

function parsePositiveInt(input, fallback) {
  const value = parseInt(input.value, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getGridConfig() {
  const cellWidth = parsePositiveInt(cellWInput, 128);
  const cellHeight = parsePositiveInt(cellHInput, 128);
  const cols = parsePositiveInt(gridColsInput, 8);
  const rows = parsePositiveInt(gridRowsInput, 8);

  return {
    cellWidth,
    cellHeight,
    cols,
    rows,
    width: cellWidth * cols,
    height: cellHeight * rows
  };
}

function getEffectiveRows(itemCount = currentLayoutCount) {
  const config = getGridConfig();
  const requiredRows = Math.ceil(Math.max(1, itemCount) / config.cols);
  return Math.max(config.rows, requiredRows);
}

function getGridBounds(itemCount = currentLayoutCount) {
  const config = getGridConfig();
  const effectiveRows = getEffectiveRows(itemCount);
  return {
    x: GRID_MARGIN,
    y: GRID_MARGIN,
    width: config.width,
    height: config.cellHeight * effectiveRows,
    effectiveRows,
    ...config
  };
}

function getFrameCount() {
  return Math.max(0, currentLayoutCount);
}

function updateExportSummary() {
  const bounds = getGridBounds();
  exportSizeEl.textContent = `导出区域：${bounds.width} x ${bounds.height} 像素（${bounds.cols} 列 x ${bounds.effectiveRows} 行）`;
}

function updatePreviewCanvasSize() {
  const { cellWidth, cellHeight } = getGridConfig();
  spriteCanvas.width = cellWidth;
  spriteCanvas.height = cellHeight;
  previewCtx.imageSmoothingEnabled = false;
}

function updatePreviewInfo(text) {
  previewInfo.textContent = text;
}

function clearPreviewCanvas() {
  previewCtx.clearRect(0, 0, spriteCanvas.width, spriteCanvas.height);
}

function getSelectedNode() {
  return transformer ? transformer.nodes()[0] ?? null : null;
}

function updateSelectionActions() {
  const hasSelection = Boolean(getSelectedNode());
  cloneBtn.disabled = !hasSelection;
  deleteBtn.disabled = !hasSelection;
}

function updateToolState() {
  const hasSprites = Boolean(sessionId) && spriteNodes.length > 0;
  magicEraseBtn.disabled = !hasSprites;
  magicEraseBtn.classList.toggle("tool-active", isMagicEraseMode && hasSprites);
  if (!isPanningWorkspace) {
    stageWrap.style.cursor = isMagicEraseMode && hasSprites ? "crosshair" : "grab";
  }
}

function stopPreviewPlayback(keepFrame = true) {
  if (previewAnimationId) {
    cancelAnimationFrame(previewAnimationId);
    previewAnimationId = null;
  }
  previewPlaying = false;
  previewLastTimestamp = 0;
  playBtn.disabled = !sessionId || spriteNodes.length === 0;
  stopBtn.disabled = true;

  if (!keepFrame) {
    clearPreviewCanvas();
  }
}

function resetPreviewState() {
  stopPreviewPlayback(false);
  previewSheetImage = null;
  previewFrameIndex = 0;
  updatePreviewCanvasSize();
  updatePreviewInfo("预览将在这里按导出后的精灵图表逐帧播放。");
}

function drawGrid() {
  if (!gridLayer) {
    return;
  }

  if (gridGroup) {
    gridGroup.destroy();
  }

  const bounds = getGridBounds();
  gridGroup = new Konva.Group({ listening: false });

  const bg = new Konva.Rect({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fill: "rgba(18, 115, 105, 0.04)",
    stroke: "rgba(18, 115, 105, 0.9)",
    strokeWidth: 2,
    dash: [8, 6]
  });
  gridGroup.add(bg);

  for (let col = 1; col < bounds.cols; col += 1) {
    gridGroup.add(new Konva.Line({
      points: [
        bounds.x + col * bounds.cellWidth,
        bounds.y,
        bounds.x + col * bounds.cellWidth,
        bounds.y + bounds.height
      ],
      stroke: "rgba(31, 42, 47, 0.18)",
      strokeWidth: 1
    }));
  }

  for (let row = 1; row < bounds.effectiveRows; row += 1) {
    gridGroup.add(new Konva.Line({
      points: [
        bounds.x,
        bounds.y + row * bounds.cellHeight,
        bounds.x + bounds.width,
        bounds.y + row * bounds.cellHeight
      ],
      stroke: "rgba(31, 42, 47, 0.18)",
      strokeWidth: 1
    }));
  }

  gridGroup.add(new Konva.Text({
    x: bounds.x,
    y: Math.max(2, bounds.y - 20),
    text: `${bounds.cols} 列 x ${bounds.effectiveRows} 行 | ${bounds.cellWidth} x ${bounds.cellHeight}px`,
    fontSize: 14,
    fill: "#127369"
  }));

  gridLayer.add(gridGroup);
  gridLayer.batchDraw();
}

function beginWorkspacePan(event) {
  isPanningWorkspace = true;
  panStartX = event.clientX;
  panStartY = event.clientY;
  panScrollLeft = stageWrap.scrollLeft;
  panScrollTop = stageWrap.scrollTop;
  stageWrap.style.cursor = "grabbing";
}

function updateWorkspacePan(event) {
  if (!isPanningWorkspace) {
    return;
  }

  const deltaX = event.clientX - panStartX;
  const deltaY = event.clientY - panStartY;
  stageWrap.scrollLeft = panScrollLeft - deltaX;
  stageWrap.scrollTop = panScrollTop - deltaY;
}

function endWorkspacePan() {
  if (!isPanningWorkspace) {
    return;
  }

  isPanningWorkspace = false;
  updateToolState();
}

function updateStageLayout() {
  if (!stage) {
    return;
  }

  const bounds = getGridBounds();
  const contentWidth = bounds.x + bounds.width + GRID_MARGIN;
  const contentHeight = bounds.y + bounds.height + GRID_MARGIN;
  const width = Math.max(stageWrap.clientWidth, Math.ceil(contentWidth * workspaceScale));
  const height = Math.max(stageWrap.clientHeight, Math.ceil(contentHeight * workspaceScale));
  stage.width(width);
  stage.height(height);
  stage.scale({ x: workspaceScale, y: workspaceScale });
  drawGrid();
  stage.batchDraw();
}

function initStage() {
  if (stage) {
    updateStageLayout();
    return;
  }

  stage = new Konva.Stage({
    container: "stageWrap",
    width: stageWrap.clientWidth,
    height: stageWrap.clientHeight
  });
  stageWrap.style.cursor = "grab";

  gridLayer = new Konva.Layer({ listening: false });
  objectLayer = new Konva.Layer();
  stage.add(gridLayer);
  stage.add(objectLayer);

  transformer = new Konva.Transformer({
    rotateEnabled: false,
    keepRatio: true,
    enabledAnchors: [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right"
    ]
  });

  objectLayer.add(transformer);
  stage.on("click", (evt) => {
    if (isPanningWorkspace) {
      return;
    }

    if (evt.target === stage) {
      transformer.nodes([]);
      updateSelectionActions();
      objectLayer.batchDraw();
    }
  });

  stage.on("mousedown", (evt) => {
    const isMiddleButton = evt.evt.button === 1;
    const isBlankLeftButton = evt.evt.button === 0 && evt.target === stage;

    if (!isMiddleButton && !isBlankLeftButton) {
      return;
    }

    evt.evt.preventDefault();
    beginWorkspacePan(evt.evt);
  });

  stage.on("mousemove", (evt) => {
    updateWorkspacePan(evt.evt);
  });

  stage.on("mouseup", () => {
    endWorkspacePan();
  });

  stage.on("mouseleave", () => {
    endWorkspacePan();
  });

  stage.on("wheel", (evt) => {
    if (evt.evt.ctrlKey) {
      evt.evt.preventDefault();

      const rect = stageWrap.getBoundingClientRect();
      const pointerX = evt.evt.clientX - rect.left + stageWrap.scrollLeft;
      const pointerY = evt.evt.clientY - rect.top + stageWrap.scrollTop;
      const sceneX = pointerX / workspaceScale;
      const sceneY = pointerY / workspaceScale;
      const zoomFactor = evt.evt.deltaY > 0 ? 1 / 1.08 : 1.08;
      const nextScale = clamp(workspaceScale * zoomFactor, 0.25, 4);

      if (nextScale === workspaceScale) {
        return;
      }

      workspaceScale = nextScale;
      updateStageLayout();

      stageWrap.scrollLeft = Math.max(0, sceneX * workspaceScale - (evt.evt.clientX - rect.left));
      stageWrap.scrollTop = Math.max(0, sceneY * workspaceScale - (evt.evt.clientY - rect.top));
      return;
    }

    const selected = transformer.nodes()[0];
    if (!selected) {
      return;
    }

    evt.evt.preventDefault();

    const factor = evt.evt.deltaY > 0 ? 1 / 1.05 : 1.05;
    const currentScale = selected.scaleX();
    const nextScale = Math.min(20, Math.max(0.1, currentScale * factor));
    const centerX = selected.x() + (selected.width() * currentScale) / 2;
    const centerY = selected.y() + (selected.height() * currentScale) / 2;

    selected.scale({ x: nextScale, y: nextScale });
    selected.position({
      x: centerX - (selected.width() * nextScale) / 2,
      y: centerY - (selected.height() * nextScale) / 2
    });

    objectLayer.batchDraw();
  });

  updateStageLayout();
}

function clearSprites() {
  spriteNodes.forEach((node) => node.destroy());
  spriteNodes = [];
  currentLayoutCount = 0;
  if (transformer) {
    transformer.nodes([]);
  }
  isMagicEraseMode = false;
  updateSelectionActions();
  updateToolState();
  if (objectLayer) {
    objectLayer.batchDraw();
  }
}

function syncLayoutCount() {
  currentLayoutCount = spriteNodes.length;
  updateExportSummary();
  updateStageLayout();
}

function markSceneChanged() {
  downloadLink.classList.remove("active");
  resetPreviewState();
  playBtn.disabled = !sessionId || spriteNodes.length === 0;
  updateToolState();
}

function colorDistanceWithinTolerance(data, idx, target, toleranceSquared) {
  const dr = data[idx] - target[0];
  const dg = data[idx + 1] - target[1];
  const db = data[idx + 2] - target[2];
  return dr * dr + dg * dg + db * db <= toleranceSquared;
}

async function applyMagicEraseToNode(node) {
  const image = node.image();
  if (!image) {
    return;
  }

  const localPoint = node.getRelativePointerPosition();
  if (!localPoint) {
    return;
  }

  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  if (!imageWidth || !imageHeight) {
    return;
  }

  const pixelX = Math.floor((localPoint.x / node.width()) * imageWidth);
  const pixelY = Math.floor((localPoint.y / node.height()) * imageHeight);
  if (pixelX < 0 || pixelY < 0 || pixelX >= imageWidth || pixelY >= imageHeight) {
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = imageWidth;
  canvas.height = imageHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);

  const imageData = context.getImageData(0, 0, imageWidth, imageHeight);
  const { data } = imageData;
  const seedIndex = (pixelY * imageWidth + pixelX) * 4;
  if (data[seedIndex + 3] === 0) {
    setStatus("该位置已经是透明像素。");
    return;
  }

  const toleranceValue = clamp(parsePositiveInt(tolerance, 48), 1, 160);
  const toleranceSquared = toleranceValue * toleranceValue;
  const target = [data[seedIndex], data[seedIndex + 1], data[seedIndex + 2]];
  const visited = new Uint8Array(imageWidth * imageHeight);
  const stack = [[pixelX, pixelY]];
  let erasedPixels = 0;

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const flatIndex = y * imageWidth + x;
    if (visited[flatIndex]) {
      continue;
    }

    visited[flatIndex] = 1;
    const idx = flatIndex * 4;
    if (data[idx + 3] === 0 || !colorDistanceWithinTolerance(data, idx, target, toleranceSquared)) {
      continue;
    }

    data[idx + 3] = 0;
    erasedPixels += 1;

    if (x > 0) stack.push([x - 1, y]);
    if (x < imageWidth - 1) stack.push([x + 1, y]);
    if (y > 0) stack.push([x, y - 1]);
    if (y < imageHeight - 1) stack.push([x, y + 1]);
  }

  if (erasedPixels === 0) {
    setStatus("没有找到可连通擦除的像素。");
    return;
  }

  context.putImageData(imageData, 0, 0);
  const nextImageData = canvas.toDataURL("image/png");
  const nextImage = await loadImage(nextImageData);

  node.image(nextImage);
  node.setAttr("customImageData", nextImageData);
  transformer.nodes([node]);
  markSceneChanged();
  updateSelectionActions();
  objectLayer.batchDraw();
  setStatus(`已将连通区域擦除为透明，共处理 ${erasedPixels} 个像素。`);
}

function createSpriteNode({ image, x, y, width, height, sourceId, instanceId, scaleX = 1, scaleY = 1 }) {
  const node = new Konva.Image({
    image,
    x,
    y,
    width,
    height,
    scaleX,
    scaleY,
    draggable: true,
    id: instanceId,
    stroke: "rgba(18, 115, 105, 0.35)",
    strokeWidth: 1
  });

  node.setAttr("sourceId", sourceId);
  node.setAttr("customImageData", image.src?.startsWith("data:image") ? image.src : null);

  node.on("click", async (evt) => {
    if (isMagicEraseMode) {
      evt.cancelBubble = true;
      await applyMagicEraseToNode(node);
      return;
    }

    transformer.nodes([node]);
    updateSelectionActions();
    objectLayer.batchDraw();
  });

  node.on("dragstart", () => node.moveToTop());
  node.on("dragend", () => {
    markSceneChanged();
    objectLayer.batchDraw();
  });
  node.on("transformend", () => {
    markSceneChanged();
    objectLayer.batchDraw();
  });

  objectLayer.add(node);
  spriteNodes.push(node);
  return node;
}

function cloneSelectedNode() {
  const selected = getSelectedNode();
  if (!selected) {
    return;
  }

  const sourceId = selected.getAttr("sourceId") || selected.id();
  const clone = createSpriteNode({
    image: selected.image(),
    x: selected.x() + 12,
    y: selected.y() + 12,
    width: selected.width(),
    height: selected.height(),
    scaleX: selected.scaleX(),
    scaleY: selected.scaleY(),
    sourceId,
    instanceId: createInstanceId(sourceId)
  });
  clone.setAttr("customImageData", selected.getAttr("customImageData") || null);

  syncLayoutCount();
  markSceneChanged();
  transformer.nodes([clone]);
  updateSelectionActions();
  objectLayer.batchDraw();
  setStatus("已克隆选中对象。");
}

function deleteSelectedNode() {
  const selected = getSelectedNode();
  if (!selected) {
    return;
  }

  spriteNodes = spriteNodes.filter((node) => node !== selected);
  selected.destroy();
  transformer.nodes([]);
  syncLayoutCount();
  markSceneChanged();
  updateSelectionActions();
  objectLayer.batchDraw();
  setStatus("已删除选中对象。");
}

function getAutoLayoutFrame(index) {
  const bounds = getGridBounds();
  const col = index % bounds.cols;
  const row = Math.floor(index / bounds.cols);

  return {
    x: bounds.x + col * bounds.cellWidth,
    y: bounds.y + row * bounds.cellHeight,
    width: bounds.cellWidth,
    height: bounds.cellHeight
  };
}

function getFittedSize(sourceWidth, sourceHeight, frameWidth, frameHeight) {
  const innerPadding = 6;
  const availableWidth = Math.max(1, frameWidth - innerPadding * 2);
  const availableHeight = Math.max(1, frameHeight - innerPadding * 2);
  const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight);

  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
}

function getExportPayload() {
  if (!sessionId) {
    throw new Error("没有可导出的会话，请先处理图片。");
  }

  const bounds = getGridBounds();
  if (bounds.width < 1 || bounds.height < 1) {
    throw new Error("辅助框尺寸无效，请检查单格宽高和行列数。");
  }

  const items = spriteNodes.map((node) => ({
    id: node.id(),
    source_id: node.getAttr("sourceId") || node.id(),
    image_data: node.getAttr("customImageData") || null,
    x: node.x(),
    y: node.y(),
    width: Math.max(1, Math.round(node.width() * node.scaleX())),
    height: Math.max(1, Math.round(node.height() * node.scaleY()))
  }));

  return {
    session_id: sessionId,
    canvas_width: bounds.width,
    canvas_height: bounds.height,
    origin_x: bounds.x,
    origin_y: bounds.y,
    items
  };
}

async function requestExportedSheet() {
  const payload = getExportPayload();
  const resp = await fetch("/api/export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.detail || "导出失败");
  }

  return data.image_data;
}

function renderPreviewFrame(frameIndex) {
  if (!previewSheetImage || getFrameCount() === 0) {
    clearPreviewCanvas();
    return;
  }

  updatePreviewCanvasSize();
  clearPreviewCanvas();

  const { cellWidth, cellHeight, cols } = getGridBounds();
  const column = frameIndex % cols;
  const row = Math.floor(frameIndex / cols);
  const sx = column * cellWidth;
  const sy = row * cellHeight;

  previewCtx.drawImage(
    previewSheetImage,
    sx,
    sy,
    cellWidth,
    cellHeight,
    0,
    0,
    cellWidth,
    cellHeight
  );

  const fps = clamp(parsePositiveInt(fpsInput, 12), 1, 60);
  updatePreviewInfo(`第 ${frameIndex + 1} 帧 / 共 ${getFrameCount()} 帧，当前 ${fps} FPS。`);
}

function previewTick(timestamp) {
  if (!previewPlaying) {
    return;
  }

  const fps = clamp(parsePositiveInt(fpsInput, 12), 1, 60);
  const frameDuration = 1000 / fps;

  if (!previewLastTimestamp || timestamp - previewLastTimestamp >= frameDuration) {
    renderPreviewFrame(previewFrameIndex);
    previewFrameIndex = (previewFrameIndex + 1) % Math.max(1, getFrameCount());
    previewLastTimestamp = timestamp;
  }

  previewAnimationId = requestAnimationFrame(previewTick);
}

async function startPreviewPlayback() {
  if (!sessionId || spriteNodes.length === 0) {
    setStatus("没有可预览的内容，请先处理图片。");
    return;
  }

  playBtn.disabled = true;
  stopBtn.disabled = true;
  updatePreviewInfo("正在生成当前状态的预览精灵表...");

  try {
    const imageData = await requestExportedSheet();
    previewSheetImage = await loadImage(imageData);
    previewFrameIndex = 0;
    previewLastTimestamp = 0;
    previewPlaying = true;
    stopBtn.disabled = false;
    previewAnimationId = requestAnimationFrame(previewTick);
    setStatus("预览已开始播放，内容来自当前排版的导出精灵图表。");
  } catch (err) {
    playBtn.disabled = false;
    stopBtn.disabled = true;
    updatePreviewInfo(`预览失败：${err.message}`);
    setStatus(`预览失败: ${err.message}`);
  }
}

async function processImage() {
  const file = fileInput.files[0];
  if (!file) {
    setStatus("请先选择一张图片。");
    return;
  }

  sessionId = null;
  workspaceScale = 1;
  stageWrap.scrollLeft = 0;
  stageWrap.scrollTop = 0;
  setStatus("正在处理图像，请稍候...");
  processBtn.disabled = true;
  exportBtn.disabled = true;
  playBtn.disabled = true;
  stopBtn.disabled = true;
  downloadLink.classList.remove("active");
  resetPreviewState();
  playBtn.disabled = true;
  stopBtn.disabled = true;

  try {
    const form = new FormData();
    form.append("file", file);

    const qs = new URLSearchParams({
      tolerance: tolerance.value,
      min_area: minArea.value
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    const resp = await fetch(`/api/process?${qs.toString()}`, {
      method: "POST",
      body: form,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.detail || "处理失败");
    }

    sessionId = data.session_id;
    clearSprites();
    currentLayoutCount = data.objects.length;
    updateExportSummary();
    updateStageLayout();

    const nodePromises = data.objects.map(async (obj, index) => {
      const frame = getAutoLayoutFrame(index);
      const fitted = getFittedSize(obj.width, obj.height, frame.width, frame.height);
      const nodeX = frame.x + Math.round((frame.width - fitted.width) / 2);
      const nodeY = frame.y + Math.round((frame.height - fitted.height) / 2);
      const imageObj = await loadImage(obj.image_data);

      createSpriteNode({
        image: imageObj,
        x: nodeX,
        y: nodeY,
        width: fitted.width,
        height: fitted.height,
        sourceId: obj.id,
        instanceId: createInstanceId(obj.id)
      });
    });

    await Promise.all(nodePromises);
    objectLayer.batchDraw();
    updateSelectionActions();

    exportBtn.disabled = false;
    playBtn.disabled = false;
    updateToolState();
    const bounds = getGridBounds(data.object_count);
    setStatus(`处理完成，识别到 ${data.object_count} 个独立对象，已按单格自动排入 ${bounds.cols} 列 x ${bounds.effectiveRows} 行的辅助框中。`);
  } catch (err) {
    if (err.name === "AbortError") {
      setStatus("处理超时（45秒），请提高最小对象面积或使用更小尺寸图片。");
    } else {
      setStatus(`处理失败: ${err.message}`);
    }
  } finally {
    processBtn.disabled = false;
  }
}

async function exportImage() {
  try {
    setStatus("正在导出...");
    exportBtn.disabled = true;

    const imageData = await requestExportedSheet();
    downloadLink.href = imageData;
    downloadLink.classList.add("active");
    setStatus("导出完成，点击“下载导出结果”。");
  } catch (err) {
    setStatus(`导出失败: ${err.message}`);
  } finally {
    exportBtn.disabled = false;
  }
}

processBtn.addEventListener("click", processImage);
exportBtn.addEventListener("click", exportImage);
cloneBtn.addEventListener("click", cloneSelectedNode);
deleteBtn.addEventListener("click", deleteSelectedNode);
magicEraseBtn.addEventListener("click", () => {
  if (magicEraseBtn.disabled) {
    return;
  }

  isMagicEraseMode = !isMagicEraseMode;
  updateToolState();
  setStatus(isMagicEraseMode ? "连通透明擦除已开启，点击对象中的目标区域即可擦除。" : "连通透明擦除已关闭。");
});
playBtn.addEventListener("click", startPreviewPlayback);
stopBtn.addEventListener("click", () => {
  stopPreviewPlayback();
  if (previewSheetImage) {
    const frameIndex = (previewFrameIndex + Math.max(0, getFrameCount() - 1)) % Math.max(1, getFrameCount());
    renderPreviewFrame(frameIndex);
  }
  setStatus("预览已停止。");
});

[
  cellWInput,
  cellHInput,
  gridColsInput,
  gridRowsInput
].forEach((input) => {
  input.addEventListener("input", () => {
    updateExportSummary();
    updatePreviewCanvasSize();
    resetPreviewState();
    initStage();
  });
});

fpsInput.addEventListener("input", () => {
  const fps = clamp(parsePositiveInt(fpsInput, 12), 1, 60);
  fpsInput.value = String(fps);
  if (previewSheetImage && !previewPlaying && getFrameCount() > 0) {
    renderPreviewFrame(Math.min(previewFrameIndex, getFrameCount() - 1));
  }
});

canvasColorInput.addEventListener("input", () => {
  setCanvasBackgroundColor(canvasColorInput.value);
});

resetCanvasColorBtn.addEventListener("click", () => {
  canvasColorInput.value = DEFAULT_CANVAS_COLOR;
  setCanvasBackgroundColor(DEFAULT_CANVAS_COLOR);
});

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) {
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    const selected = getSelectedNode();
    if (!selected) {
      return;
    }

    event.preventDefault();
    deleteSelectedNode();
  }
});

window.addEventListener("resize", initStage);
window.addEventListener("mouseup", endWorkspacePan);

updateExportSummary();
updatePreviewCanvasSize();
resetPreviewState();
setCanvasBackgroundColor(canvasColorInput.value || DEFAULT_CANVAS_COLOR);
initStage();
updateSelectionActions();
updateToolState();
