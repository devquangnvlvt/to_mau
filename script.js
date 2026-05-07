const appState = {
  view: "gallery",
  levels: [],
  currentLevel: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  selectedColorId: 1,
  paintedPixels: new Set(),
  canvas: null,
  ctx: null,
  miniMapCtx: null,
  progressCanvas: null,
  progressCtx: null,
  paintedArray: null, // Uint8Array(width * height) for fast lookup
  container: null,

  // Audio Context
  audioCtx: null,
  saveTimeout: null,

  // Interaction state
  activePointers: new Map(),
  lastPinchDistance: null,
  isPainting: false,
  isPanning: false,
  selectedTool: null, // 'wand', 'bomb', 'hint'
  lastScreenX: 0,
  lastScreenY: 0,
  hintPixel: null, // {x, y}
  colorTotals: {},
  colorPainted: {},
};

// Initialize App
async function init() {
  appState.canvas = document.getElementById("game-canvas");
  appState.ctx = appState.canvas.getContext("2d", { alpha: false });
  appState.miniMapCanvas = document.getElementById("mini-map-canvas");
  appState.miniMapCtx = appState.miniMapCanvas.getContext("2d", {
    alpha: true,
  });
  appState.container = document.getElementById("game-canvas-container");

  await loadManifest();
  renderGallery();
  setupEventListeners();
  setupImageUpload();
  setupResizeObserver();

  // Add page visibility listener for forced save
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      saveProgressImmediate();
    }
  });

  animate();
}

// --- Audio Manager ---
const SoundManager = {
  init() {
    if (!appState.audioCtx) {
      appState.audioCtx = new (
        window.AudioContext || window.webkitAudioContext
      )();
    }
  },
  playPop() {
    if (!appState.audioCtx) this.init();
    if (appState.audioCtx.state === "suspended") appState.audioCtx.resume();

    const osc = appState.audioCtx.createOscillator();
    const gain = appState.audioCtx.createGain();

    osc.connect(gain);
    gain.connect(appState.audioCtx.destination);

    osc.type = "sine";
    // Random pitch for variety
    const freq = 600 + Math.random() * 200;
    osc.frequency.setValueAtTime(freq, appState.audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      100,
      appState.audioCtx.currentTime + 0.1,
    );

    gain.gain.setValueAtTime(0.1, appState.audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.01,
      appState.audioCtx.currentTime + 0.1,
    );

    osc.start();
    osc.stop(appState.audioCtx.currentTime + 0.1);
  },
  playSuccess() {
    if (!appState.audioCtx) this.init();
    if (appState.audioCtx.state === "suspended") appState.audioCtx.resume();

    const notes = [523.25, 659.25, 783.99, 1046.5]; // C Major Arpeggio
    notes.forEach((freq, i) => {
      const osc = appState.audioCtx.createOscillator();
      const gain = appState.audioCtx.createGain();

      osc.connect(gain);
      gain.connect(appState.audioCtx.destination);

      osc.type = "triangle";
      osc.frequency.setValueAtTime(
        freq,
        appState.audioCtx.currentTime + i * 0.1,
      );

      const start = appState.audioCtx.currentTime + i * 0.1;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.2, start + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.01, start + 0.5);

      osc.start(start);
      osc.stop(start + 0.6);
    });
  },
};

function setupResizeObserver() {
  const observer = new ResizeObserver((entries) => {
    for (let entry of entries) {
      if (entry.target === appState.container) {
        appState.canvas.width = entry.contentRect.width;
        appState.canvas.height = entry.contentRect.height;
      }
    }
  });
  observer.observe(appState.container);
}

function setupImageUpload() {
  const input = document.getElementById("image-upload");
  const btn = document.getElementById("upload-btn");
  if (!input || !btn) return;

  btn.onclick = () => input.click();
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => processImage(img);
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };
}

