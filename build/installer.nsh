; ===========================================================================
; Poro 安装期自检 —— 写一份"无论程序能不能启动、都一定会存在"的日志
; ===========================================================================
;
; 为什么需要它
; ------------
; 程序本体 Poro.exe 的 manifest 是 requireAdministrator。在下面这些机器上，
; 双击快捷方式会在 CreateProcess 阶段**直接失败**（Windows 错误 740
; ERROR_ELEVATION_REQUIRED）：
;     · 非管理员账户           · UAC 弹框被点"否"
;     · EnableLUA=0（UAC 关闭） · 组策略禁止提权
;
;   这时**进程根本没被创建**，所以应用自己的
;   %APPDATA%\poro-assistant\crash.log 一个字节都不会写 ——
;   用户看到的只是"点开闪一下没了"，我们手上没有任何数据。
;
; 而安装器自身是 asInvoker：**用户能把 Poro 装完，就证明它跑起来了**。
; 所以这里是"装完闪退"这类问题唯一能留下证据的地方。
;
; 产物
; ----
; %APPDATA%\poro-assistant\install-check.log
; 与应用 crash.log 同一个目录 —— 出问题时让用户把整个 poro-assistant
; 文件夹发回来就够了。
;
; 三个踩过的坑（都实测过，别改回去）
; ----------------------------------
; 1) 判定"是否在管理员组"**不能用** UserInfo::GetAccountType —— 它查的是
;    **当前过滤后的令牌**，未提权的管理员会返回 "User"。实测本机
;    kcq 明明在 Administrators 组里，它照样返回 User。
; 2) 也不能直接调 `whoami`（裸命令名）—— 依赖 PATH。安装器的环境不一定
;    带 System32，实测报 "'whoami' 不是内部或外部命令"。
;    正解：**"$SYSDIR\whoami.exe" 绝对路径**。
; 3) 也不要写成 `cmd /c "a.exe" x | "b.exe" y` —— cmd 的引号剥离规则会把
;    管道整个吞成前一个程序的参数（实测 whoami 收到 "/groups | ...findstr..."）。
;    正解：whoami 的输出**先落临时文件**，再让 findstr 读文件；全程不经 cmd，
;    引号只有一层，CreateProcess 能正确解析。
;    注意也别在宏里手写循环做子串搜索 —— NSIS 宏的标签是**全局的**，
;    同一个宏被插入两次就会 "label already declared"（实测踩到）。
;
; 为什么搜 SID 而不是搜中文组名：S-1-5-32-544 与系统语言无关。
;
; 编码：日志用 UTF-16LE + BOM 写。NSIS 的 FileWrite 会转成**系统代码页**
; （中文机器上实测是 GBK），那样在英文系统的机器上中文会全变成 "?"，
; 而我们恰恰要靠这些中文告诉用户"该换受限版"。
; ===========================================================================

!include "FileFunc.nsh"     ; ${GetTime}
!include "LogicLib.nsh"     ; ${If}

!ifndef PORO_CHECK_LOG
  !define PORO_CHECK_LOG "$APPDATA\poro-assistant\install-check.log"
!endif

!macro poroInstallCheck
  ; customInstall 插在安装段末尾，之后安装段可能还在用通用寄存器。
  ; 全部先 push、末尾逆序 pop，避免把 electron-builder 模板的状态踩坏。
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  ; 不设的话读 HKLM\SOFTWARE 会被重定向到 WOW6432Node，ProductName 可能读不到
  SetRegView 64

  ; ---- 账户是否在管理员组 ----
  ; 用 $SYSDIR 绝对路径，不依赖 PATH（见文件头坑 2）
  StrCpy $R7 "?"              ; 默认"无法判定"
  nsExec::ExecToStack '"$SYSDIR\whoami.exe" /groups'
  Pop $R8                     ; 退出码（"0" = 命令成功执行）
  Pop $R9                     ; 组列表文本

  ${If} $R8 == "0"
    ; 先落临时文件，再让 findstr 读文件 —— 绕开 cmd 的管道引号问题（坑 3）
    FileOpen $8 "$TEMP\poro-groups.tmp" w
    FileWrite $8 "$R9"
    FileClose $8
    ; /C: 后面的 SID 没有空格，因此不需要引号
    nsExec::ExecToStack '"$SYSDIR\findstr.exe" /C:S-1-5-32-544 "$TEMP\poro-groups.tmp"'
    Pop $0                    ; "0" = 命中，即账户在 BUILTIN\Administrators 里
    Pop $1
    Delete "$TEMP\poro-groups.tmp"
    ${If} $0 == "0"
      StrCpy $R7 "是"
    ${Else}
      StrCpy $R7 "否"
    ${EndIf}
  ${EndIf}

  ; 当前令牌是否已提权（与"在不在管理员组"是两回事，两个都记下来）
  UserInfo::GetAccountType
  Pop $R6
  UserInfo::GetName
  Pop $R5

  ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "ProductName"
  ReadRegStr $R2 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuild"
  ReadRegStr $R3 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "PROCESSOR_ARCHITECTURE"
  ReadRegDWORD $R4 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" "EnableLUA"
  ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" "ConsentPromptBehaviorAdmin"

  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  ; $0=日 $1=月 $2=年 $3=星期 $4=时 $5=分 $6=秒

  StrCpy $9 "缺失!"
  ${If} ${FileExists} "$INSTDIR\Poro.exe"
    StrCpy $9 "存在"
  ${EndIf}

  StrCpy $3 "否"
  ${If} ${FileExists} "$APPDATA\poro-assistant\crash.log"
    StrCpy $3 "是"
  ${EndIf}

  ; ---- 落盘（UTF-16LE + BOM，见文件头编码说明）----
  CreateDirectory "$APPDATA\poro-assistant"
  FileOpen $8 "${PORO_CHECK_LOG}" w
  FileWriteByte $8 0xFF
  FileWriteByte $8 0xFE

  FileWriteUTF16LE $8 "=== Poro 安装期自检 ===$\r$\n"
  FileWriteUTF16LE $8 "时间             : $2-$1-$0 $4:$5:$6$\r$\n"
