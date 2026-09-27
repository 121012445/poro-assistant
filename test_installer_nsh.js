// 安装期自检脚本（build/installer.nsh）的守卫。
//
// 为什么需要它：这个脚本是"装完闪退"唯一能留下证据的地方 ——
// 程序本体 requireAdministrator，非管理员机器上双击会在 CreateProcess 阶段
// 直接失败（错误 740），应用自己的 crash.log 一个字节都写不出来。
// 它一旦被改坏，表现是**安装包照常构建成功、但那个关键日志不生成**，
// 而且要等到下一个用户来报"闪退"才会暴露。所以把踩过的坑全部钉死在这里。
//
// 断言跑在 src 还是 code 上，是有讲究的（2026-09-27 负向验证踩到的）：
//   · src  = 原文（含注释）
//   · code = 去掉整行注释后的代码
//   "不得出现 X" 必须跑在 code 上，否则会被注释里的反面教材绊倒（假阳性）；
//   "必须出现 X" **同样**必须跑在 code 上 —— 因为文件头注释里就写着
//   `正解：**"$SYSDIR\whoami.exe" 绝对路径**`、`S-1-5-32-544 与系统语言无关`
//   这类句子，跑在 src 上会让断言**永真**：把真实代码改成裸 whoami 也照样通过。
//   实测就是这么被坑的 —— 负向验证显示"拦住了"，其实是靠另一条断言拦的。
const fs = require('fs');
const assert = require('assert');

const NSH = 'build/installer.nsh';
assert(fs.existsSync(NSH), '缺少 ' + NSH + '（安装期自检脚本，装完闪退的唯一证据来源）');

const raw = fs.readFileSync(NSH);

// --- 编码：NSIS 读 include 需要 UTF-8 BOM，否则报 "Bad text encoding" 直接构建失败 ---
assert(raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF,
  NSH + ' 缺少 UTF-8 BOM —— NSIS 读 !include 会报 "Bad text encoding" 导致构建失败');

const src = raw.toString('utf8');

// NSIS 的注释以 ";" 开头。整行注释一律剥掉，后面的断言全部跑在 code 上。
const code = src.split(/\r?\n/)
  .filter(line => !/^\s*;/.test(line))
  .join('\n');

// 元自检：确认剥离真的生效了。否则下面每一条"必须出现"都可能被注释撑成永真，
// 而负向验证会误报"拦住了"（实际是另一条断言拦的，这条早已失效）。
assert(!code.includes('正解：') && !code.includes('踩过的坑'),
  'code 未剥离注释 —— 注释里的反面教材会把"必须出现"类断言撑成永真，必须先修这个');

// --- electron-builder 的挂载点 ---
assert(code.includes('!macro customInstall'), '缺少 customInstall 宏（electron-builder 不会调用到自检）');
assert(code.includes('!insertmacro poroInstallCheck'), 'customInstall 没有调用 poroInstallCheck');

// --- 管理员判定：必须是"账户是否在 Administrators 组"，不是"当前令牌是否提权" ---
assert(code.includes('S-1-5-32-544'),
  '缺少 BUILTIN\\Administrators 的 SID —— 判定账户所属组必须用 SID（与系统语言无关）');
assert(code.includes('$SYSDIR\\whoami.exe'),
  '必须用 $SYSDIR\\whoami.exe 绝对路径调 whoami —— 裸命令名依赖 PATH，实测安装器环境里会找不到');
assert(!/nsExec::ExecToStack\s+'whoami/.test(code) && !/'whoami \/groups'/.test(code),
  '不得用裸 whoami（依赖 PATH，实测报 "不是内部或外部命令"）');
assert(!/cmd\s*\/c[^\r\n]*\|/.test(code),
  '不得用 cmd /c 拼管道 —— cmd 的引号剥离会把管道吞成前一个程序的参数（实测踩到）');
assert(!/UserInfo::GetAccountType[\s\S]{0,400}?(StrCpy|If)[\s\S]{0,200}?(在管理员组|管理员)/.test(code),
  'UserInfo::GetAccountType 查的是过滤后的令牌，未提权的管理员会返回 User —— 不能用来判定所属组');

// --- 编码输出：FileWrite 会转成系统代码页（中文机器上实测 GBK），
//     那样英文系统上中文会全变 "?"，而我们要靠这些中文告诉用户换受限版 ---
assert(code.includes('FileWriteUTF16LE'),
  '日志必须用 FileWriteUTF16LE 写 —— FileWrite 会转成系统代码页，非中文系统上中文全变 "?"');
assert(code.includes('FileWriteByte $8 0xFF') && code.includes('FileWriteByte $8 0xFE'),
  'UTF-16LE 必须手写 BOM，否则记事本等工具识别不出编码');

// --- 静默升级不能被弹窗卡住 ---
assert(/IfSilent\s+[A-Za-z_]\w*/.test(code),
  'MessageBox 必须用 IfSilent 守卫 —— 否则静默升级时弹窗会卡住自动更新流程');

