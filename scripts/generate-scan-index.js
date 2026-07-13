import fs from 'fs';
import path from 'path';

const SCANS_DIR = path.join(process.cwd(), 'public', 'scans');
const OUTPUT_FILE = path.join(process.cwd(), 'public', 'scans.json');

// Helper to format scan names nicely
function formatScanName(dirName) {
  return dirName
    .replace(/_/g, ' ')
    .replace(/\b[a-z]/g, (char) => char.toUpperCase())
    .replace('Mri', 'MRI')
    .replace('Rodilla', 'Knee (Rodilla)');
}

// Helper to format series names nicely
function formatSeriesName(dirName) {
  // e.g., "Series_6_T1_SAG_smkn" -> "T1 SAG (Series 6)"
  const match = dirName.match(/^Series_(\d+)_(.+)$/i);
  if (match) {
    const num = match[1];
    let name = match[2]
      .replace(/_/g, ' ')
      .trim();
    
    // Clean up trailing tags like "smkn"
    name = name.replace(/\bsmkn\b/gi, '').replace(/\b-?\s*SmartKnee\b/gi, '').trim();
    // Uppercase common terms
    name = name.toUpperCase()
      .replace(/\bTRA\b/g, 'Axial (TRA)')
      .replace(/\bSAG\b/g, 'Sagittal (SAG)')
      .replace(/\bCOR\b/g, 'Coronal (COR)');
    
    return `${name} [Series ${num}]`;
  }
  return dirName.replace(/_/g, ' ');
}

function generateIndex() {
  console.log('Generating scan index from:', SCANS_DIR);
  
  if (!fs.existsSync(SCANS_DIR)) {
    console.error('Scans directory does not exist:', SCANS_DIR);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify([], null, 2));
    return;
  }

  const scans = [];
  const scanDirs = fs.readdirSync(SCANS_DIR).filter(item => {
    return fs.statSync(path.join(SCANS_DIR, item)).isDirectory() && !item.startsWith('.');
  });

  for (const scanDir of scanDirs) {
    const scanPath = path.join(SCANS_DIR, scanDir);
    const scanObj = {
      id: scanDir,
      name: scanDir, // formatScanName(scanDir),
      series: []
    };

    const seriesDirs = fs.readdirSync(scanPath).filter(item => {
      return fs.statSync(path.join(scanPath, item)).isDirectory() && !item.startsWith('.');
    });

    // Sort series directories by their Series number if possible
    seriesDirs.sort((a, b) => {
      const aNum = parseInt(a.match(/^Series_(\d+)/)?.[1] || '0', 10);
      const bNum = parseInt(b.match(/^Series_(\d+)/)?.[1] || '0', 10);
      return aNum - bNum;
    });

    for (const seriesDir of seriesDirs) {
      const seriesPath = path.join(scanPath, seriesDir);
      const files = fs.readdirSync(seriesPath).filter(file => {
        return file.toLowerCase().endsWith('.dcm.enc') && !file.startsWith('.');
      });

      // Sort files numerically by their instance index
      files.sort((a, b) => {
        const aNum = parseInt(a.match(/Instance_(\d+)/)?.[1] || '0', 10);
        const bNum = parseInt(b.match(/Instance_(\d+)/)?.[1] || '0', 10);
        if (aNum !== bNum) return aNum - bNum;
        return a.localeCompare(b);
      });

      if (files.length > 0) {
        scanObj.series.push({
          id: seriesDir,
          name: seriesDir, // formatSeriesName(seriesDir),
          filesCount: files.length,
          files: files // Store list of files relative to the series directory
        });
      }
    }

    if (scanObj.series.length > 0) {
      scans.push(scanObj);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(scans, null, 2));
  console.log(`Successfully generated index with ${scans.length} scans at: ${OUTPUT_FILE}`);
}

generateIndex();