async function processImage(img) {
  const targetSize = 100; // Increased resolution for much better detail
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // Calculate dimensions
  let w = targetSize,
    h = targetSize;
  if (img.width > img.height) {
    h = Math.round(targetSize * (img.height / img.width));
  } else {
    w = Math.round(targetSize * (img.width / img.height));
  }

  canvas.width = w;
  canvas.height = h;

  // Draw original image (Removed aggressive filters for fidelity)
  ctx.drawImage(img, 0, 0, w, h);

  const imageData = ctx.getImageData(0, 0, w, h).data;
  const palette = [];
  const grid = [];

  // Finer color quantization (step 4) and clamping [0, 255]
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Rounding to 4 and clamping to prevent 256+ values
      const r = Math.min(255, Math.round(imageData[i] / 4) * 4);
      const g = Math.min(255, Math.round(imageData[i + 1] / 4) * 4);
      const b = Math.min(255, Math.round(imageData[i + 2] / 4) * 4);
      const a = imageData[i + 3];

      if (a < 128) {
        row.push(0);
        continue;
      }

      const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
      let colorIdx = palette.indexOf(hex);
      if (colorIdx === -1) {
        if (palette.length < 60) {
          palette.push(hex);
          colorIdx = palette.length - 1;
        } else {
          colorIdx = findClosestColor(hex, palette);
        }
      }
      row.push(colorIdx + 1);
    }
    grid.push(row);
  }

  const customLevel = {
    id: "user_custom_" + Date.now(),
    category: "custom",
    width: w,
    height: h,
    grid: grid,
    palette: palette,
  };

  loadLevel(customLevel.id, customLevel);
}

function findClosestColor(hex, palette) {
  const r1 = parseInt(hex.slice(1, 3), 16);
  const g1 = parseInt(hex.slice(3, 5), 16);
  const b1 = parseInt(hex.slice(5, 7), 16);

  let minChild = 0;
  let minDist = Infinity;

  palette.forEach((p, i) => {
    const r2 = parseInt(p.slice(1, 3), 16);
    const g2 = parseInt(p.slice(3, 5), 16);
    const b2 = parseInt(p.slice(5, 7), 16);
    const dist = Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
    if (dist < minDist) {
      minDist = dist;
      minChild = i;
    }
  });
  return minChild;
}

// Load Levels Manifest
async function loadManifest() {
  try {
    // Use preloaded data in mobile mode
    if (window.PRELOADED_LEVELS) {
      appState.levels = window.PRELOADED_LEVELS;
      return;
    }
    // Fallback to fetch
    const response = await fetch("data/levels.json");
    appState.levels = await response.json();
  } catch (e) {
    console.error("Failed to load manifest", e);
  }
}

// Global observer for lazy loading previews
let galleryObserver = null;

// view các bức tranh
function renderGallery(filter = "all") {
  const grid = document.getElementById("gallery-grid");
  grid.innerHTML = "";

  // Initialize observer if not exists
  if (!galleryObserver) {
    galleryObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const canvas = entry.target.querySelector(".thumbnail-canvas");
            const levelId = entry.target.dataset.id;
            if (canvas && levelId) {
              renderPreview(levelId, canvas);
            }
            galleryObserver.unobserve(entry.target);
          }
        });
      },
      {
        root: grid,
        rootMargin: "100px", // Pre-load images slightly before they enter view
        threshold: 0.1,
      },
    );
  } else {
    galleryObserver.disconnect(); // Clear previous observations
  }

  const filtered =
    filter === "all"
      ? appState.levels
      : appState.levels.filter((l) => l.category === filter);

  filtered.forEach((level) => {
    const div = document.createElement("div");
    div.className = "level-card";
    div.dataset.id = level.id;

    const canvas = document.createElement("canvas");
    canvas.className = "thumbnail-canvas";
    div.appendChild(canvas);

    div.onclick = () => loadLevel(level.id);

    // Check completion
    if (localStorage.getItem(`won_${level.id}`)) {
      div.classList.add("completed");
    }

    grid.appendChild(div);

    // Observe for lazy loading
    galleryObserver.observe(div);
  });
}
//vẽ các bức tranh ra màn hình chính dưới dạng đã được tô màu hoàn chỉnh.
async function renderPreview(id, canvas) {
  try {
    const response = await fetch(`data/${id}.json`);
    const data = await response.json();

    const ctx = canvas.getContext("2d", { alpha: false });

    canvas.width = data.width;
    canvas.height = data.height;

    const paintedPixels = JSON.parse(
      localStorage.getItem(`save_${id}`) || "[]",
    );

    // convert sang map
    const paintedMap = {};

    paintedPixels.forEach((item) => {
      const [x, y] = item.split(",");

      paintedMap[`${x}_${y}`] = true;
    });

    // background
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // render
    data.grid.forEach((row, y) => {
      row.forEach((colorId, x) => {
        if (colorId !== 0) {
          const pixelKey = `${x}_${y}`;

          // đã tô
          if (paintedMap[pixelKey]) {
            ctx.fillStyle = data.palette[colorId - 1];
          } else {
            // chưa tô
            ctx.fillStyle = "#ffffff";
          }

          ctx.fillRect(x, y, 1, 1);
        }
      });
    });
  } catch (e) {
    console.error("Preview failed", e);
  }
}