// --- 宏里的标签是全局的，手写循环会在宏被插入两次时报 label already declared ---
assert(!/^\s*poroFindLoop\s*:/m.test(code),
  '不要在宏里手写带标签的循环 —— NSIS 宏标签是全局的，插入两次会 label already declared（实测踩到）');

// --- 寄存器保护：customInstall 插在安装段末尾，之后安装段可能还在用通用寄存器，
//     所以宏必须"开头 push 全部通用寄存器、末尾严格逆序 pop"。
//     注意**不能**简单比较 Push 与 Pop 的总数：中间的 nsExec::ExecToStack /
//     UserInfo::* 也会 Pop 出返回值，那些 pop 不与开头的保护 push 配对
//     （实测总数是 Push=20 / Pop=26，一比就假报失败）。
//     这里直接验证"末尾 pop 序列 == 开头 push 序列的逆序"，这才是真正要保的性质。
const macroStart = code.indexOf('!macro poroInstallCheck');
const macroEnd = code.indexOf('!macroend', macroStart);
assert(macroStart !== -1 && macroEnd > macroStart, '找不到 poroInstallCheck 宏体');

const bodyLines = code.slice(macroStart, macroEnd)
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !line.startsWith(';') && !line.startsWith('!macro'));

const pushBlock = [];
for (const line of bodyLines) {
  const m = line.match(/^Push (\$[0-9A-Za-z]+)$/);
  if (!m) break;
  pushBlock.push(m[1]);
}

const popBlock = [];
for (let i = bodyLines.length - 1; i >= 0; i--) {
  const m = bodyLines[i].match(/^Pop (\$[0-9A-Za-z]+)$/);
  if (!m) break;
  popBlock.unshift(m[1]);   // unshift 保持"文件里从上到下"的真实顺序，报错时可读
}

assert(pushBlock.length >= 20,
  `宏开头必须连续 push 保护通用寄存器（实测只有 ${pushBlock.length} 个：${pushBlock.join(' ')}）`);
assert(popBlock.length === pushBlock.length
  && popBlock.every((reg, i) => reg === pushBlock[pushBlock.length - 1 - i]),
  '宏末尾必须**逆序** pop 还原寄存器（push 与 pop 不配对会让安装段后续指令的寄存器错乱）：\n'
  + `    开头 push = [${pushBlock.join(' ')}]\n    末尾 pop  = [${popBlock.join(' ')}]`);

// --- 挂载点：光有文件不算数，必须确认构建配置真的指向它 ---
// electron-builder 的 nsis.include **默认值**就是 "build/installer.nsh"，而且
// getResource() 找不到文件时返回 null → 静默跳过 include，构建照样成功。
// 也就是说：文件被改名/挪走/配置指向别处时，这个守卫的其它断言全部照常通过，
// 而用户机器上那份关键日志却不会生成 —— 正是"看着都对、实际没生效"。
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert(pkg.build.nsis.include === 'build/installer.nsh',
  'package.json 的 build.nsis.include 必须显式指向 build/installer.nsh'
  + `（实测是 ${JSON.stringify(pkg.build.nsis.include)}）—— 不能依赖默认值，`
  + '否则文件被挪走时构建会静默跳过自检');

const limited = require('./electron-builder.limited.js');
assert(limited.nsis && limited.nsis.include === 'build/installer.nsh',
  '受限版配置必须同样带上安装期自检 —— 受限版恰恰是发给"装完闪退"用户的那一个');

// --- 关键信息必须在日志里 ---
for (const field of ['在管理员组', 'UAC (EnableLUA)', 'crash.log 已存在', '结论:', '安装目录']) {
  assert(code.includes(field), '自检日志缺少字段: ' + field);
}

// --- 结论的"可执行指引"不能丢 ---
// 上面那批只检查字段**存在**，所以把结论简化成单一分支、或删掉那句"改用受限版"，
// 守卫全绿、构建也全绿 —— 而日志就退化成"记录了环境但没说怎么办"的报表，
// 这个功能的意义（让用户知道该换哪个包）正好没了。所以单独钉住。
assert(code.includes('$R7 == "是"') && code.includes('$R7 == "否"'),
  '结论必须区分「在管理员组 / 不在管理员组」两种情况，否则给不出该不该换受限版的指引');
assert(code.includes('改用受限版安装包'),
  '不在管理员组时，日志与弹框必须明确写出"改用受限版安装包" —— 这是该功能的全部意义');
assert(code.includes('MessageBox'),
  '不在管理员组时必须弹框告知 —— 用户不会主动去翻日志文件');

console.log('安装期自检守卫通过（BOM / 挂载点 / 配置指向 / SID 判定 / UTF-16LE / IfSilent / 寄存器保护 / 结论指引）');
