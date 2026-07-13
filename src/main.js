import cornerstone from 'cornerstone-core';
import cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import dicomParser from 'dicom-parser';

// Setup external dependencies
cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
cornerstoneWADOImageLoader.external.dicomParser = dicomParser;

// Initialize Web Workers path using jsDelivr CDN
// This bypasses complex Vite configurations for copying WASM and worker scripts
cornerstoneWADOImageLoader.webWorkerManager.initialize({
  maxWebWorkers: navigator.hardwareConcurrency || 1,
  startWebWorkersOnDemand: true,
  webWorkerPath: 'https://cdn.jsdelivr.net/npm/cornerstone-wado-image-loader@4.1.3/dist/cornerstoneWADOImageLoaderWebWorker.min.js',
  taskConfiguration: {
    decodeTask: {
      codecsPath: 'https://cdn.jsdelivr.net/npm/cornerstone-wado-image-loader@4.1.3/dist/cornerstoneWADOImageLoaderCodecs.min.js'
    }
  }
});

// App State
let scansData = [];
let activeScan = null;
let activeSeries = null;
let activeSliceIndex = 0;
let loadedImageCount = 0;

// Viewport Persistence Mapped by Series ID
const savedViewports = {};

// Keyboard State Tracker
let keysPressed = {};

// Cine Settings
let activeTool = 'wl'; // 'wl', 'zoom', 'pan'
let isCinePlaying = false;
let cineIntervalId = null;
let cineFps = 15;

// Cryptography State
let decryptionPasscode = '';
let decryptedImageIds = []; // Cache of decrypted blob imageIds for the current series

// DOM Elements
const viewportElement = document.getElementById('cornerstone-viewport');
const scanSelect = document.getElementById('scan-select');
const seriesListContainer = document.getElementById('series-list');
const seriesCountBadge = document.getElementById('series-count-badge');
const sliceSlider = document.getElementById('slice-slider');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');

// HUD Elements
const hudPatientName = document.getElementById('hud-patient-name');
const hudPatientId = document.getElementById('hud-patient-id');
const hudStudyDesc = document.getElementById('hud-study-desc');
const hudSeriesName = document.getElementById('hud-series-name');
const hudSliceIndex = document.getElementById('hud-slice-index');
const hudZoom = document.getElementById('hud-zoom');
const hudWindowLevel = document.getElementById('hud-window-level');
const hudRenderFps = document.getElementById('hud-render-fps');

// Toolbar buttons
const btnToolWl = document.getElementById('tool-wl');
const btnToolZoom = document.getElementById('tool-zoom');
const btnToolPan = document.getElementById('tool-pan');
const btnToolPlay = document.getElementById('tool-play');
const btnToolReset = document.getElementById('tool-reset');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const fpsSlider = document.getElementById('fps-range');
const fpsValueText = document.getElementById('fps-value');

// Password Modal Elements
const passwordOverlay = document.getElementById('password-overlay');
const passwordForm = document.getElementById('password-form');
const passwordInput = document.getElementById('password-input');
const passwordError = document.getElementById('password-error');

// Initialize cornerstone viewport
cornerstone.enable(viewportElement);

// --- Cryptographic Helper Functions ---

// Convert passcode string to ArrayBuffer bytes
function strToArrayBuffer(str) {
  const enc = new TextEncoder();
  return enc.encode(str);
}