// load lại tranh để vẽ lại nguyên vẹn những ô bạn đã tô.
async function loadLevel(id, customData = null) {
  try {
    if (customData) {
      appState.currentLevel = customData;
    } else {
      const response = await fetch(`data/${id}.json`);
      appState.currentLevel = await response.json();
    }
    // Initialize Off-screen Progress Canvas
    appState.progressCanvas = document.createElement("canvas");
    appState.progressCanvas.width = appState.currentLevel.width;
    appState.progressCanvas.height = appState.currentLevel.height;
    appState.progressCtx = appState.progressCanvas.getContext("2d", {
      alpha: true,
    });

    const width = appState.currentLevel.width;
    const height = appState.currentLevel.height;
    appState.paintedArray = new Uint8Array(width * height);

    appState.paintedPixels.clear();
    appState.selectedColorId = 1;
    appState.selectedTool = null;
    appState.hintPixel = null;
    appState.colorTotals = {};
    appState.colorPainted = {};

    // Calculate totals
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const colorId = appState.currentLevel.grid[y][x];
        if (colorId !== 0) {
          appState.colorTotals[colorId] =
            (appState.colorTotals[colorId] || 0) + 1;
          appState.colorPainted[colorId] = 0;
        }
      }
    }

    // Load progress
    const saved = localStorage.getItem(`save_${id}`);
    if (saved) {
      const arr = JSON.parse(saved);
      const { palette, grid } = appState.currentLevel;
      arr.forEach((p) => {
        appState.paintedPixels.add(p);
        const [px, py] = p.split(",").map(Number);
        appState.paintedArray[py * width + px] = 1;

        const colorId = grid[py][px];
        appState.colorPainted[colorId] =
          (appState.colorPainted[colorId] || 0) + 1;
        appState.progressCtx.fillStyle = palette[colorId - 1];
        appState.progressCtx.fillRect(px, py, 1, 1);
      });
    }

    // Show view FIRST
    document.getElementById("gallery-view").classList.remove("active");
    document.getElementById("game-view").classList.add("active");

    // Wait for a frame to ensure layout reflow
    requestAnimationFrame(() => {
      centerImage();
      renderPalette();
      updateProgress();
      updateToolUI(); // Update tool UI on level load
    });
  } catch (e) {
    console.error("Failed to load level", e);
  }
}

function centerImage() {
  if (!appState.currentLevel || !appState.container) return;

  const pad = 40;
  const containerW = appState.container.clientWidth;
  const containerH = appState.container.clientHeight;

  const scaleW = (containerW - pad) / appState.currentLevel.width;
  const scaleH = (containerH - pad) / appState.currentLevel.height;

  appState.scale = Math.floor(Math.min(scaleW, scaleH));
  if (appState.scale < 5) appState.scale = 10;

  appState.offsetX =
    (containerW - appState.currentLevel.width * appState.scale) / 2;
  appState.offsetY =
    (containerH - appState.currentLevel.height * appState.scale) / 2;
}

