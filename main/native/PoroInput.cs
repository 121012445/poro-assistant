using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class PoroInput
{
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint MAPVK_VK_TO_VSC = 0;
    private const ushort VK_RETURN = 0x0D;
    private const int SW_RESTORE = 9;
    private static readonly IntPtr HWND_TOP = IntPtr.Zero;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_SHOWWINDOW = 0x0040;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        // INPUT's union must be large enough for MOUSEINPUT even when only keyboard
        // input is used. On x64 omitting it makes Marshal.SizeOf(INPUT) return 32
        // instead of Win32's required 40, and SendInput fails with ERROR_INVALID_PARAMETER.
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] private static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    private static string WindowClass(IntPtr hWnd)
    {
        var text = new StringBuilder(256);
        return GetClassName(hWnd, text, text.Capacity) > 0 ? text.ToString() : "";
    }

    private static IntPtr FindLeagueWindow()
    {
        IntPtr found = IntPtr.Zero;
        long largestArea = 0;
        EnumWindows(delegate(IntPtr hWnd, IntPtr unused) {
            if (!IsWindowVisible(hWnd) || WindowClass(hWnd) != "RiotWindowClass") return true;
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            string processName = "";
            try { processName = Process.GetProcessById((int)processId).ProcessName; } catch {}
            if (!String.Equals(processName, "League of Legends", StringComparison.OrdinalIgnoreCase)) return true;
            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) return true;
            long area = Math.Max(0, rect.Right - rect.Left) * (long)Math.Max(0, rect.Bottom - rect.Top);
            if (area > largestArea) { largestArea = area; found = hWnd; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    private static bool ActivateWindow(IntPtr target)
    {
        if (GetForegroundWindow() == target) return true;
        ShowWindow(target, SW_RESTORE);
        IntPtr foreground = GetForegroundWindow();
        uint targetPid, foregroundPid;
        uint targetThread = GetWindowThreadProcessId(target, out targetPid);
        uint foregroundThread = foreground != IntPtr.Zero ? GetWindowThreadProcessId(foreground, out foregroundPid) : 0;
        uint currentThread = GetCurrentThreadId();
        bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
        bool attachedTarget = targetThread != 0 && targetThread != currentThread && AttachThreadInput(currentThread, targetThread, true);
        try {
            // 释放 Alt 是 Windows 官方前台切换规则允许的一次用户输入边界；配合线程输入队列
            // 可覆盖全屏、无边框和焦点暂时落在桌面的情况。
            SendKey(0x12, false);
            SendKey(0x12, true);
            SetWindowPos(target, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            BringWindowToTop(target);
            SetForegroundWindow(target);
            SetFocus(target);
        } finally {
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        }
        for (int i = 0; i < 30 && GetForegroundWindow() != target; i++) {
            SetForegroundWindow(target);
            Thread.Sleep(50);
        }
        return GetForegroundWindow() == target;
    }

    private static bool SendKey(ushort key, bool up)
    {
        var inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = key;
        inputs[0].U.ki.wScan = (ushort)MapVirtualKey(key, MAPVK_VK_TO_VSC);
        inputs[0].U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    private static bool ClickKey(ushort key)
    {
        return SendKey(key, false) && SendKey(key, true);
    }

    private static bool SendUnicodeChar(char ch)
    {
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wScan = ch;
        inputs[0].U.ki.dwFlags = KEYEVENTF_UNICODE;
        inputs[1] = inputs[0];
        inputs[1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) == 2;
    }

    private static void ReleaseModifiers()
    {
        ushort[] keys = { 0x11, 0xA2, 0xA3, 0x10, 0xA0, 0xA1 };
        foreach (ushort key in keys) SendKey(key, true);
    }

    public static int Main(string[] args)
    {
        try {
            Console.OutputEncoding = new UTF8Encoding(false);
            if (args.Length == 1 && args[0] == "--selftest") {
                int expected = IntPtr.Size == 8 ? 40 : 28;
                int actual = Marshal.SizeOf(typeof(INPUT));
                Console.Write("INPUT=" + actual + " EXPECTED=" + expected);
                return actual == expected ? 0 : 2;
            }
            if (args.Length < 1) throw new Exception("缺少文本");
            string message = Encoding.UTF8.GetString(Convert.FromBase64String(args[0]));
            if (message.Length == 0 || message.Length > 1000) throw new Exception("文本长度无效");
            bool activate = args.Length > 1 && args[1] == "1";
            bool submit = args.Length > 2 && args[2] == "1";
            IntPtr league = FindLeagueWindow();
            if (league == IntPtr.Zero) throw new Exception("未找到英雄联盟游戏窗口");
            if (GetForegroundWindow() != league && activate) {
                ActivateWindow(league);
            }
            if (GetForegroundWindow() != league) throw new Exception("请先切回英雄联盟游戏窗口再按快捷键");
            ReleaseModifiers();
            Thread.Sleep(30);
            if (!ClickKey(VK_RETURN)) throw new Exception("无法打开游戏聊天 (SendInput错误 " + Marshal.GetLastWin32Error() + ")");
            Thread.Sleep(160);
            foreach (char ch in message) {
                if (!SendUnicodeChar(ch)) throw new Exception("文字输入失败 (SendInput错误 " + Marshal.GetLastWin32Error() + ")");
                Thread.Sleep(2);
            }
            if (submit) {
                Thread.Sleep(80);
                if (!ClickKey(VK_RETURN)) throw new Exception("无法发送游戏聊天 (SendInput错误 " + Marshal.GetLastWin32Error() + ")");
            }
            Console.Write("OK");
            return 0;
        } catch (Exception error) {
            Console.Error.Write(error.Message);
            return 1;
        }
    }
}