!ifdef VERSION
  FileWriteUTF16LE $8 "安装包版本       : ${VERSION}$\r$\n"
!endif
  FileWriteUTF16LE $8 "Windows          : $R1 (build $R2)$\r$\n"
  FileWriteUTF16LE $8 "处理器架构       : $R3$\r$\n"
  FileWriteUTF16LE $8 "安装目录         : $INSTDIR$\r$\n"
  FileWriteUTF16LE $8 "程序本体         : $9$\r$\n"
  FileWriteUTF16LE $8 "当前用户         : $R5$\r$\n"
  FileWriteUTF16LE $8 "在管理员组       : $R7$\r$\n"
  FileWriteUTF16LE $8 "安装器令牌       : $R6   (Admin=本次安装已提权; User=未提权)$\r$\n"
  FileWriteUTF16LE $8 "UAC (EnableLUA)  : $R4   (1=开启 0=关闭)$\r$\n"
  FileWriteUTF16LE $8 "提权提示策略     : $R0   (0=不提示直接提权 2=要求输入管理员凭据 5=要求同意)$\r$\n"
  FileWriteUTF16LE $8 "crash.log 已存在 : $3   (是=程序曾经成功启动过)$\r$\n"
  FileWriteUTF16LE $8 "---$\r$\n"

  ; ---- 结论 ----
  ${If} $R7 == "是"
    ${If} $R4 == 0
      FileWriteUTF16LE $8 "结论: 账户在管理员组，且 UAC 已关闭 —— 管理员令牌直接生效，预计可以正常启动。$\r$\n"
    ${Else}
      FileWriteUTF16LE $8 "结论: 账户在管理员组 —— 启动时可能出现 UAC 提权提示，点[是]即可正常运行。$\r$\n"
      FileWriteUTF16LE $8 "      如果启动时一闪而过、连提示都没看到，请检查安全软件是否拦截了 UAC 弹窗。$\r$\n"
    ${EndIf}
  ${ElseIf} $R7 == "否"
    ${If} $R4 == 0
      FileWriteUTF16LE $8 "结论: [警告] 账户不在管理员组，且 UAC 已关闭 —— Poro 一定无法启动，且不会出现任何提示。$\r$\n"
    ${Else}
      FileWriteUTF16LE $8 "结论: [警告] 账户不在管理员组 —— Poro 启动时会要求输入管理员账户的密码。$\r$\n"
      FileWriteUTF16LE $8 "      若无法提供凭据、或提权被拒绝，Poro 将无法启动。$\r$\n"
    ${EndIf}
    FileWriteUTF16LE $8 "      这种情况请改用受限版安装包 Poro-Setup-<版本>-limited.exe：$\r$\n"
    FileWriteUTF16LE $8 "      它不需要管理员权限，战绩/档案/实时对局/强化推荐/悬浮层全部可用，$\r$\n"
    FileWriteUTF16LE $8 "      只有游戏内热键与聊天预填不可用。$\r$\n"
  ${Else}
    FileWriteUTF16LE $8 "结论: 无法判定账户所属组（whoami 未成功执行，退出码 $R8）。$\r$\n"
    FileWriteUTF16LE $8 "      如果 Poro 启动时一闪而过且没有生成 crash.log，请改用受限版安装包。$\r$\n"
  ${EndIf}

  FileClose $8

  ; ---- 只在确实有问题、且不是静默安装时提示用户 ----
  ; IfSilent 是 NSIS 核心指令：升级走静默安装时不会弹窗，避免卡住自动更新。
  ${If} $R7 == "否"
    IfSilent poroCheckDone
      ${If} $R4 == 0
        MessageBox MB_ICONEXCLAMATION|MB_OK "Poro 需要管理员权限，而当前 Windows 账户不在管理员组、UAC 也已关闭。$\r$\n$\r$\nPoro 启动后不会出现任何提示就会退出。请改用受限版安装包（文件名带 -limited 的那个）。$\r$\n$\r$\n自检报告：$\r$\n${PORO_CHECK_LOG}"
      ${Else}
        MessageBox MB_ICONEXCLAMATION|MB_OK "Poro 需要管理员权限，而当前 Windows 账户不在管理员组。$\r$\n$\r$\n启动 Poro 时会要求输入管理员账户的密码；如果无法提供，Poro 将无法启动。这种情况下请改用受限版安装包（文件名带 -limited 的那个）。$\r$\n$\r$\n自检报告：$\r$\n${PORO_CHECK_LOG}"
      ${EndIf}
    poroCheckDone:
  ${EndIf}

  ; 逆序还原（与开头 Push 顺序严格相反）
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; electron-builder 的安装段末尾会插入这个宏（此时文件已落地、$INSTDIR 已定）
!macro customInstall
  !insertmacro poroInstallCheck
!macroend