// Render Palette
function renderPalette() {
  const scroll = document.getElementById("palette-scroll");
  scroll.innerHTML = "";

  appState.currentLevel.palette.forEach((color, index) => {
    const colorId = index + 1;
    const btn = document.createElement("div");
    btn.className = `color-btn ${appState.selectedColorId === colorId ? "active" : ""}`;
    btn.style.backgroundColor = color;
    btn.style.flexDirection = "column";
    btn.id = `color-btn-${colorId}`;

    const idDiv = document.createElement("div");
    idDiv.innerText = colorId;

    const percentDiv = document.createElement("div");
    percentDiv.id = `color-percent-${colorId}`;
    percentDiv.style.fontSize = "0.6rem";
    percentDiv.style.opacity = "0.8";
    percentDiv.style.marginTop = "-2px";

    const total = appState.colorTotals[colorId] || 0;
    const painted = appState.colorPainted[colorId] || 0;
    const percent = total > 0 ? Math.floor((painted / total) * 100) : 100;
    percentDiv.innerText = `${percent}%`;

    if (percent === 100) {
      btn.classList.add("done");
    }

    btn.appendChild(idDiv);
    btn.appendChild(percentDiv);

    // Font brightness check
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    btn.style.color = r * 0.299 + g * 0.587 + b * 0.114 > 186 ? "#000" : "#fff";

    btn.onclick = () => {
      appState.selectedColorId = colorId;
      renderPalette();
    };
    scroll.appendChild(btn);
  });
}

// Game Loop / Render
function animate() {
  if (appState.currentLevel) {
    draw();
  }
  requestAnimationFrame(animate);
}

function draw() {
  const { ctx, canvas, scale, offsetX, offsetY, currentLevel, paintedArray } =
    appState;
  if (!currentLevel) return;

  // Background
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  const { width, height, grid, palette } = currentLevel;
  const gridColor = "rgba(255,255,255,0.05)";
  const unpaintedBg = "rgba(255,255,255,0.02)";
  const invScale = 1 / scale;
  const showNumbers = scale > 15;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colorId = grid[y][x];
      if (colorId === 0) continue;

      const isPainted = paintedArray[y * width + x] === 1;

      // 1. Draw Unpainted background & Grid
      if (!isPainted) {
        ctx.fillStyle = unpaintedBg;
        ctx.fillRect(x, y, 1, 1);

        // Highlight color matching
        if (colorId === appState.selectedColorId) {
          ctx.fillStyle = "rgba(255,255,255,0.12)";
          ctx.fillRect(x, y, 1, 1);
        }

        if (showNumbers) {
          ctx.fillStyle = "rgba(255,255,255,0.3)";
          ctx.font = `0.4px Outfit`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(colorId, x + 0.5, y + 0.5);
        }
      }

      // 2. Draw Grid Lines
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = invScale;
      ctx.strokeRect(x, y, 1, 1);

      // 3. Hint
      if (
        appState.hintPixel &&
        appState.hintPixel.x === x &&
        appState.hintPixel.y === y
      ) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = invScale * 3;
        ctx.strokeRect(x, y, 1, 1);
      }
    }
  }

  // 4. Draw ALL Painted Pixels from off-screen canvas (Seamless & Fast)
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(appState.progressCanvas, 0, 0, width, height);

  ctx.restore();

  // Draw Mini-map overlay
  drawMiniMap();
}

