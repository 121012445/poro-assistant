const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('./main/game-settings');

const mergedIni = settings.mergeIni('[A]\r\nx=9\r\ny=2\r\n[New]\r\nz=3\r\n', '[A]\r\nx=1\r\n');
assert.match(mergedIni, /\[A\][\s\S]*x=1/);
assert.match(mergedIni, /\[A\][\s\S]*y=2/);
assert.match(mergedIni, /\[New\][\s\S]*z=3/);

const persisted = value => JSON.stringify({ files: [{ name: 'Game.cfg', sections: [{ name: 'General', settings: value }] }] });
const mergedJson = JSON.parse(settings.mergePersisted(
  persisted([{ name: 'x', value: '9' }, { name: 'new', value: '2' }]),
  persisted([{ name: 'x', value: '1' }])
));
const mergedValues = mergedJson.files[0].sections[0].settings;
assert.strictEqual(mergedValues.find(item => item.name === 'x').value, '1');
assert.strictEqual(mergedValues.find(item => item.name === 'new').value, '2');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'poro-gs-test-'));
const configDir = path.join(tempRoot, 'Config');
const userData = path.join(tempRoot, 'UserData');
fs.mkdirSync(configDir);
fs.mkdirSync(userData);
fs.writeFileSync(path.join(configDir, 'game.cfg'), '[General]\r\nCameraMode=0\r\nGameMouseSpeed=10\r\n[Volume]\r\nMasterVolume=0.3800\r\n');
fs.writeFileSync(path.join(configDir, 'input.ini'), '[GameEvents]\r\nevtCameraSnap=[Space]\r\nevtCastAvatarSpell1=[d]\r\nevtCastAvatarSpell2=[f]\r\n');
fs.writeFileSync(path.join(configDir, 'PersistedSettings.json'), persisted([{ name: 'CameraMode', value: '0' }]));

try {
  const captured = settings.capture(configDir, userData);
  assert.strictEqual(captured.fileCount, 3);
  fs.chmodSync(path.join(configDir, 'game.cfg'), 0o666);
  fs.chmodSync(path.join(configDir, 'input.ini'), 0o666);
  fs.writeFileSync(path.join(configDir, 'game.cfg'), '[General]\r\nCameraMode=1\r\nGameMouseSpeed=9\r\nNewSetting=7\r\n[Volume]\r\nMasterVolume=0.4100\r\n');
  fs.writeFileSync(path.join(configDir, 'input.ini'), '[GameEvents]\r\nevtCameraSnap=[Space]\r\nevtCastAvatarSpell1=[x]\r\nevtCastAvatarSpell2=[c]\r\n');
  assert.ok(settings.verify(configDir, userData).mismatchCount >= 4);
  settings.apply(configDir, userData);
  const restored = fs.readFileSync(path.join(configDir, 'game.cfg'), 'utf8');
  assert.match(restored, /CameraMode=0/);
  assert.match(restored, /GameMouseSpeed=10/);
  assert.match(restored, /MasterVolume=0\.3800/);
  assert.match(restored, /NewSetting=7/);
  const restoredInput = fs.readFileSync(path.join(configDir, 'input.ini'), 'utf8');
  assert.match(restoredInput, /evtCastAvatarSpell1=\[d\]/);
  assert.match(restoredInput, /evtCastAvatarSpell2=\[f\]/);
  assert.strictEqual(settings.verify(configDir, userData).mismatchCount, 0);
  assert.ok(settings.status(userData).exists);
  assert.ok(fs.existsSync(path.join(userData, 'gs_full_backup.json')));
  settings.clear(userData);
  console.log('完整游戏设置测试通过');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
