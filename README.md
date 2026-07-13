# MRI Scan Viewer

A clinical-grade, high-performance static MRI scan viewer built with **Vite**, **Vanilla JavaScript**, and **CornerstoneJS**.

## Features

- **Multi-series Navigation**: Sidebar automatically lists all series (Axial, Coronal, Sagittal, etc.) inside a study with slice count badges.
- **PACS Keyboard & Mouse Controls**:
  - **Left Click + Drag**: Adjust Window Width (contrast) / Window Center (brightness) by default.
  - **Scroll Wheel**: Scroll forward/backward through slices (contrast/zoom/pan persist during scrolling).
  - **Shift + Drag (Gesture)**: Hold `Shift` while dragging to Zoom.
  - **Alt / Ctrl / Space + Drag (Gesture)**: Hold `Alt`, `Ctrl`, or `Spacebar` while dragging to Pan.
  - **Key Hold Hotkeys**: Hold `Z` (Zoom), `P` (Pan), or `W` / `C` (Contrast) to temporarily select that tool. Releasing returns to the previous tool.
- **Series Configuration State Persistence**: Automatically remembers and restores contrast (Window/Level), Zoom scale, and Pan translations separately for each series. Switching back and forth restores your exact configured viewport.
- **Cine Auto-play Loop**: Play through slices automatically like a movie, with real-time FPS adjustable slider.
- **Overlay HUD**: PACS-workstation metadata layout displaying Patient info, Series info, Zoom levels, Slice numbers, and Window/Level values.
- **Auto-Generating Scan Index**: Includes a Node script to crawl nested DICOM folders and compile the application dataset.
- **GitHub Pages Ready**: Builds cleanly to a zero-configuration static site bundle.

## Get Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Local Development Server
```bash
npm run dev
```
Open [http://localhost:3000/](http://localhost:3000/) in your browser.

### 3. Build for Production
```bash
npm run build
```
This compiles a static version in the `dist/` directory, ready to be hosted on **GitHub Pages**, Netlify, or any static file server.

---

## Adding More MRI Scans

This repo automatically indexes any scans placed in the data folder:

1. Drop your new patient MRI directory into `public/scans/`. For example:
   ```
   public/scans/PATIENT_JOHN_DOE_MRI/
   ├── Series_1_Localizer/
   │   ├── Instance_0001.dcm
   │   └── ...
   └── Series_2_T2_SAG/
       ├── Instance_0001.dcm
       └── ...
   ```
2. The index list is automatically updated when you run `npm run dev` or `npm run build`.
3. To regenerate the index manually at any time, run:
   ```bash
   npm run generate-index
   ```
4. Open the viewer, and selection dropdown in the header will now list the new scan.
