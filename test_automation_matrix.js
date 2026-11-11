'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('renderer/js/automation-matrix.js', 'utf8');
const saved = { autoBPToggle: { rift: true, aram: false, fun: true, training: false } };
const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem: () => {} },
  storeGet: key => key === 'automationModeMatrix' ? JSON.stringify(saved) : null,
  storeSet: () => {},
  document: { getElementById: () => null },
  window: { addEventListener: () => {} }
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'automation-matrix.js' });
sandbox.window.reloadAutomationModeMatrix();

sandbox.window.updateAutomationModeContext(420, 'CLASSIC');
assert.equal(sandbox.window.getAutomationModeContext().key, 'rift');
assert.equal(sandbox.window.automationModeAllows('autoBPToggle'), true);
sandbox.window.updateAutomationModeContext(450, 'ARAM');
assert.equal(sandbox.window.getAutomationModeContext().key, 'aram');
assert.equal(sandbox.window.automationModeAllows('autoBPToggle'), false);
sandbox.window.updateAutomationModeContext(2400, 'KIWI_JADE');
assert.equal(sandbox.window.getAutomationModeContext().key, 'aram');
sandbox.window.updateAutomationModeContext(1090, 'PRACTICETOOL');
assert.equal(sandbox.window.getAutomationModeContext().key, 'training');
assert.equal(sandbox.window.automationModeAllows('autoBPToggle'), false);

for (const file of ['autobp.js', 'settings.js', 'pick-guard.js', 'autoflow.js', 'autoreturn.js', 'compliance.js']) {
  const text = fs.readFileSync('renderer/js/' + file, 'utf8');
  assert.ok(text.includes('automationModeAllows'), file + ' 应接入统一模式门禁');
}

console.log('自动化模式矩阵测试通过');
