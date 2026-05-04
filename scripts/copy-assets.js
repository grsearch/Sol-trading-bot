#!/usr/bin/env node
/**
 * 构建后处理: 复制静态资源到 dist/
 * 
 * TypeScript 的 tsc 只处理 .ts 文件,不会复制 HTML/CSS/图片等静态资源。
 * 这个脚本在 build 之后运行,把这些资源同步到 dist/ 对应位置。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 需要复制的资源映射
// [源路径相对ROOT, 目标路径相对ROOT]
const ASSETS_TO_COPY = [
  // Dashboard 前端文件
  ['src/dashboard/public', 'dist/dashboard/public'],
];

function copyDirectory(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`⚠️  Source not found, skipping: ${src}`);
    return 0;
  }
  
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  let count = 0;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      count += copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  
  return count;
}

console.log('📦 Copying static assets to dist/...');

let totalCopied = 0;
for (const [src, dest] of ASSETS_TO_COPY) {
  const srcAbs = path.join(ROOT, src);
  const destAbs = path.join(ROOT, dest);
  const count = copyDirectory(srcAbs, destAbs);
  console.log(`   ${src} → ${dest} (${count} files)`);
  totalCopied += count;
}

console.log(`✅ Copied ${totalCopied} files`);