function drawMiniMap() {
  const {
    miniMapCanvas: canvas,
    miniMapCtx: ctx,
    currentLevel,
    paintedPixels,
    scale,
    offsetX,
    offsetY,
    container,
  } = appState;
  if (!currentLevel) return;

  const { width, height, grid, palette } = currentLevel;
  const containerEl = document.getElementById("mini-map-container");

  // Only show mini-map when zoomed in
  const totalW = width * scale;
  const totalH = height * scale;
  const isZoomed =
    totalW > container.clientWidth * 1.2 ||
    totalH > container.clientHeight * 1.2;

  containerEl.classList.toggle("active", isZoomed);
  if (!isZoomed) return;

  // Set mini-map canvas size
  const maxMapSize = 110;
  const mapScale = Math.min(maxMapSize / width, maxMapSize / height);
  canvas.width = width * mapScale;
  canvas.height = height * mapScale;

  // Clear and draw mini-map bg (dark)
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw pixel progress simplified
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colorId = grid[y][x];
      if (colorId === 0) continue;

      const isPainted = paintedPixels.has(`${x},${y}`);
      if (isPainted) {
        ctx.fillStyle = palette[colorId - 1];
        ctx.fillRect(x * mapScale, y * mapScale, mapScale, mapScale);
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(x * mapScale, y * mapScale, mapScale, mapScale);
      }
    }
  }

  // Draw Viewport Indicator
  // The viewport rect in image coordinates:
  // Left: -offsetX / scale, Top: -offsetY / scale
  // Width: containerWidth / scale, Height: containerHeight / scale
  const viewportX = (-offsetX / scale) * mapScale;
  const viewportY = (-offsetY / scale) * mapScale;
  const viewportW = (container.clientWidth / scale) * mapScale;
  const viewportH = (container.clientHeight / scale) * mapScale;

  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(viewportX, viewportY, viewportW, viewportH);

  // Slight highlight on viewport
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.fillRect(viewportX, viewportY, viewportW, viewportH);
}

// Events
function setupEventListeners() {
  const canvas = document.getElementById("game-canvas");

  // Aggressive context menu suppression (prevent right-click menu)
  window.addEventListener(
    "contextmenu",
    (e) => {
      if (document.getElementById("game-view").classList.contains("active")) {
        e.preventDefault();
      }
    },
    true,
  );

  // Spacebar Panning (Modern design tool style)
  canvas.onpointerdown = (e) => {
    // Only capture for primary/secondary buttons
    if (e.button === 0 || e.button === 2) {
      canvas.setPointerCapture(e.pointerId);
    }

    appState.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (appState.activePointers.size === 1) {
      if (e.button === 2) {
        appState.isPanning = true;
        e.preventDefault();
      } else if (e.button === 0) {
        appState.isPainting = true;
        paintPixel(e.clientX, e.clientY);
      }
    } else if (appState.activePointers.size === 2) {
      // Two pointers: Always Pan/Zoom
      appState.isPainting = false;
      appState.isPanning = true;
      appState.lastPinchDistance = getPinchDistance();
    }

    appState.lastScreenX = e.clientX;
    appState.lastScreenY = e.clientY;
  };

  canvas.onpointermove = (e) => {
    if (!appState.activePointers.has(e.pointerId)) return;

    // Update pointer position
    appState.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Detect if right button is being held durante move
    const isRightClick = (e.buttons & 2) === 2;
    if (isRightClick) appState.isPanning = true;

    if (
      appState.isPainting &&
      appState.activePointers.size === 1 &&
      !isRightClick
    ) {
      paintPixel(e.clientX, e.clientY);
    } else if (appState.isPanning || appState.activePointers.size === 2) {
      e.preventDefault();
      if (appState.activePointers.size === 2) {
        // Handle Zoom
        const currentDist = getPinchDistance();
        if (appState.lastPinchDistance && currentDist) {
          const ratio = currentDist / appState.lastPinchDistance;
          const oldScale = appState.scale;
          appState.scale *= ratio;
          appState.scale = Math.max(2, Math.min(150, appState.scale));

          // Zoom towards center of two fingers
          const center = getPinchCenter();
          const rect = appState.container.getBoundingClientRect();
          const zoomRatio = appState.scale / oldScale;

          appState.offsetX =
            center.x -
            rect.left -
            (center.x - rect.left - appState.offsetX) * zoomRatio;
          appState.offsetY =
            center.y -
            rect.top -
            (center.y - rect.top - appState.offsetY) * zoomRatio;
        }
        appState.lastPinchDistance = currentDist;

        // Handle Pan (average of two fingers)
        const center = getPinchCenter();
        const dx = center.x - appState.lastScreenX;
        const dy = center.y - appState.lastScreenY;
        appState.offsetX += dx;
        appState.offsetY += dy;
        appState.lastScreenX = center.x;
        appState.lastScreenY = center.y;
      } else {
        // Handle Single-finger/Right-click Pan
        const dx = e.clientX - appState.lastScreenX;
        const dy = e.clientY - appState.lastScreenY;
        appState.offsetX += dx;
        appState.offsetY += dy;
        appState.lastScreenX = e.clientX;
        appState.lastScreenY = e.clientY;
      }
    }
  };

  const handlePointerUp = (e) => {
    appState.activePointers.delete(e.pointerId);
    if (appState.activePointers.size < 2) {
      appState.lastPinchDistance = null;
    }
    if (appState.activePointers.size === 0) {
      appState.isPainting = false;
      appState.isPanning = false;
    }
  };

  canvas.onpointerup = handlePointerUp;
  canvas.onpointercancel = handlePointerUp;
  canvas.onpointerleave = handlePointerUp;

  canvas.onwheel = (e) => {
    e.preventDefault();
    const zoomSpeed = 0.001;
    const delta = -e.deltaY;
    const oldScale = appState.scale;

    appState.scale *= 1 + delta * zoomSpeed;
    appState.scale = Math.max(2, Math.min(150, appState.scale));

    const rect = appState.container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const ratio = appState.scale / oldScale;
    appState.offsetX = mouseX - (mouseX - appState.offsetX) * ratio;
    appState.offsetY = mouseY - (mouseY - appState.offsetY) * ratio;
  };

  // Keyboard support for Spacebar Panning (fallback)
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      appState.isPanning = true;
      canvas.style.cursor = "grab";
      if (e.target === document.body) e.preventDefault();
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      appState.isPanning = false;
      canvas.style.cursor = "crosshair";
    }
  });

  // Navigation
  document.getElementById("back-btn").onclick = () => {
    document.getElementById("game-view").classList.remove("active");
    document.getElementById("gallery-view").classList.add("active");
    appState.currentLevel = null;
  };
  // Zoom reset
  document.getElementById("zoom-reset-btn").onclick = centerImage;

  // Tools
  const wandBtn = document.getElementById("tool-wand");
  const bombBtn = document.getElementById("tool-bomb");
  const hintBtn = document.getElementById("tool-hint");

  if (wandBtn)
    wandBtn.onclick = () => {
      appState.selectedTool = appState.selectedTool === "wand" ? null : "wand";
      updateToolUI();
    };
  if (bombBtn)
    bombBtn.onclick = () => {
      appState.selectedTool = appState.selectedTool === "bomb" ? null : "bomb";
      updateToolUI();
    };
  if (hintBtn) hintBtn.onclick = useHint;
}