// Derive cryptographic AES key from passcode and salt via PBKDF2 (Matches Node script params)
async function deriveDecryptionKey(passcode, saltBuffer) {
  const baseKey = await window.crypto.subtle.importKey(
    "raw",
    strToArrayBuffer(passcode),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  
  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations: 100000,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

// Fetch and decrypt single scan file from server (.dcm.enc)
async function fetchAndDecrypt(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch file. HTTP status: ${response.status}`);
  }
  
  const encryptedData = await response.arrayBuffer();
  if (encryptedData.byteLength < 28) {
    throw new Error("Invalid payload: file size too small to contain encryption wrappers.");
  }
  
  // Unpack format: [Salt (16b)][IV (12b)][Ciphertext + GCM Tag]
  const salt = encryptedData.slice(0, 16);
  const iv = encryptedData.slice(16, 28);
  const ciphertextAndTag = encryptedData.slice(28);
  
  const key = await deriveDecryptionKey(decryptionPasscode, salt);
  
  // Decrypt GCM block (Web Crypto handles tag verification appended to ciphertext automatically)
  const decryptedBuffer = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv,
      tagLength: 128
    },
    key,
    ciphertextAndTag
  );
  
  return decryptedBuffer;
}

// Construct absolute URL for the requested slice file index
function getEncryptedUrl(index) {
  const filename = activeSeries.files[index];
  const relativePath = `scans/${activeScan.id}/${activeSeries.id}/${filename}`;
  return new URL(relativePath, window.location.href).href;
}

// Load the exams configuration index list
async function loadExams() {
  showLoading('Fetching studies index...');
  try {
    const response = await fetch('./scans.json');
    if (!response.ok) {
      throw new Error(`Failed to load scans index. HTTP status: ${response.status}`);
    }
    scansData = await response.json();
    if (!scansData || scansData.length === 0) {
      throw new Error('No scans found in scans.json index.');
    }
    
    // Find the first series of the first scan to verify the passcode
    const firstScan = scansData[0];
    const firstSeries = firstScan.series[0];
    const firstFilename = firstSeries.files[0];
    
    // Attempt to fetch and decrypt this single file as validation
    const testUrl = new URL(`scans/${firstScan.id}/${firstSeries.id}/${firstFilename}`, window.location.href).href;
    await fetchAndDecrypt(testUrl);
    
    // Decryption succeeded! Dismiss password dialog
    passwordOverlay.classList.add('hidden');
    hideLoading();
    
    populateExamsSelector();
    // Select first exam by default
    selectExam(firstScan.id);
  } catch (error) {
    console.error('Decryption test failed:', error);
    // Decryption failed (probably wrong password)
    passwordError.textContent = error.name === 'OperationError' || error.message.includes('decryp')
      ? 'Invalid passcode. Please try again.'
      : `Error: ${error.message}`;
    passwordError.classList.remove('hidden');
    hideLoading();
    decryptionPasscode = '';
  }
}

// Trigger load index on passcode submission
passwordForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = passwordInput.value.trim();
  if (!code) return;
  
  decryptionPasscode = code;
  passwordError.classList.add('hidden');
  loadExams();
});

function populateExamsSelector() {
  scanSelect.innerHTML = '';
  scansData.forEach(scan => {
    const option = document.createElement('option');
    option.value = scan.id;
    option.textContent = scan.name;
    scanSelect.appendChild(option);
  });
  
  scanSelect.addEventListener('change', (e) => {
    selectExam(e.target.value);
  });
}

function selectExam(scanId) {
  activeScan = scansData.find(s => s.id === scanId);
  if (!activeScan) return;
  
  // Update sidebar list of series
  populateSeriesSidebar();
  
  // Select first series by default
  if (activeScan.series && activeScan.series.length > 0) {
    selectSeries(activeScan.series[0].id);
  }
}

function populateSeriesSidebar() {
  seriesListContainer.innerHTML = '';
  seriesCountBadge.textContent = activeScan.series.length;
  
  activeScan.series.forEach(series => {
    const card = document.createElement('div');
    card.className = `series-card`;
    card.dataset.id = series.id;
    
    // Attempt to parse series type icon
    let typeIcon = 'IMG';
    if (series.name.includes('SAG')) typeIcon = 'SAG';
    else if (series.name.includes('COR')) typeIcon = 'COR';
    else if (series.name.includes('TRA') || series.name.includes('AXI')) typeIcon = 'AXI';
    else if (series.name.includes('MPR')) typeIcon = '3D';
    
    card.innerHTML = `
      <div class="series-card-header">
        <div class="series-icon">${typeIcon}</div>
        <span class="series-slices-badge">${series.filesCount} Slices</span>
      </div>
      <div class="series-card-body">
        <h3>${series.name}</h3>
        <span class="series-meta">${series.id.split('_').pop() || 'DICOM Series'}</span>
      </div>
    `;
    
    card.addEventListener('click', () => {
      selectSeries(series.id);
    });
    
    seriesListContainer.appendChild(card);
  });
}

async function selectSeries(seriesId) {
  // Stop Cine loop if playing
  stopCine();
  
  activeSeries = activeScan.series.find(s => s.id === seriesId);
  if (!activeSeries) return;
  
  // Update active card class
  const cards = seriesListContainer.querySelectorAll('.series-card');
  cards.forEach(card => {
    if (card.dataset.id === seriesId) {
      card.classList.add('active');
    } else {
      card.classList.remove('active');
    }
  });
  
  // Clear and initialize decryptedImageIds array for this series length
  decryptedImageIds = new Array(activeSeries.files.length).fill(null);
  loadedImageCount = 0;
  
  // Restore saved slice index if it exists for this series, otherwise default to 0
  const saved = savedViewports[activeSeries.id];
  activeSliceIndex = (saved && saved.sliceIndex !== undefined) ? saved.sliceIndex : 0;
  
  // Update slider bounds
  sliceSlider.max = activeSeries.files.length - 1;
  sliceSlider.value = activeSliceIndex;
  
  showLoading(`Decrypting and loading series...`);
  
  // Load and display slice
  await displaySlice(activeSliceIndex);
  hideLoading();
  
  // Preload adjacent slices in background to ensure lightning fast scrolling
  preloadSlices();
}

// Preload remaining slices in memory for instant scrolling
async function preloadSlices() {
  const currentSeriesId = activeSeries.id;
  
  for (let i = 0; i < activeSeries.files.length; i++) {
    // Avoid loading if user switched away
    if (activeSeries.id !== currentSeriesId) break;
    
    try {
      let imageId = decryptedImageIds[i];
      if (!imageId) {
        const url = getEncryptedUrl(i);
        const decryptedBuffer = await fetchAndDecrypt(url);
        const blob = new Blob([decryptedBuffer], { type: 'application/dicom' });
        const blobUrl = URL.createObjectURL(blob);
        imageId = `wadouri:${blobUrl}`;
        decryptedImageIds[i] = imageId;
      }
      
      await cornerstone.loadAndCacheImage(imageId);
      loadedImageCount++;
      
      // If we are still on the same series, update caching progress overlay
      if (activeSeries.id === currentSeriesId && loadingOverlay.classList.contains('hidden') === false) {
        showLoading(`Caching slices... ${Math.round((loadedImageCount / activeSeries.files.length) * 100)}%`);
        if (loadedImageCount === activeSeries.files.length) {
          hideLoading();
        }
      }
    } catch (e) {
      console.warn(`Failed to preload slice ${i}:`, e);
    }
  }
}

// Save the current viewport settings for the active series
function saveCurrentViewport() {
  if (!activeSeries) return;
  try {
    const viewport = cornerstone.getViewport(viewportElement);
    if (viewport) {
      savedViewports[activeSeries.id] = {
        sliceIndex: activeSliceIndex,
        scale: viewport.scale,
        translation: { x: viewport.translation.x, y: viewport.translation.y },
        voi: { windowWidth: viewport.voi.windowWidth, windowCenter: viewport.voi.windowCenter }
      };
    }
  } catch (e) {
    // Viewport not enabled/loaded yet
  }
}

// Main image loading and rendering wrapper
async function displaySlice(index) {
  if (index < 0 || index >= activeSeries.files.length) return;
  
  activeSliceIndex = index;
  
  try {
    // Get the current viewport state before switching images, to preserve temporary scroll settings
    let currentViewport = null;
    try {
      currentViewport = cornerstone.getViewport(viewportElement);
    } catch (e) {
      // Viewport not enabled/displayed yet
    }

    // Resolve or fetch-and-decrypt the imageId
    let imageId = decryptedImageIds[index];
    if (!imageId) {
      showLoading('Decrypting slice...');
      const url = getEncryptedUrl(index);
      const decryptedBuffer = await fetchAndDecrypt(url);
      const blob = new Blob([decryptedBuffer], { type: 'application/dicom' });
      const blobUrl = URL.createObjectURL(blob);
      imageId = `wadouri:${blobUrl}`;
      decryptedImageIds[index] = imageId;
      hideLoading();
    }

    const image = await cornerstone.loadImage(imageId);
    
    // Ensure that this load event was not delayed and the user did not switch series in the meantime
    if (decryptedImageIds[index] !== imageId) return;
    
    cornerstone.displayImage(viewportElement, image);
    
    // Apply saved viewport settings if they exist for this series,
    // or preserve the current viewport settings if scrolling within the same series
    const saved = savedViewports[activeSeries.id];
    if (saved) {
      const viewport = cornerstone.getViewport(viewportElement);
      viewport.scale = saved.scale;
      viewport.translation.x = saved.translation.x;
      viewport.translation.y = saved.translation.y;
      viewport.voi.windowWidth = saved.voi.windowWidth;
      viewport.voi.windowCenter = saved.voi.windowCenter;
      cornerstone.setViewport(viewportElement, viewport);
    } else if (currentViewport) {
      const viewport = cornerstone.getViewport(viewportElement);
      viewport.scale = currentViewport.scale;
      viewport.translation.x = currentViewport.translation.x;
      viewport.translation.y = currentViewport.translation.y;
      viewport.voi.windowWidth = currentViewport.voi.windowWidth;
      viewport.voi.windowCenter = currentViewport.voi.windowCenter;
      cornerstone.setViewport(viewportElement, viewport);
      
      // Also cache it as the active series viewport
      saveCurrentViewport();
    } else {
      // First time loading this series - store the baseline defaults
      saveCurrentViewport();
    }
    
    // Update Slider
    sliceSlider.value = index;
    
    // Cache the updated slice number in saved state
    if (savedViewports[activeSeries.id]) {
      savedViewports[activeSeries.id].sliceIndex = index;
    }
    
    // Update HUD overlays
    updateHUD(image);
  } catch (error) {
    console.error(`Error displaying slice ${index}:`, error);
    showError(`Failed to load slice: ${error.message}`);
  }
}

function updateHUD(image) {
  // Update overlay numbers
  hudSliceIndex.textContent = `Slice: ${activeSliceIndex + 1} / ${activeSeries.files.length}`;
  
  // Read dicom metadata fields if available
  const dataset = image.data;
  if (dataset) {
    // Patient Name: tag (0010,0010)
    const name = dataset.string('x00100010') || 'Dijkstra Melle';
    hudPatientName.textContent = `Patient: ${name.replace(/\^/g, ', ')}`;
    
    // Patient ID: tag (0010,0020)
    const id = dataset.string('x00100020') || 'DIJK-RODILLA-07';
    hudPatientId.textContent = `ID: ${id}`;
    
    // Study description: tag (0008,1030)
    const study = dataset.string('x00081030') || 'MRI Knee Left (Rodilla)';
    hudStudyDesc.textContent = `Study: ${study}`;
  }
  
  hudSeriesName.textContent = activeSeries.name;
  
  // Scale and window properties
  const viewport = cornerstone.getViewport(viewportElement);
  hudZoom.textContent = `Zoom: ${Math.round(viewport.scale * 100)}%`;
  
  const w = Math.round(viewport.voi.windowWidth);
  const l = Math.round(viewport.voi.windowCenter);
  hudWindowLevel.textContent = `W: ${w} L: ${l}`;
  
  hudRenderFps.textContent = isCinePlaying ? `Cine Speed: ${cineFps} fps` : 'Cine Speed: Paused';
}

function changeSlice(direction) {
  let newIndex = activeSliceIndex + direction;
  if (newIndex < 0) newIndex = 0;
  if (newIndex >= activeSeries.files.length) newIndex = activeSeries.files.length - 1;
  
  if (newIndex !== activeSliceIndex) {
    displaySlice(newIndex);
  }
}

// --- CINE Loop (Auto Scrolling) ---
function startCine() {
  if (isCinePlaying) return;
  isCinePlaying = true;
  
  playIcon.classList.add('hidden');
  pauseIcon.classList.remove('hidden');
  btnToolPlay.classList.add('active');
  
  const intervalMs = 1000 / cineFps;
  cineIntervalId = setInterval(() => {
    let nextIndex = activeSliceIndex + 1;
    // Loop back to start if finished
    if (nextIndex >= activeSeries.files.length) {
      nextIndex = 0;
    }
    displaySlice(nextIndex);
  }, intervalMs);
  
  const viewport = cornerstone.getViewport(viewportElement);
  if (viewport) updateHUD({ data: null });
}

function stopCine() {
  if (!isCinePlaying) return;
  isCinePlaying = false;
  
  playIcon.classList.remove('hidden');
  pauseIcon.classList.add('hidden');
  btnToolPlay.classList.remove('active');
  
  if (cineIntervalId) {
    clearInterval(cineIntervalId);
    cineIntervalId = null;
  }
  
  const viewport = cornerstone.getViewport(viewportElement);
  if (viewport) updateHUD({ data: null });
}

// --- Viewport Interaction Logic (Mouse Gestures & Key Modifiers) ---
let isDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;

// Update mouse cursor indicator and active styles dynamically based on shortcuts
function updateToolState(e) {
  let effectiveTool = activeTool;
  
  // Determine if modifier keys or letter hotkeys are pressed
  const isZoomPressed = e.shiftKey || keysPressed['KeyZ'] || keysPressed['KeyZ'.toLowerCase()];
  const isPanPressed = e.ctrlKey || e.altKey || e.metaKey || keysPressed['KeyP'] || keysPressed['Space'];
  const isWlPressed = keysPressed['KeyW'] || keysPressed['KeyC'];
  
  if (isZoomPressed) {
    effectiveTool = 'zoom';
  } else if (isPanPressed) {
    effectiveTool = 'pan';
  } else if (isWlPressed) {
    effectiveTool = 'wl';
  }
  
  // Change mouse cursor indicator
  if (effectiveTool === 'wl') {
    viewportElement.style.cursor = 'ew-resize';
  } else if (effectiveTool === 'zoom') {
    viewportElement.style.cursor = 'ns-resize';
  } else if (effectiveTool === 'pan') {
    viewportElement.style.cursor = 'move';
  }
  
  // Highlight buttons in toolbar
  btnToolWl.classList.toggle('active', effectiveTool === 'wl');
  btnToolZoom.classList.toggle('active', effectiveTool === 'zoom');
  btnToolPan.classList.toggle('active', effectiveTool === 'pan');

  return effectiveTool;
}

// Window Keyboard listeners for active shortcuts
window.addEventListener('keydown', (e) => {
  keysPressed[e.code] = true;
  
  // Prevent default actions for viewer keybinds (e.g. space page scrolling)
  if (['Space', 'KeyZ', 'KeyP', 'KeyC', 'KeyW'].includes(e.code)) {
    e.preventDefault();
  }
  
  updateToolState(e);
});

window.addEventListener('keyup', (e) => {
  keysPressed[e.code] = false;
  updateToolState(e);
});

window.addEventListener('blur', () => {
  // Clear keys on blur to prevent sticking keys
  keysPressed = {};
  // Reset cursor to active toolbar state
  setTool(activeTool);
});

viewportElement.addEventListener('mousedown', (e) => {
  isDragging = true;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  // Always update cursor state based on active keys, even if not dragging
  const effectiveTool = updateToolState(e);

  if (!isDragging) return;
  
  const deltaX = e.clientX - lastMouseX;
  const deltaY = e.clientY - lastMouseY;
  
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  
  const viewport = cornerstone.getViewport(viewportElement);
  if (!viewport) return;
  
  if (effectiveTool === 'wl') {
    // Contrast (Window Width) / Brightness (Window Level)
    viewport.voi.windowWidth += deltaX * 1.8;
    viewport.voi.windowCenter += deltaY * 1.8;
    cornerstone.setViewport(viewportElement, viewport);
    saveCurrentViewport();
    updateHUD({ data: null });
  } else if (effectiveTool === 'zoom') {
    // Zoom in/out via drag vertical
    const scaleFactor = 1.0 - (deltaY * 0.01);
    viewport.scale = Math.min(Math.max(viewport.scale * scaleFactor, 0.1), 12.0);
    cornerstone.setViewport(viewportElement, viewport);
    saveCurrentViewport();
    updateHUD({ data: null });
  } else if (effectiveTool === 'pan') {
    // Pan viewport translation
    viewport.translation.x += deltaX / viewport.scale;
    viewport.translation.y += deltaY / viewport.scale;
    cornerstone.setViewport(viewportElement, viewport);
    saveCurrentViewport();
    updateHUD({ data: null });
  }
});

window.addEventListener('mouseup', () => {
  isDragging = false;
});

// Wheel scroll for changing slices
viewportElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  
  // Scroll slices: mouse wheel scroll speed filter
  if (e.deltaY > 0) {
    changeSlice(1);
  } else if (e.deltaY < 0) {
    changeSlice(-1);
  }
}, { passive: false });

// Slider input scroll
sliceSlider.addEventListener('input', (e) => {
  const targetIndex = parseInt(e.target.value, 10);
  if (targetIndex !== activeSliceIndex) {
    displaySlice(targetIndex);
  }
});

// Auto resize on window resizing
window.addEventListener('resize', () => {
  cornerstone.resize(viewportElement, true);
});

// Tool selector buttons actions
btnToolWl.addEventListener('click', () => setTool('wl'));
btnToolZoom.addEventListener('click', () => setTool('zoom'));
btnToolPan.addEventListener('click', () => setTool('pan'));

btnToolPlay.addEventListener('click', () => {
  if (isCinePlaying) {
    stopCine();
  } else {
    startCine();
  }
});

btnToolReset.addEventListener('click', () => {
  cornerstone.reset(viewportElement);
  if (activeSeries) {
    // Remove persistence cache for this series on Reset
    delete savedViewports[activeSeries.id];
  }
  const viewport = cornerstone.getViewport(viewportElement);
  saveCurrentViewport();
  updateHUD({ data: null });
});

fpsSlider.addEventListener('input', (e) => {
  cineFps = parseInt(e.target.value, 10);
  fpsValueText.textContent = cineFps;
  
  // If playing, restart interval with new speed
  if (isCinePlaying) {
    stopCine();
    startCine();
  }
});

function setTool(toolName) {
  activeTool = toolName;
  
  // Update UI active buttons
  btnToolWl.classList.toggle('active', toolName === 'wl');
  btnToolZoom.classList.toggle('active', toolName === 'zoom');
  btnToolPan.classList.toggle('active', toolName === 'pan');
  
  // Change mouse cursor indicator
  if (toolName === 'wl') {
    viewportElement.style.cursor = 'ew-resize';
  } else if (toolName === 'zoom') {
    viewportElement.style.cursor = 'ns-resize';
  } else if (toolName === 'pan') {
    viewportElement.style.cursor = 'move';
  }
}

// --- Loading overlays wrappers ---
function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

function showError(text) {
  loadingText.textContent = text;
  loadingText.style.color = '#ef4444';
  const spinner = loadingOverlay.querySelector('.spinner');
  if (spinner) spinner.style.display = 'none';
  loadingOverlay.classList.remove('hidden');
}

// Start app
setTool('wl');
// Trigger modal passcode prompt initially
passwordOverlay.classList.remove('hidden');
hideLoading();
