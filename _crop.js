const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const SRC = process.env.CROP_SRC || 'C:/Users/kcq/.workbuddy/clipboard-images/clipboard-2026-11-24T13-44-08-558Z-57590130.jpg';
const OUT = 'D:/poro-build/crop';
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const html = `<!doctype html><html><body style="margin:0">
  <canvas id="cv"></canvas><script>
  const im = new Image();
  im.src = 'file:///${SRC}';
  window.ready = new Promise(r => im.onload = () => {
    const cv = document.getElementById('cv');
    cv.width = im.naturalWidth; cv.height = im.naturalHeight;
    cv.getContext('2d').drawImage(im, 0, 0);
    r({ w: im.naturalWidth, h: im.naturalHeight });
  });
  window.crop = (x, y, w, h, scale) => {
    const c2 = document.createElement('canvas');
    c2.width = Math.round(w * scale); c2.height = Math.round(h * scale);
    const g = c2.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(document.getElementById('cv'), x, y, w, h, 0, 0, c2.width, c2.height);
    return c2.toDataURL('image/png');
  };
  </script></body></html>`;
  const tmp = path.join(OUT, 'view.html');
  fs.writeFileSync(tmp, html);
  const win = new BrowserWindow({ width: 800, height: 600, show: false });
  await win.loadFile(tmp);
  const size = await win.webContents.executeJavaScript('window.ready');
  console.log('natural', JSON.stringify(size));
  const jobs = JSON.parse(process.argv[2] || '[]');
  for (const j of jobs) {
    const url = await win.webContents.executeJavaScript(
      `window.crop(${j.x},${j.y},${j.w},${j.h},${j.s || 2})`);
    fs.writeFileSync(path.join(OUT, j.name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
    console.log('wrote', j.name);
  }
  app.quit();
}).catch(e => { console.error('ERR', e && e.message); app.quit(); });
