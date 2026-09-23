const fs = require('fs');
const path = require('path');

const GAME_SETTING_FILES = ['game.cfg', 'input.ini', 'PersistedSettings.json'];
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

function snapshotPath(userData) { return path.join(userData, 'gs_full_lock.json'); }
function backupPath(userData) { return path.join(userData, 'gs_full_backup.json'); }

function setFilesReadOnly(configDir, readOnly) {
  for (const name of GAME_SETTING_FILES) {
    const target = path.join(configDir, name);
    if (!fs.existsSync(target)) continue;
    // Windows 会把写权限映射成只读属性。锁定期间禁止游戏进程把云端/本局改动
    // 覆盖回磁盘；Poro 自己恢复前会临时解除只读，写完再重新锁上。
    fs.chmodSync(target, readOnly ? 0o444 : 0o666);
  }
}

function readConfigFiles(configDir) {
  const files = {};
  for (const name of GAME_SETTING_FILES) {
    const target = path.join(configDir, name);
    if (!fs.existsSync(target)) throw new Error(`未找到 ${name}`);
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error(`${name} 无效或过大`);
    files[name] = fs.readFileSync(target, 'utf8');
  }
  return files;
}

function atomicWrite(filePath, content) {
  const temp = filePath + '.poro-tmp';
  if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o666);
  fs.writeFileSync(temp, content, 'utf8');
  fs.copyFileSync(temp, filePath);
  fs.unlinkSync(temp);
  const now = new Date();
  fs.utimesSync(filePath, now, now);
}

