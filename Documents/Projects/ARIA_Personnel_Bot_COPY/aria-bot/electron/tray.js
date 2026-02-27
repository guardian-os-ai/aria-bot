/**
 * electron/tray.js — System tray icon and context menu
 */

const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let tray = null;

function createTray(toggleWindow) {
  // Create a simple tray icon — use the assets/tray.png placeholder
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');

  // Create a fallback icon if the file doesn't exist
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      // Create a simple 16x16 icon programmatically
      icon = createFallbackIcon();
    }
  } catch (err) {
    icon = createFallbackIcon();
  }

  tray = new Tray(icon);
  tray.setToolTip('ARIA — Personal Bot');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide ARIA',
      click: () => toggleWindow()
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        toggleWindow();
        // Could send IPC to switch to settings panel
      }
    },
    { type: 'separator' },
    {
      label: 'Quit ARIA',
      click: () => {
        const { app } = require('electron');
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Click tray icon to toggle window
  tray.on('click', () => {
    toggleWindow();
  });

  return tray;
}

/**
 * Create a simple 16x16 blue circle icon as fallback
 */
function createFallbackIcon() {
  // Create a 16x16 icon from a data URL (blue circle on transparent bg)
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4); // RGBA

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2;
      const dy = y - size / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;

      if (dist < size / 2 - 1) {
        // Blue circle: #4f9cf9
        canvas[idx] = 0x4f;     // R
        canvas[idx + 1] = 0x9c; // G
        canvas[idx + 2] = 0xf9; // B
        canvas[idx + 3] = 255;  // A
      } else {
        canvas[idx + 3] = 0; // Transparent
      }
    }
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

module.exports = { createTray };
