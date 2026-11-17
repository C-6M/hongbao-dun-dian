using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Element = QQAccess.Element;

// Standalone application sender. No clipboard, fixed coordinates or QQ process injection.
class QQSender {
    const string GroupId = "1127875934", GroupName = "莓来-推送群";
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
    static bool invoked, drafted;
    static IntPtr target, previous;
    static uint targetProcess;
    static Element root, editor;
    static string message, ownedDraft = "";
    static string dataDirectory = AppDomain.CurrentDomain.BaseDirectory;
    static Dictionary<string, object> payload;
    static readonly List<object> diagnostics = new List<object>();
    delegate bool EnumWindowProc(IntPtr window, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc callback, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder title, int count);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int type, IntPtr data, int length, out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool PeekMessage(IntPtr message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, [In] Input[] inputs, int size);
    [StructLayout(LayoutKind.Sequential)] struct KeyboardInput {
        public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Explicit, Size = 40)] struct Input {
        [FieldOffset(0)] public uint Type;
        [FieldOffset(8)] public KeyboardInput Keyboard;
    }
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);

    static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
    static int Integrity(IntPtr process) {
        IntPtr token;
        if (!OpenProcessToken(process, 8, out token)) return -Marshal.GetLastWin32Error();
        try {
            int length; GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
            IntPtr data = Marshal.AllocHGlobal(length);
            try {
                if (!GetTokenInformation(token, 25, data, length, out length)) return -Marshal.GetLastWin32Error();
                IntPtr sid = Marshal.ReadIntPtr(data); byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)count - 1));
            } finally { Marshal.FreeHGlobal(data); }
        } finally { CloseHandle(token); }
    }
    static string ProcessImage(uint pid) {
        // Query the owner of this HWND directly. .NET's process enumeration can omit a live QQ process.
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "无法查询 QQ 窗口进程");
        try {
            var name = new StringBuilder(32768); uint size = (uint)name.Capacity;
            if (!QueryFullProcessImageName(handle, 0, name, ref size))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "无法读取 QQ 进程路径");
            return name.ToString();
        } finally { CloseHandle(handle); }
    }
    static Element Find(Element parent, int property, object value) { return parent.Find(property, value); }
    static string NormalizeText(string value) { return value.Replace("\r\n", "\n").Replace('\r', '\n').TrimEnd('\n'); }
    static string Value(Element element) { return NormalizeText(element.Value); }
    static bool Activate(IntPtr window) {
        if (GetForegroundWindow() == window) return true;
        // Attach only ordinary threads on the current unlocked desktop; no privilege or settings changes.
        IntPtr buffer = Marshal.AllocHGlobal(48);
        try { PeekMessage(buffer, IntPtr.Zero, 0, 0, 0); } finally { Marshal.FreeHGlobal(buffer); }
        uint unused, current = GetCurrentThreadId();
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out unused);
        uint windowThread = GetWindowThreadProcessId(window, out unused);
        bool foregroundAttached = foregroundThread != 0 && foregroundThread != current && AttachThreadInput(current, foregroundThread, true);
        bool windowAttached = windowThread != 0 && windowThread != current && windowThread != foregroundThread && AttachThreadInput(current, windowThread, true);
        try { BringWindowToTop(window); SetForegroundWindow(window); return GetForegroundWindow() == window; }
        finally {
            if (windowAttached) AttachThreadInput(current, windowThread, false);
            if (foregroundAttached) AttachThreadInput(current, foregroundThread, false);
        }
    }
    static void RequireInputFocus() {
        RequireTarget();
        if (GetForegroundWindow() != target || !QQAccess.Same(SelectEditor(), QQAccess.FocusedElement))
            throw new Exception("QQ 输入焦点已改变，暂停发送");
        if (GetAsyncKeyState(0x10) < 0 || GetAsyncKeyState(0x11) < 0 || GetAsyncKeyState(0x12) < 0)
            throw new Exception("正在使用键盘快捷键，稍后再推送");
    }
    static Input Key(ushort key, ushort scan, uint flags) {
        return new Input { Type = 1, Keyboard = new KeyboardInput { Key = key, Scan = scan, Flags = flags } };
    }
    static void SubmitInputs(List<Input> inputs) {
        RequireInputFocus();
        if (SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(Input))) != inputs.Count)
            throw new Exception("QQ 文字输入未完整提交，保留输入框并暂停发送");
    }
    static void TypeMessage(string text) {
        var lines = NormalizeText(text).Split('\n');
        string expected = "";
        for (int i = 0; i < lines.Length; i++) {
            if (i > 0) {
                SubmitInputs(new List<Input> { Key(0x10, 0, 0), Key(0x0d, 0, 0), Key(0x0d, 0, 2), Key(0x10, 0, 2) });
                expected += "\n"; ownedDraft = expected; Thread.Sleep(150);
            }
            // QQ's rich editor processes text asynchronously. Wait for each small batch before the next.
            for (int start = 0; start < lines[i].Length; start += 8) {
                string batch = lines[i].Substring(start, Math.Min(8, lines[i].Length - start));
                var inputs = new List<Input>();
                foreach (char character in batch) { inputs.Add(Key(0, character, 4)); inputs.Add(Key(0, character, 6)); }
                SubmitInputs(inputs); expected += batch; ownedDraft = expected;
                bool verified = false;
                for (int poll = 0; poll < 20; poll++) {
                    Thread.Sleep(50); RequireInputFocus();
                    if (Value(SelectEditor()).TrimEnd() == NormalizeText(expected).TrimEnd()) { verified = true; break; }
                }
                if (!verified) throw new Exception("QQ 文字输入未确认，保留草稿并暂停发送");
            }
        }
    }
    static QQAccess.ValueControl Editable(Element element) { return element.Editable(); }
    static void Invoke(Element element) {
        if (element == null) throw new Exception("QQ 按钮不可用"); element.Invokable().Invoke();
    }
    static void RequireTarget() {
        if (!DesktopReady()) throw new Exception("电脑已锁屏或桌面不可用，暂停发送");
        if (!IsWindow(target) || !IsWindowVisible(target)) throw new Exception("QQ 目标窗口不可用，暂停发送");
        uint process; GetWindowThreadProcessId(target, out process);
        if (process != targetProcess || !Path.GetFileName(ProcessImage(process)).Equals("QQ.exe", StringComparison.OrdinalIgnoreCase))
            throw new Exception("QQ 窗口进程已改变，暂停发送");
        if (root.Name != GroupName) throw new Exception("目标聊天已改变，暂停发送");
    }
    static bool DesktopReady() {
        IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
        if (desktop == IntPtr.Zero) return false;
        try {
            var name = new StringBuilder(256); uint needed;
            return GetUserObjectInformation(desktop, 2, name, (uint)(name.Capacity * 2), out needed) && name.ToString() == "Default";
        } finally { CloseDesktop(desktop); }
    }
    static IntPtr SelectWindow() {
        var candidates = new List<IntPtr>();
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            if (!IsWindowVisible(window)) return true;
            uint pid; GetWindowThreadProcessId(window, out pid);
            var title = new StringBuilder(1024); GetWindowText(window, title, title.Capacity);
            try {
                string processName = Path.GetFileName(ProcessImage(pid));
                if (!processName.Equals("QQ.exe", StringComparison.OrdinalIgnoreCase)) {
                    if (title.ToString().Contains(GroupName)) diagnostics.Add(new { pid = pid, title = title.ToString(), processName = processName });
                    return true;
                }
                var accessible = QQAccess.FromHandle(window);
                diagnostics.Add(new { pid = pid, window = window.ToInt64(), title = title.ToString(), processName = processName, accessibleName = accessible.Name });
                // QQ's native caption can be blank while the accessible chat window has its actual title.
                if (title.ToString() == GroupName || accessible.Name == GroupName) candidates.Add(window);
            }
            catch (Exception e) { if (title.ToString().Contains(GroupName)) diagnostics.Add(new { pid = pid, title = title.ToString(), error = e.Message }); }
            return true;
        }, IntPtr.Zero);
        if (candidates.Count != 1) throw new Exception("请将 QQ 群“" + GroupName + "”打开为独立窗口；当前匹配 " + candidates.Count + " 个窗口");
        return candidates[0];
    }
    static void VerifyGroup() {
        RequireTarget();
        Element number = Find(root, QQAccess.Name, GroupId);
        Element more = Find(root, QQAccess.AutomationId, "id-func-bar-more");
        if (number == null) {
            Invoke(more);
            for (int i = 0; i < 20 && number == null; i++) {
                Thread.Sleep(100); RequireTarget(); number = Find(root, QQAccess.Name, GroupId);
            }
        }
        if (number == null) throw new Exception("未核对到目标群号 " + GroupId + "，暂停发送");
        // Close the group information panel, preserving all group settings.
        Invoke(more);
        for (int i = 0; i < 30; i++) {
            Thread.Sleep(100); RequireTarget();
            if (Find(root, QQAccess.Name, GroupId) == null) return;
        }
        throw new Exception("群资料面板未关闭，暂停发送");
    }
    static Element SelectEditor() {
        var areas = root.FindAll(QQAccess.Property(QQAccess.Name, "Rich Text Editor"));
        areas.RemoveAll(area => area.Type != 50032 && area.Type != 50033 && area.Type != 50030);
        if (areas.Count != 1) throw new Exception("QQ 消息编辑区域不是唯一目标");
        var editors = areas[0].FindAll(QQAccess.Property(QQAccess.ControlType, QQAccess.Edit));
        if (editors.Count != 1) throw new Exception("QQ 消息输入框不是唯一目标");
        return editors[0];
    }
    static string SearchText(string value) { return System.Text.RegularExpressions.Regex.Replace(value, @"\s+", " ").Trim(); }
    static Element MessageList() {
        var list = Find(root, QQAccess.AutomationId, "ml-root");
        if (list != null) return list;
        var lists = root.FindAll(QQAccess.Property(QQAccess.Name, "消息列表"));
        if (lists.Count != 1) throw new Exception("QQ 群消息列表不是唯一目标，无法查重，暂停发送");
        return lists[0];
    }
    static List<string> GetGroupMessages() {
        RequireTarget();
        var list = MessageList();
        var children = list.DirectChildren();
        // MSAA exposes the Message List application as a wrapper around the message container.
        for (int i = 0; i < 3 && children.Count == 1 && children[0].Type != QQAccess.Text; i++) {
            var nested = children[0].DirectChildren();
            if (nested.Count == 0) break;
            // A single body card must remain intact so its deadline and link stay together.
            bool hasText = false;
            foreach (Element child in nested) if (child.Type == QQAccess.Text) hasText = true;
            if (hasText && children[0].AutomationId != "ml-root") break;
            children = nested;
        }
        if (children.Count == 0) throw new Exception("QQ 群消息尚未加载，无法查重，暂停发送");
        var cards = new List<string>(); int readable = 0;
        foreach (Element child in children) {
            var parts = new List<string>();
            if (child.Type == QQAccess.Text) parts.Add(child.Name);
            foreach (Element text in child.FindAll(QQAccess.Property(QQAccess.ControlType, QQAccess.Text))) parts.Add(text.Name);
            string card = String.Join("\n", parts);
            if (!String.IsNullOrWhiteSpace(card)) readable++;
            if (card.Contains("live.bilibili.com/")) cards.Add(card);
        }
        if (readable == 0) throw new Exception("QQ 群消息文字不可读取，无法查重，暂停发送");
        return cards;
    }
    static bool AlreadyInGroup() {
        return QQGroupDedup.HasPacket(GetGroupMessages(), Convert.ToString(payload["room"]),
            Convert.ToInt64(payload["expiresAt"]), Convert.ToDouble(payload["battery"]), Convert.ToInt32(payload["people"]));
    }
    static void ClearOwnedDraft(string expectedText) {
        RequireInputFocus();
        editor = SelectEditor();
        if (Value(editor).TrimEnd() != NormalizeText(expectedText).TrimEnd()) throw new Exception("QQ 输入内容已改变，保留草稿");
        RequireInputFocus();
        if (Value(SelectEditor()).TrimEnd() != NormalizeText(expectedText).TrimEnd()) throw new Exception("QQ 输入内容已改变，保留草稿");
        SubmitInputs(new List<Input> { Key(0x11, 0, 0), Key(0x41, 0, 0), Key(0x41, 0, 2), Key(0x11, 0, 2), Key(0x08, 0, 0), Key(0x08, 0, 2) });
        Thread.Sleep(150);
        if (Value(SelectEditor()).Length != 0) throw new Exception("QQ 自动填写的草稿未清空，暂停发送");
        drafted = false;
    }
    static int MatchingMessages(string messageText) {
        var list = MessageList();
        var texts = list.FindAll(QQAccess.Property(QQAccess.ControlType, QQAccess.Text));
        var parts = new List<string>(); foreach (Element text in texts) parts.Add(text.Name ?? "");
        string actual = SearchText(String.Join("\n", parts)), expected = SearchText(messageText);
        int count = 0, start = 0, found;
        while ((found = actual.IndexOf(expected, start, StringComparison.Ordinal)) >= 0) { count++; start = found + expected.Length; }
        return count;
    }
    static void CheckSwitch() {
        string settingsFile = Path.Combine(dataDirectory, "qq-forward-settings.json");
        if (!File.Exists(settingsFile)) throw new Exception("QQ 转发开关未开启，取消发送");
        var settings = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(settingsFile, Encoding.UTF8));
        if (settings == null || !settings.ContainsKey("enabled") || !(settings["enabled"] is bool)
            || !(bool)settings["enabled"]) throw new Exception("QQ 转发已关闭，取消发送");
        string directory = dataDirectory;
        string noticeFile = Path.Combine(directory, "notification-settings.json");
        var notice = File.Exists(noticeFile)
            ? Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(noticeFile, Encoding.UTF8))
            : new Dictionary<string, object> { { "enabled", true }, { "minPerPerson", 10 }, { "minBattery", 0 }, { "minRemainingSeconds", 0 } };
        double battery = Convert.ToDouble(payload["battery"]), people = Convert.ToDouble(payload["people"]);
        long expires = Convert.ToInt64(payload["expiresAt"]);
        double minimumPerPerson = Convert.ToDouble(notice["minPerPerson"]);
        if (settings.ContainsKey("minPerPerson") && settings["minPerPerson"] != null) {
            object minimum = settings["minPerPerson"];
            if (!(minimum is int || minimum is long || minimum is double || minimum is decimal))
                throw new Exception("QQ 人均门槛设置无效，取消发送");
            minimumPerPerson = Convert.ToDouble(minimum);
            if (Double.IsNaN(minimumPerPerson) || Double.IsInfinity(minimumPerPerson)
                || minimumPerPerson < 0 || minimumPerPerson > 100000000)
                throw new Exception("QQ 人均门槛设置无效，取消发送");
        }
        if (!(notice["enabled"] is bool)
            || battery / people < minimumPerPerson
            || battery < Convert.ToDouble(notice["minBattery"])
            || expires - Now() < Convert.ToDouble(notice["minRemainingSeconds"]) * 1000)
            throw new Exception("推送筛选设置无效或红包不再满足条件，取消发送");
        string scanFile = Path.Combine(directory, "scan-settings.json");
        var scan = File.Exists(scanFile)
            ? Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(scanFile, Encoding.UTF8))
            : new Dictionary<string, object> { { "enabled", true } };
        if (!(scan["enabled"] is bool) || !(bool)scan["enabled"]) throw new Exception("扫描已暂停，取消发送");
        string blockedFile = Path.Combine(directory, "room-blocklist.json");
        var blocked = File.Exists(blockedFile)
            ? Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(blockedFile, Encoding.UTF8))
            : new Dictionary<string, object> { { "rooms", new object[0] } };
        foreach (object room in (System.Collections.IEnumerable)blocked["rooms"])
            if (Convert.ToString(room) == Convert.ToString(payload["room"])) throw new Exception("房间已屏蔽，取消发送");
        var live = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(directory, "live-state.json"), Encoding.UTF8));
        long updated = Convert.ToInt64(live["updated"]);
        string phase = Convert.ToString(live["phase"]);
        if (Now() - updated > 30000 || updated > Now() + 5000 || phase == "stopped" || phase == "paused"
            || phase == "pausing" || phase == "storage_error") throw new Exception("扫描结果不可用，取消发送");
    }
    static void Write(object result) { Console.WriteLine(Json.Serialize(result)); }
    [MTAThread]
    static void Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            var arguments = new List<string>();
            for (int i = 0; i < args.Length; i++) {
                if (args[i] == "--data-directory") {
                    if (++i >= args.Length) throw new Exception("缺少数据目录参数");
                    dataDirectory = Path.GetFullPath(args[i]);
                    if (!Directory.Exists(dataDirectory)) throw new Exception("数据目录不存在");
                } else arguments.Add(args[i]);
            }
            args = arguments.ToArray();
            if (args.Length == 1 && args[0] == "--self-test") {
                Write(new { status = "selfTest", passed = QQGroupDedup.SelfTest() }); return;
            }
            if (args.Length >= 1 && args[0] == "--diagnose") {
                try {
                    if (Integrity(GetCurrentProcess()) < 8192)
                        throw new Exception("QQ 发送程序处于低完整性进程，无法读取 QQ 控件；请双击“启动QQ自动推送.bat”正常编译并启动");
                    target = SelectWindow(); GetWindowThreadProcessId(target, out targetProcess);
                    if (IsIconic(target)) throw new Exception("请恢复目标 QQ 群窗口后再推送");
                    var selected = QQAccess.FromHandle(target);
                    uint pid = targetProcess;
                    IntPtr process = OpenProcess(0x1000, false, pid);
                    try { diagnostics.Add(new { senderIntegrity = Integrity(GetCurrentProcess()), qqIntegrity = Integrity(process), rootName = selected.Name, rootType = selected.Type }); }
                    finally { CloseHandle(process); }
                    var controls = selected.FindAll(QQAccess.Or(QQAccess.Property(QQAccess.ControlType, QQAccess.Button), QQAccess.Property(QQAccess.ControlType, QQAccess.Edit)));
                    var details = new List<object>();
                    foreach (Element control in controls) {
                        if (details.Count >= 40) break;
                        details.Add(new { name = control.Name, id = control.AutomationId,
                            type = control.Type, enabled = control.IsEnabled, parent = control.Name == "" ? control.ParentDescription : "" });
                    }
                    diagnostics.Add(new { backend = selected.Backend, controls = details });
                    root = selected;
                    var input = SelectEditor();
                    string inputValue = input.Value;
                    var emptyCodes = new List<int>();
                    if (String.IsNullOrWhiteSpace(inputValue)) foreach (char character in inputValue) emptyCodes.Add(character);
                    diagnostics.Add(new { messageEditor = new { name = input.Name, backend = input.Backend,
                        valueLength = inputValue.Length, normalizedLength = Value(input).Length,
                        whitespaceCodes = emptyCodes, valueIsGroupName = inputValue == GroupName } });
                    diagnostics.Add(new { groupHistory = new { readable = true, linkedCards = GetGroupMessages().Count } });
                } catch (Exception e) { diagnostics.Add(new { error = e.Message }); }
                Write(new { status = "diagnostic", windows = diagnostics }); return;
            }
            if (Integrity(GetCurrentProcess()) < 8192)
                throw new Exception("QQ 发送程序权限不足，请双击“启动QQ自动推送.bat”正常编译并启动");
            if (!DesktopReady()) throw new Exception("电脑已锁屏或桌面不可用，暂停发送");
            target = SelectWindow(); GetWindowThreadProcessId(target, out targetProcess);
            if (IsIconic(target)) throw new Exception("请恢复目标 QQ 群窗口后再推送");
            previous = GetForegroundWindow();
            if (!Activate(target)) throw new Exception("QQ 窗口未能切到前台，稍后再推送");
            root = QQAccess.FromHandle(target);
            // Allow the provider to finish publishing controls, without stealing the foreground.
            for (int i = 0; i < 30 && Find(root, QQAccess.AutomationId, "id-func-bar-more") == null; i++) {
                Thread.Sleep(100); RequireTarget(); root = QQAccess.FromHandle(target);
            }
            VerifyGroup(); editor = SelectEditor();
            string draft = Value(editor);
            if (args.Length == 1 && args[0] == "--probe") {
                Write(new { status = "ready", groupId = GroupId, groupName = GroupName, hasDraft = draft.Length > 0,
                    writable = Editable(editor) != null }); return;
            }
            Console.InputEncoding = new UTF8Encoding(false);
            payload = Json.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd());
            if (payload == null || Convert.ToString(payload["groupId"]) != GroupId
                || Convert.ToString(payload["groupName"]) != GroupName) throw new Exception("发送目标无效");
            long expires = Convert.ToInt64(payload["expiresAt"]);
            string id = Convert.ToString(payload["id"]);
            message = Convert.ToString(payload["text"]);
            if (String.IsNullOrWhiteSpace(message) || message.Length > 2000
                || !System.Text.RegularExpressions.Regex.IsMatch(id, @"^\d+$")
                || !message.EndsWith("https://live.bilibili.com/" + Convert.ToString(payload["room"]))) throw new Exception("红包消息格式无效");
            if (expires <= Now()) throw new Exception("红包已过期，取消发送");
            CheckSwitch();
            if (AlreadyInGroup()) { Write(new { status = "duplicate", checkedAt = Now() }); return; }
            if (draft.Length > 0) throw new Exception("QQ 输入框已有草稿，保留草稿并暂停发送");
            RequireTarget();
            if (Value(editor).Length > 0) throw new Exception("QQ 输入框出现草稿，暂停发送");
            editor.SetFocus(); Thread.Sleep(100); RequireInputFocus();
            if (Value(SelectEditor()).Length > 0) throw new Exception("QQ 输入框出现草稿，暂停发送");
            drafted = true; TypeMessage(message);
            Thread.Sleep(200); RequireTarget();
            editor = SelectEditor();
            string written = Value(editor);
            if (written != NormalizeText(message)) {
                Console.Error.WriteLine(Json.Serialize(new { stage = "writeVerification",
                    expectedLength = message.Length, actualLength = written.Length,
                    hasExpectedLink = written.Contains("https://live.bilibili.com/" + Convert.ToString(payload["room"])),
                    expectedLineCount = message.Split('\n').Length, actualLineCount = written.Split('\n').Length }));
                throw new Exception("QQ 实际写入内容不匹配，暂停发送");
            }
            if (expires <= Now()) throw new Exception("红包已过期，取消发送");
            CheckSwitch();
            var sends = root.FindAll(QQAccess.And(QQAccess.Property(QQAccess.ControlType, QQAccess.Button), QQAccess.Property(QQAccess.Name, "发送")));
            if (sends.Count != 1) throw new Exception("QQ 发送按钮不是唯一目标");
            var send = sends[0];
            RequireInputFocus();
            if (Value(SelectEditor()) != NormalizeText(message)) throw new Exception("QQ 输入内容发生变化，暂停发送");
            // Once invoking starts, any exception is ambiguous and must not trigger a retry.
            if (send == null || !send.IsEnabled) throw new Exception("QQ 发送按钮不可用");
            var sendPattern = send.Invokable();
            if (AlreadyInGroup()) {
                ClearOwnedDraft(message); Write(new { status = "duplicate", checkedAt = Now() }); return;
            }
            int matchingBefore = MatchingMessages(message);
            CheckSwitch(); RequireInputFocus();
            if (expires <= Now()) throw new Exception("红包已过期，取消发送");
            if (Value(SelectEditor()) != NormalizeText(message)) throw new Exception("QQ 输入内容发生变化，暂停发送");
            invoked = true; sendPattern.Invoke();
            for (int i = 0; i < 30; i++) {
                Thread.Sleep(100);
                if (Value(editor).Length == 0 && MatchingMessages(message) > matchingBefore) {
                    Write(new { status = "sent", groupId = GroupId, id = id, confirmedAt = Now() }); return;
                }
            }
            Write(new { status = "unknown", error = "已执行发送，未观察到消息确认；不自动重复发送" });
        } catch (Exception e) {
            if (!invoked && drafted && editor != null) {
                try { RequireTarget(); editor = SelectEditor(); if (Value(editor).TrimEnd() == NormalizeText(ownedDraft).TrimEnd()) ClearOwnedDraft(ownedDraft); } catch { }
            }
            Write(new { status = invoked ? "unknown" : "notSent", error = e.Message });
        } finally {
            if (previous != IntPtr.Zero && previous != target && IsWindow(previous) && GetForegroundWindow() == target) Activate(previous);
        }
    }
}