function updateToolUI() {
  const wandBtn = document.getElementById("tool-wand");
  const bombBtn = document.getElementById("tool-bomb");
  if (wandBtn)
    wandBtn.classList.toggle("active", appState.selectedTool === "wand");
  if (bombBtn)
    bombBtn.classList.toggle("active", appState.selectedTool === "bomb");
}

function useHint() {
  if (!appState.currentLevel) return;

  // Find unpainted pixel for current color
  let targetX = -1,
    targetY = -1;
  const { grid, width, height } = appState.currentLevel;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (
        grid[y][x] === appState.selectedColorId &&
        !appState.paintedPixels.has(`${x},${y}`)
      ) {
        targetX = x;
        targetY = y;
        break;
      }
    }
    if (targetX !== -1) break;
  }

  if (targetX !== -1) {
    // Zoom and Pan to this pixel
    appState.scale = 40; // Zoom in
    const containerW = appState.container.clientWidth;
    const containerH = appState.container.clientHeight;

    appState.offsetX =
      containerW / 2 - (targetX * appState.scale + appState.scale / 2);
    appState.offsetY =
      containerH / 2 - (targetY * appState.scale + appState.scale / 2);

    appState.hintPixel = { x: targetX, y: targetY };
    setTimeout(() => {
      appState.hintPixel = null;
    }, 3000);

    if (navigator.vibrate) navigator.vibrate(50);
  }
}

// Categories
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.onclick = () => {
    document.querySelector(".tab-btn.active").classList.remove("active");
    btn.classList.add("active");
    renderGallery(btn.dataset.category);
  };
});

