#!/usr/bin/env node
/**
 * Image File Watcher
 * Monitors static/ and assets/ directories for new/modified images
 * Alerts if images exceed size limits
 */

const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

const MAX_SIZE_KB = 500;
const WARN_SIZE_KB = 300;
const WATCH_DIRS = ['static', 'assets'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function formatBytes(bytes) {
  const kb = Math.round(bytes / 1024);
  if (kb < 1024) {
    return `${kb}KB`;
  }
  const mb = (bytes / (1024 * 1024)).toFixed(2);
  return `${mb}MB`;
}

function checkImageSize(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (!IMAGE_EXTENSIONS.includes(ext)) {
    return;
  }

  if (!fs.existsSync(filePath)) {
    return;
  }

  const stats = fs.statSync(filePath);
  const sizeKB = Math.round(stats.size / 1024);
  const fileName = path.relative(process.cwd(), filePath);

  if (sizeKB > MAX_SIZE_KB) {
    console.log('');
    console.log(`${colors.red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.red}⚠️  IMAGE SIZE VIOLATION${colors.reset}`);
    console.log(`${colors.red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`File: ${colors.cyan}${fileName}${colors.reset}`);
    console.log(`Size: ${colors.red}${formatBytes(stats.size)} (${sizeKB}KB)${colors.reset}`);
    console.log(`Limit: ${MAX_SIZE_KB}KB`);
    console.log('');
    console.log(`${colors.yellow}To fix:${colors.reset}`);
    console.log(`  npm run compress-images`);
    console.log(`  or manually optimize ${fileName}`);
    console.log(`${colors.red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log('');
  } else if (sizeKB > WARN_SIZE_KB) {
    console.log(`${colors.yellow}⚠️  ${fileName} (${formatBytes(stats.size)}) - approaching limit${colors.reset}`);
  } else {
    console.log(`${colors.green}✅ ${fileName} (${formatBytes(stats.size)})${colors.reset}`);
  }
}

console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
console.log(`${colors.blue}👁️  IMAGE FILE WATCHER${colors.reset}`);
console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
console.log(`Watching: ${WATCH_DIRS.join(', ')}`);
console.log(`Max size: ${MAX_SIZE_KB}KB`);
console.log(`Warning threshold: ${WARN_SIZE_KB}KB`);
console.log('');
console.log('Press Ctrl+C to stop');
console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
console.log('');

// Initialize watcher
const watcher = chokidar.watch(WATCH_DIRS, {
  ignored: /(^|[\/\\])\../, // ignore dotfiles
  persistent: true,
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 500,
    pollInterval: 100
  }
});

// Event handlers
watcher
  .on('add', filePath => {
    checkImageSize(filePath);
  })
  .on('change', filePath => {
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTENSIONS.includes(ext)) {
      console.log(`${colors.cyan}📝 Modified: ${path.relative(process.cwd(), filePath)}${colors.reset}`);
      checkImageSize(filePath);
    }
  })
  .on('unlink', filePath => {
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTENSIONS.includes(ext)) {
      console.log(`${colors.yellow}🗑️  Removed: ${path.relative(process.cwd(), filePath)}${colors.reset}`);
    }
  })
  .on('error', error => {
    console.error(`${colors.red}Watcher error: ${error}${colors.reset}`);
  })
  .on('ready', () => {
    console.log(`${colors.green}✅ Initial scan complete - monitoring for changes...${colors.reset}`);
    console.log('');
  });

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('');
  console.log(`${colors.blue}Stopping image watcher...${colors.reset}`);
  watcher.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  watcher.close();
  process.exit(0);
});
