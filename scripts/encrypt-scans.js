import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const RAW_DIR = path.join(process.cwd(), 'raw_scans');
const PUBLIC_DIR = path.join(process.cwd(), 'public', 'scans');

// Default fallback passcode for development (user should set SCAN_PASSWORD env var for production)
const password = process.env.SCAN_PASSWORD || 'secure-scan-2026';

if (!process.env.SCAN_PASSWORD) {
  console.warn('\x1b[33m%s\x1b[0m', 'WARNING: SCAN_PASSWORD environment variable is not set.');
  console.warn('\x1b[33m%s\x1b[0m', 'Using default passcode: "secure-scan-2026".');
  console.warn('\x1b[33m%s\x1b[0m', 'To secure your production build, run: export SCAN_PASSWORD="your-strong-password" && npm run build\n');
}

// Key Derivation Parameters (must match browser decrypt settings)
const ITERATIONS = 100000;
const KEY_LENGTH = 32; // 256 bits for AES-GCM
const DIGEST = 'sha256';

// Derive key using PBKDF2 sync (Node side is fast enough)
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
}

// Encrypt single file using AES-256-GCM
function encryptFile(inputPath, outputPath) {
  const fileData = fs.readFileSync(inputPath);
  
  // Generate random salt (16 bytes) and IV (12 bytes for GCM)
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  const ciphertext = Buffer.concat([cipher.update(fileData), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes auth tag
  
  // Package output format: [Salt (16 bytes)][IV (12 bytes)][Ciphertext][Tag (16 bytes)]
  // Web Crypto API expects the GCM Tag appended to the ciphertext
  const encryptedPayload = Buffer.concat([salt, iv, ciphertext, tag]);
  
  fs.writeFileSync(outputPath, encryptedPayload);
}

// Traverse and encrypt raw scans recursively
function encryptDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    console.error(`Source directory does not exist: ${sourceDir}`);
    return;
  }
  
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const items = fs.readdirSync(sourceDir);
  
  for (const item of items) {
    if (item.startsWith('.')) continue; // Skip hidden files/folders
    
    const srcPath = path.join(sourceDir, item);
    const stat = fs.statSync(srcPath);
    
    if (stat.isDirectory()) {
      encryptDirectory(srcPath, path.join(targetDir, item));
    } else if (stat.isFile() && item.toLowerCase().endsWith('.dcm')) {
      const destPath = path.join(targetDir, item + '.enc');
      encryptFile(srcPath, destPath);
    }
  }
}

console.log('--- Scan Encryption Script ---');
console.log(`Source: ${RAW_DIR}`);
console.log(`Target: ${PUBLIC_DIR}`);
console.log('Encrypting files...');

const startTime = Date.now();
encryptDirectory(RAW_DIR, PUBLIC_DIR);
const duration = ((Date.now() - startTime) / 1000).toFixed(2);

console.log(`\nEncryption completed in ${duration}s!`);
console.log(`Encrypted assets written to public/scans/`);