// Logic tô màu
function paintPixel(screenX, screenY) {
  if (!appState.currentLevel) return;

  const rect = appState.canvas.getBoundingClientRect(); // Use appState.canvas
  const x = Math.floor(
    (screenX - rect.left - appState.offsetX) / appState.scale,
  );
  const y = Math.floor(
    (screenY - rect.top - appState.offsetY) / appState.scale,
  );

  if (
    x >= 0 &&
    x < appState.currentLevel.width &&
    y >= 0 &&
    y < appState.currentLevel.height
  ) {
    if (appState.selectedTool === "wand") {
      useMagicWand(x, y); // vẽ  lan theo số tool-wand
      appState.selectedTool = null;
      updateToolUI();
      return;
    }

    if (appState.selectedTool === "bomb") {
      useBomb(x, y); // boom nổ  tool-bomb
      appState.selectedTool = null;
      updateToolUI();
      return;
    }

    const colorId = appState.currentLevel.grid[y][x];
    if (colorId === appState.selectedColorId) {
      const pos = `${x},${y}`;
      if (!appState.paintedPixels.has(pos)) {
        appState.paintedPixels.add(pos);
        appState.colorPainted[colorId] =
          (appState.colorPainted[colorId] || 0) + 1;
        appState.paintedArray[y * appState.currentLevel.width + x] = 1;

        // Draw to off-screen progress canvas
        appState.progressCtx.fillStyle =
          appState.currentLevel.palette[colorId - 1];
        appState.progressCtx.fillRect(x, y, 1, 1);

        appState.progressCtx.fillStyle =
          appState.currentLevel.palette[colorId - 1];
        appState.progressCtx.fillRect(x, y, 1, 1);

        triggerHaptic();
        SoundManager.playPop();
        updateProgress();
        checkWin(); // Kiểm tra win sau khi tô màu
      }
    }
  }
}

function triggerHaptic() {
  if (navigator.vibrate) {
    navigator.vibrate(15);
  }
}
// vẽ
function useMagicWand(startX, startY) {
  const targetColorId = appState.currentLevel.grid[startY][startX];
  if (targetColorId === 0) return;

  // Standard flood fill for connected region of SAME color number
  const stack = [[startX, startY]];
  const colorToFill = targetColorId;

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const pos = `${x},${y}`;

    if (
      x < 0 ||
      x >= appState.currentLevel.width ||
      y < 0 ||
      y >= appState.currentLevel.height
    )
      continue;
    if (appState.currentLevel.grid[y][x] !== colorToFill) continue;
    if (appState.paintedPixels.has(pos)) continue;
    appState.paintedPixels.add(pos);
    appState.colorPainted[colorToFill] =
      (appState.colorPainted[colorToFill] || 0) + 1;
    appState.paintedArray[y * appState.currentLevel.width + x] = 1;

    // Draw to off-screen progress canvas
    appState.progressCtx.fillStyle =
      appState.currentLevel.palette[colorToFill - 1];
    appState.progressCtx.fillRect(x, y, 1, 1);

    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  if (navigator.vibrate) navigator.vibrate([30, 50, 30]);
  SoundManager.playPop();
  updateProgress();
  checkWin(); // Kiểm tra win sau khi dùng công cụ
}

// boom nổ
function useBomb(centerX, centerY) {
  const radius = 3; // 7x7 area
  let count = 0;

  for (let y = centerY - radius; y <= centerY + radius; y++) {
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      if (
        x >= 0 &&
        x < appState.currentLevel.width &&
        y >= 0 &&
        y < appState.currentLevel.height
      ) {
        const colorId = appState.currentLevel.grid[y][x];
        if (colorId !== 0) {
          const pos = `${x},${y}`;
          if (!appState.paintedPixels.has(pos)) {
            appState.paintedPixels.add(pos);
            appState.colorPainted[colorId] =
              (appState.colorPainted[colorId] || 0) + 1;
            appState.paintedArray[y * appState.currentLevel.width + x] = 1;

            // Draw to off-screen progress canvas
            appState.progressCtx.fillStyle =
              appState.currentLevel.palette[colorId - 1];
            appState.progressCtx.fillRect(x, y, 1, 1);

            count++;
          }
        }
      }
    }
  }

  if (count > 0) {
    if (navigator.vibrate) navigator.vibrate(100);
    SoundManager.playPop();
    updateProgress();
    checkWin(); // Check for win after using a tool
  }
}

