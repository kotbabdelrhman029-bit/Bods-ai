// bods AI — نسخة سطح المكتب (ويندوز / ماك / لينكس) بتحمّل نفس واجهة التطبيق
const { app, BrowserWindow, session, shell } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 780, minWidth: 380, minHeight: 560,
    backgroundColor: '#0b1020', title: 'bods AI', autoHideMenuBar: true,
    icon: path.join(__dirname, 'public/icon-512.png'),
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'public/index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  // الميكروفون والكاميرا والموقع والإشعارات بتتطلب من النظام بشكل طبيعي
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) =>
    cb(['media', 'geolocation', 'notifications', 'clipboard-sanitized-write', 'clipboard-read'].includes(perm)));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