function parseIni(text) {
  const order = [];
  const sections = new Map();
  let current = '';
  const ensure = name => {
    if (!sections.has(name)) { sections.set(name, new Map()); order.push(name); }
    return sections.get(name);
  };
  ensure(current);
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const section = raw.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) { current = section[1]; ensure(current); continue; }
    const setting = raw.match(/^\s*([^;#][^=]*?)\s*=\s*(.*)$/);
    if (setting) ensure(current).set(setting[1].trim(), setting[2]);
  }
  return { order, sections };
}

function mergeIni(currentText, savedText) {
  const saved = parseIni(savedText);
  const current = parseIni(currentText);
  for (const section of current.order) {
    if (!saved.sections.has(section)) {
      saved.sections.set(section, new Map());
      saved.order.push(section);
    }
    const target = saved.sections.get(section);
    for (const [key, value] of current.sections.get(section)) {
      if (!target.has(key)) target.set(key, value);
    }
  }
  const lines = [];
  for (const section of saved.order) {
    const values = saved.sections.get(section);
    if (!values.size) continue;
    if (section) lines.push(`[${section}]`);
    for (const [key, value] of values) lines.push(`${key}=${value}`);
    lines.push('');
  }
  return lines.join('\r\n');
}

function mergePersisted(currentText, savedText) {
  const current = JSON.parse(currentText);
  const saved = JSON.parse(savedText);
  if (!Array.isArray(current.files) || !Array.isArray(saved.files)) throw new Error('PersistedSettings.json 结构无效');
  for (const savedFile of saved.files) {
    let currentFile = current.files.find(file => file.name === savedFile.name);
    if (!currentFile) {
      current.files.push(savedFile);
      continue;
    }
    if (!Array.isArray(currentFile.sections)) currentFile.sections = [];
    for (const savedSection of savedFile.sections || []) {
      let currentSection = currentFile.sections.find(section => section.name === savedSection.name);
      if (!currentSection) {
        currentFile.sections.push(savedSection);
        continue;
      }
      if (!Array.isArray(currentSection.settings)) currentSection.settings = [];
      for (const savedSetting of savedSection.settings || []) {
        const currentSetting = currentSection.settings.find(setting => setting.name === savedSetting.name);
        if (currentSetting) currentSetting.value = savedSetting.value;
        else currentSection.settings.push(savedSetting);
      }
    }
  }
  return JSON.stringify(current, null, 4) + '\n';
}

function countSettings(files) {
  let count = 0;
  for (const name of ['game.cfg', 'input.ini']) {
    for (const values of parseIni(files[name]).sections.values()) count += values.size;
  }
  const persisted = JSON.parse(files['PersistedSettings.json']);
  for (const file of persisted.files || []) for (const section of file.sections || []) count += (section.settings || []).length;
  return count;
}

function diffSettings(current, saved) {
  const mismatches = [];
  for (const name of ['game.cfg', 'input.ini']) {
    const currentIni = parseIni(current[name]);
    const savedIni = parseIni(saved[name]);
    for (const [section, values] of savedIni.sections) {
      const currentValues = currentIni.sections.get(section) || new Map();
      for (const [key, value] of values) {
        if (currentValues.get(key) !== value) mismatches.push(`${name}:${section}.${key}`);
      }
    }
  }
  const currentJson = JSON.parse(current['PersistedSettings.json']);
  const savedJson = JSON.parse(saved['PersistedSettings.json']);
  for (const savedFile of savedJson.files || []) {
    const currentFile = (currentJson.files || []).find(file => file.name === savedFile.name);
    for (const savedSection of savedFile.sections || []) {
      const currentSection = (currentFile?.sections || []).find(section => section.name === savedSection.name);
      for (const savedSetting of savedSection.settings || []) {
        const currentSetting = (currentSection?.settings || []).find(setting => setting.name === savedSetting.name);
        if (!currentSetting || String(currentSetting.value) !== String(savedSetting.value)) {
          mismatches.push(`PersistedSettings.json:${savedFile.name}.${savedSection.name}.${savedSetting.name}`);
        }
      }
    }
  }
  return mismatches;
}

function capture(configDir, userData) {
  const files = readConfigFiles(configDir);
  const snapshot = { version: 1, capturedAt: new Date().toISOString(), configDir, files };
  atomicWrite(snapshotPath(userData), JSON.stringify(snapshot));
  setFilesReadOnly(configDir, true);
  return { ok: true, fileCount: GAME_SETTING_FILES.length, settingCount: countSettings(files), configDir };
}

function loadSnapshot(userData) {
  const target = snapshotPath(userData);
  if (!fs.existsSync(target)) return null;
  const snapshot = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (!snapshot || snapshot.version !== 1 || !snapshot.files) throw new Error('完整设置快照无效');
  return snapshot;
}

function apply(configDir, userData) {
  const snapshot = loadSnapshot(userData);
  if (!snapshot) throw new Error('没有完整设置快照，请关闭后重新开启锁定');
  setFilesReadOnly(configDir, false);
  const current = readConfigFiles(configDir);
  const backupFile = backupPath(userData);
  let needsBackup = true;
  try {
    const old = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    needsBackup = old.forSnapshot === snapshot.capturedAt ? false : true;
  } catch (e) {}
  if (needsBackup) atomicWrite(backupFile, JSON.stringify({ version: 1, forSnapshot: snapshot.capturedAt, capturedAt: new Date().toISOString(), configDir, files: current }));

  const merged = {
    'game.cfg': mergeIni(current['game.cfg'], snapshot.files['game.cfg']),
    'input.ini': mergeIni(current['input.ini'], snapshot.files['input.ini']),
    'PersistedSettings.json': mergePersisted(current['PersistedSettings.json'], snapshot.files['PersistedSettings.json'])
  };
  const written = [];
  try {
    for (const name of GAME_SETTING_FILES) {
      atomicWrite(path.join(configDir, name), merged[name]);
      written.push(name);
    }
  } catch (error) {
    for (const name of written) {
      try { atomicWrite(path.join(configDir, name), current[name]); } catch (e) {}
    }
    throw error;
  } finally {
    setFilesReadOnly(configDir, true);
  }
  const verification = verify(configDir, userData);
  return { ok: true, fileCount: GAME_SETTING_FILES.length, settingCount: countSettings(snapshot.files), configDir, mismatchCount: verification.mismatchCount };
}

function verify(configDir, userData) {
  const snapshot = loadSnapshot(userData);
  if (!snapshot) return { ok: false, exists: false, mismatchCount: 0, error: '没有完整设置快照' };
  const mismatches = diffSettings(readConfigFiles(configDir), snapshot.files);
  return { ok: mismatches.length === 0, exists: true, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 30), configDir };
}

function status(userData) {
  try {
    const snapshot = loadSnapshot(userData);
    return snapshot ? { ok: true, exists: true, fileCount: GAME_SETTING_FILES.length, settingCount: countSettings(snapshot.files), configDir: snapshot.configDir } : { ok: true, exists: false };
  } catch (error) { return { ok: false, exists: false, error: error.message }; }
}

function clear(userData) {
  try {
    const snapshot = loadSnapshot(userData);
    if (snapshot?.configDir) setFilesReadOnly(snapshot.configDir, false);
  } catch (error) { /* 损坏的旧快照不能阻止用户解除锁定 */ }
  try { fs.unlinkSync(snapshotPath(userData)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ok: true };
}

module.exports = { capture, apply, verify, status, clear, mergeIni, mergePersisted, parseIni, diffSettings };