function getPinchDistance() {
  const pointers = Array.from(appState.activePointers.values());
  if (pointers.length < 2) return 0;
  const dx = pointers[0].x - pointers[1].x;
  const dy = pointers[0].y - pointers[1].y;
  return Math.sqrt(dx * dx + dy * dy);
}

function getPinchCenter() {
  const pointers = Array.from(appState.activePointers.values());
  if (pointers.length < 2) return pointers[0] || { x: 0, y: 0 };
  return {
    x: (pointers[0].x + pointers[1].x) / 2,
    y: (pointers[0].y + pointers[1].y) / 2,
  };
}

function updateProgress() {
  if (!appState.currentLevel) return;
  const total = appState.currentLevel.grid.flat().filter((c) => c !== 0).length;
  const current = appState.paintedPixels.size;
  const percent = Math.floor((current / total) * 100);

  document.getElementById("progress-bar").style.width = `${percent}%`;
  document.getElementById("progress-text").innerText = `${percent}%`;

  // Update color buttons progress
  for (const colorId in appState.colorTotals) {
    const btn = document.getElementById(`color-btn-${colorId}`);
    if (btn) {
      const colorTotal = appState.colorTotals[colorId];
      const colorPainted = appState.colorPainted[colorId] || 0;
      const colorPercent =
        colorTotal > 0 ? Math.floor((colorPainted / colorTotal) * 100) : 100;

      const percentEl = document.getElementById(`color-percent-${colorId}`);
      if (percentEl) {
        percentEl.innerText = `${colorPercent}%`;
      }
      if (colorPercent === 100) {
        btn.classList.add("done");
      }
    }
  }

  // Debounced Save
  if (appState.saveTimeout) clearTimeout(appState.saveTimeout);
  appState.saveTimeout = setTimeout(() => {
    saveProgressImmediate();
  }, 1000);
}

function saveProgressImmediate() {
  if (!appState.currentLevel) return;
  localStorage.setItem(
    `save_${appState.currentLevel.id}`,
    JSON.stringify(Array.from(appState.paintedPixels)),
  );
}

function checkWin() {
  const total = appState.currentLevel.grid.flat().filter((c) => c !== 0).length;
  if (appState.paintedPixels.size === total) {
    localStorage.setItem(`won_${appState.currentLevel.id}`, "true");

    // Populate Result Preview
    const previewContainer = document.getElementById("result-preview");
    previewContainer.innerHTML = "";
    const previewCanvas = document.createElement("canvas");
    previewCanvas.width = appState.currentLevel.width;
    previewCanvas.height = appState.currentLevel.height;
    const pCtx = previewCanvas.getContext("2d");
    pCtx.drawImage(appState.progressCanvas, 0, 0);

    previewCanvas.classList.add("final-preview");
    previewContainer.appendChild(previewCanvas);

    document.getElementById("success-overlay").classList.add("active");
    SoundManager.playSuccess();

    // Confetti!
    confetti({
      particleCount: 150,
      spread: 70,
      origin: { y: 0.6 },
      colors: ["#60a5fa", "#a78bfa", "#facc15"],
    });
  }
}

// Overlay controls
document.getElementById("close-modal-btn").onclick = () => {
  document.getElementById("success-overlay").classList.remove("active");
};

document.getElementById("next-btn").onclick = () => {
  document.getElementById("success-overlay").classList.remove("active");
  // Find next level logic...
  const idx = appState.levels.findIndex(
    (l) => l.id === appState.currentLevel.id,
  );
  if (idx < appState.levels.length - 1) {
    loadLevel(appState.levels[idx + 1].id);
  } else {
    document.getElementById("back-btn").click();
  }
};

init();
