'use strict';
// main/tts-edge.js + main/tts.js: 神经语音通道的连接签名、SSML、帧解析、
// 音色白名单, 以及 tts.js 的参数归一化与降级顺序。
// 不发真实网络请求 —— 实网的可用性由人工试听确认, 这里只锁住"能构造出
// 服务端会接受的请求"和"参数错的时候不会发出奇怪的东西"。
const assert = require('assert');
const fs = require('fs');
const edge = require('./main/tts-edge');
const tts = require('./main/tts');

(async () => {
  // ---- 连接签名 ----
  // 服务端按 5 分钟窗口校验: 窗口内必须稳定 (重连不能变), 跨窗口必须变
  const t0 = Date.UTC(2026, 10, 5, 8, 0, 5);
  const sig = edge.secMsGec(t0);
  assert.ok(/^[0-9A-F]{64}$/.test(sig), '签名应是 64 位大写十六进制');
  assert.strictEqual(edge.secMsGec(t0 + 60 * 1000), sig, '同一 5 分钟窗口内签名必须不变');
  assert.notStrictEqual(edge.secMsGec(t0 + 6 * 60 * 1000), sig, '跨窗口签名必须变化');
  assert.notStrictEqual(edge.secMsGec(t0 + 5 * 60 * 1000), sig, '跨到下一个窗口边界必须变化');

  // ---- 连接 URL ----
  // 少任何一个参数都是 403, 所以逐个确认在
  const url = edge.buildUrl('ABCDEF0123456789', t0);
  assert.ok(url.startsWith('wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?'), '应用新版 wss 端点');
  assert.ok(url.includes('Ocp-Apim-Subscription-Key=6A5AA1D4EAFF4E9FB37E23D68491D6F4'), 'token 走 Ocp-Apim-Subscription-Key');
  assert.ok(url.includes('Sec-MS-GEC=' + sig), 'URL 里的签名应与 secMsGec 一致');
  assert.ok(/Sec-MS-GEC-Version=1-\d+\.\d+\.\d+\.\d+/.test(url), 'Sec-MS-GEC-Version 必须是 1-x.y.z.w');
  assert.ok(url.includes('ConnectionId=ABCDEF0123456789'), '必须带 ConnectionId');
  // 版本号三处必须同源, 否则服务端按 UA 判定直接拒。UA 用 155.0.0.0 这种
  // 补零形式, Sec-MS-GEC-Version 用完整版本, 服务端只看大版本, 所以比主版本号。
  const src = fs.readFileSync('main/tts-edge.js', 'utf8');
  const uaVer = /Chrome\/(\d+)\./.exec(src);
  const gecVer = /CHROMIUM_VERSION = '(\d+)\./.exec(src);
  assert.ok(uaVer && gecVer && uaVer[1] === gecVer[1],
    'UA 里的 Chrome 大版本必须与 CHROMIUM_VERSION 一致: ' + (uaVer && uaVer[1]) + ' vs ' + (gecVer && gecVer[1]));

  // ---- SSML ----
  const ssml = edge.buildSsml('10 < 20 & "引号"', 'zh-CN-YunxiNeural', 8, -2);
  assert.ok(ssml.includes('<voice name="zh-CN-YunxiNeural">'), 'SSML 应带上选定音色');
  assert.ok(ssml.includes('rate="+8%"'), '正速率应带 + 号');
  assert.ok(ssml.includes('pitch="-2Hz"'), '负音调应为 -NHz');
  assert.ok(ssml.includes('&lt;') && ssml.includes('&amp;'), '文本必须 XML 转义');
  assert.ok(!ssml.includes('< 20'), '未转义的 < 会让整条请求变成非法 XML');
  assert.ok(edge.buildSsml('x', 'zh-CN-XiaoxiaoNeural', 0, 0).includes('rate="+0%"'), '0 速率也要带符号');

  // ---- 音色白名单 ----
  // 服务端会拒绝未开通的音色 (实测 zh-CN-XiaochenNeural 返回 Unsupported voice),
  // 这类值必须回退到默认, 不能把用户设置里的野值直接发出去
  assert.strictEqual(edge.pickVoice('zh-CN-XiaochenNeural'), edge.DEFAULT_VOICE, '服务端不认的音色应回退默认');
  assert.strictEqual(edge.pickVoice(''), edge.DEFAULT_VOICE, '空音色应回退默认');
  assert.strictEqual(edge.pickVoice('zh-CN-YunyangNeural'), 'zh-CN-YunyangNeural', '白名单内音色应原样保留');
  for (const v of edge.voiceList()) {
    assert.ok(/^zh-CN-[A-Za-z]+Neural$/.test(v.id), '音色 id 格式应为 zh-CN-XxxNeural: ' + v.id);
    assert.ok(v.label && v.desc, '音色要有可读的标签与说明: ' + v.id);
  }
  assert.ok(edge.voiceList().length >= 4, '至少提供 4 档音色供选择');
  assert.ok(edge.voiceList().some(v => /男声/.test(v.label)), '应提供男声供不喜欢女声的人选');

  // ---- 参数收敛 ----
  assert.strictEqual(edge.normalizeRate(99), 30, '速率上限 +30%');
  assert.strictEqual(edge.normalizeRate(-99), -30, '速率下限 -30%');
  assert.strictEqual(edge.normalizeRate('+12%'), 12, '应能解析带 % 与 + 的字符串');
  assert.strictEqual(edge.normalizeRate(undefined), 0, '缺省速率应为 0');
  assert.strictEqual(edge.normalizePitch(50), 20, '音调上限 +20Hz');
  assert.strictEqual(edge.normalizePitch(-50), -20, '音调下限 -20Hz');

  // ---- 协议帧 ----
  // 二进制帧: 2 字节大端头长 + 头部文本 + 音频
  const head = Buffer.from('X-RequestId:abc\r\nPath:audio\r\n', 'utf8');
  const payload = Buffer.from([0xFF, 0xF3, 0x64, 0x00]);
  const frame = Buffer.concat([Buffer.from([head.length >> 8, head.length & 0xFF]), head, payload]);
  const audioFrame = edge.parseBinaryFrame(frame);
  assert.strictEqual(audioFrame.path, 'audio', '应识别 audio 帧');
  assert.deepStrictEqual([...audioFrame.audio], [0xFF, 0xF3, 0x64, 0x00], '应剥离头部只留音频');
  assert.strictEqual(edge.parseBinaryFrame(Buffer.from([0x00])).audio.length, 0, '短帧不应抛异常');
  assert.strictEqual(edge.parseBinaryFrame(Buffer.alloc(0)).path, '', '空帧不应抛异常');
  // 头长比缓冲还大 (被截断的帧): 不能让 readUInt16BE 之后的 slice 越界
  assert.strictEqual(edge.parseBinaryFrame(Buffer.from([0xFF, 0xFF])).audio.length, 0, '头长越界应返回空音频');

  const endFrame = edge.parseTextFrame('X-RequestId:abc\r\nPath:turn.end\r\n\r\n');
  assert.strictEqual(endFrame.path, 'turn.end', '应识别 turn.end 结束帧');
  assert.strictEqual(edge.parseTextFrame('Path:response\r\n\r\n{"x":1}').body, '{"x":1}', '应保留文本帧 body');

  // ---- tts.js 参数归一化 ----
  const o1 = tts.normalizeOptions({ voice: 'zh-CN-XiaoyiNeural', rate: 10, pitch: -3 });
  assert.strictEqual(o1.voice, 'zh-CN-XiaoyiNeural');
  assert.strictEqual(o1.rate, 10);
  assert.strictEqual(o1.pitch, -3);
  // 旧式调用 (只传 speed 数字) 仍要能用, 否则老调用点会静默失效
  const o2 = tts.normalizeOptions(6);
  assert.strictEqual(o2.rate, 12, '旧式 speed 6 应映射成 +12%');
  assert.strictEqual(o2.voice, edge.DEFAULT_VOICE, '旧式调用应用默认音色');
  assert.strictEqual(tts.normalizeOptions(undefined).rate, 0, '缺省 speed 5 应映射成 0%');
  assert.strictEqual(tts.normalizeOptions({ voice: 'zh-CN-XiaochenNeural' }).voice, edge.DEFAULT_VOICE,
    '不支持的音色在归一化阶段就该被换掉');

  // ---- 空输入不打网络 ----
  const r1 = await tts.synthesize('   ', { voice: 'zh-CN-XiaoxiaoNeural' });
  assert.strictEqual(r1.ok, false, '空文本应直接失败');
  const r2 = await tts.synthesize(null, 5);
  assert.strictEqual(r2.ok, false, 'null 文本应直接失败');

  // ---- 状态 ----
  const st = tts.status();
  assert.ok(typeof st.available === 'boolean', 'status 应报告通道可用性');
  assert.ok(typeof st.cooldownLeftMs === 'number', 'status 应报告冷却剩余');

  // ---- 接线: 渲染层要真的用上神经通道 ----
  const tips = fs.readFileSync('renderer/js/live-tips.js', 'utf8');
  assert.ok(tips.includes('commentaryOnlineOpts'), '合成调用应传音色参数');
  assert.ok(/commentaryOnlineOpts\(job\.reset\)/.test(tips), '换音色后应能清掉失败冷却');
  assert.ok(tips.includes('res.source === \'edge\''), '应按音源决定播放端处理强度');
  assert.ok(tips.includes('CMT_NEURAL_STYLE'), '神经语音应有独立的轻处理档');
  assert.ok(!/commentaryOnlineSpeed/.test(tips), '旧的单一语速档位应已移除');
  const pre = fs.readFileSync('main/preload.js', 'utf8');
  assert.ok(pre.includes("ipcRenderer.invoke('tts:voices')"), 'preload 应暴露音色表');
  const mainSrc = fs.readFileSync('main/index.js', 'utf8');
  assert.ok(mainSrc.includes("ipcMain.handle('tts:voices'"), '主进程应提供音色表 IPC');
  assert.ok(mainSrc.includes('ttsService.resetCooldown()'), '换音色应能重置神经通道冷却');
  const html = fs.readFileSync('renderer/index.html', 'utf8');
  assert.ok(html.includes('语音: 神经语音'), '设置页应标明神经语音');
  assert.ok(html.includes('语气: 柔和'), '风格下拉应改称"语气"以免与音色混淆');

  console.log('语音通道测试通过 (签名 / URL / SSML 转义 / 帧解析 / 音色白名单 / 参数归一化 / 接线)');
})().catch(e => { console.error(e); process.exitCode = 1; });
