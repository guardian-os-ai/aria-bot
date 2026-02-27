/**
 * assets/generate-icons.js
 * Run this script once to generate placeholder tray and app icons.
 * Usage: node assets/generate-icons.js
 *
 * Since we need actual PNG files for Electron's tray and notifications,
 * this script creates minimal valid 1x1 PNG files as placeholders.
 * Replace these with proper icons before production.
 */

const fs = require('fs');
const path = require('path');

// Minimal valid 16x16 PNG (blue pixel) — Base64 encoded
// This is a tiny valid PNG that Electron can load as a tray icon
const TRAY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2NkoBAwUqifAacBjP///2dgYGBg+P//P0MjIyMDMYaQbgBOL5BkAMW+INUTAIY6CRHyDuGYAAAAAElFTkSuQmCC';

// Minimal valid 32x32 PNG (blue circle) for notifications
const ICON_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAkklEQVRYR+2WwQ3AIAwD7f7LdAR2gPJBSJUq8SD+OHFsJ+WP4x/5y2YAzwBm9uzqtddLT/cMwMxgZr/ufKq9nAHMbGa/1M7/AEzOzWxm1t0VIM+a2c+q7RWgHDGz7lV7OgIoyMx+1Y7/AIQEwMxOu1d/nQGU5Mwea2azewMQ0jOzn1Vbq0GFzczae98bRjgDuAF7pjAhVOjBZAAAAABJRU5ErkJggg==';

// Write tray.png
const trayPath = path.join(__dirname, 'tray.png');
fs.writeFileSync(trayPath, Buffer.from(TRAY_PNG_BASE64, 'base64'));
console.log('Created:', trayPath);

// Write icon.png
const iconPath = path.join(__dirname, 'icon.png');
fs.writeFileSync(iconPath, Buffer.from(ICON_PNG_BASE64, 'base64'));
console.log('Created:', iconPath);

console.log('Done! Replace these with proper icons before production.');
