using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;

// QQNT versions expose either native UIA or MSAA. Use their accessible controls in both cases.
static class QQAccess {
    public const int Name = Uia.Name, AutomationId = Uia.AutomationId, ControlType = Uia.ControlType;
    public const int Button = Uia.Button, Edit = Uia.Edit, Text = Uia.Text;
    static Element selectedRoot;
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr window, uint objectId,
        ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object accessible);
    [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible accessible, int start, int count,
        [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] object[] children, out int obtained);

    public sealed class Condition {
        internal int Property; internal object Value; internal Condition A, B; internal bool IsOr;
        internal bool Matches(Element element) {
            if (A != null) return IsOr ? A.Matches(element) || B.Matches(element) : A.Matches(element) && B.Matches(element);
            return Object.Equals(Property == Name ? (object)element.Name
                : Property == AutomationId ? (object)element.AutomationId : (object)element.Type, Value);
        }
        internal IUIAutomationCondition Native {
            get { return A == null ? Uia.Property(Property, Value) : IsOr ? Uia.Or(A.Native, B.Native) : Uia.And(A.Native, B.Native); }
        }
    }
    public static Condition Property(int property, object value) { return new Condition { Property = property, Value = value }; }
    public static Condition And(Condition a, Condition b) { return new Condition { A = a, B = b }; }
    public static Condition Or(Condition a, Condition b) { return new Condition { A = a, B = b, IsOr = true }; }
    public static Element FromHandle(IntPtr window) {
        var native = Uia.FromHandle(window);
        if (native.FindAll(Uia.Property(Uia.ControlType, Edit)).Count > 0) selectedRoot = new Element(native);
        else {
            Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71"); object accessible;
            Marshal.ThrowExceptionForHR(AccessibleObjectFromWindow(window, 0xfffffffc, ref iid, out accessible));
            selectedRoot = new Element((IAccessible)accessible, 0, null);
        }
        return selectedRoot;
    }
    public static Element FocusedElement {
        get {
            if (selectedRoot == null || selectedRoot.Native != null) {
                var native = Uia.FocusedElement; return native == null ? null : new Element(native);
            }
            var current = selectedRoot;
            for (int i = 0; i < 20; i++) {
                object focus = current.Access.accFocus;
                var accessible = focus as IAccessible;
                var next = accessible != null ? new Element(accessible, 0, current)
                    : focus is int ? current.Child((int)focus) : null;
                if (next == null) return null;
                if (Same(next, current)) return current;
                if (next.Type == Edit) return next;
                current = next;
            }
            return null;
        }
    }
    public static bool Same(Element a, Element b) {
        if (a == null || b == null) return false;
        if (a.Native != null || b.Native != null) return a.Native != null && b.Native != null && Uia.Same(a.Native, b.Native);
        if (a.ChildId != b.ChildId) return false;
        IntPtr first = Marshal.GetIUnknownForObject(a.Access), second = Marshal.GetIUnknownForObject(b.Access);
        try { return first == second; } finally { Marshal.Release(first); Marshal.Release(second); }
    }
    public sealed class ValueControl {
        readonly Element element;
        internal ValueControl(Element value) { element = value; }
        public void SetValue(string value) {
            if (element.Native != null) element.Native.Editable().SetValue(value);
            else element.Access.set_accValue(element.ChildId, value);
        }
    }
    public sealed class InvokeControl {
        readonly Element element;
        internal InvokeControl(Element value) { element = value; }
        public void Invoke() {
            if (element.Native != null) element.Native.Invokable().Invoke();
            else element.Access.accDoDefaultAction(element.ChildId);
        }
    }
    public sealed class Element {
        internal readonly Uia.Element Native;
        internal readonly IAccessible Access;
        internal readonly int ChildId;
        readonly Element Parent;
        internal Element(Uia.Element native) { Native = native; }
        internal Element(IAccessible accessible, int childId, Element parent) { Access = accessible; ChildId = childId; Parent = parent; }
        public string Backend { get { return Native == null ? "MSAA" : "UIA"; } }
        public string Name { get { return Native != null ? Native.Name : Access.get_accName(ChildId) ?? ""; } }
        public int Type {
            get {
                if (Native != null) return Native.Type;
                switch (Convert.ToInt32(Access.get_accRole(ChildId))) {
                    case 9: case 14: return 50032; case 10: case 16: return 50033; case 15: return 50030;
                    case 20: return 50026; case 22: return 50021;
                    case 41: return Text; case 42: return Edit; case 43: return Button;
                    default: return 50025;
                }
            }
        }
        public string AutomationId {
            get {
                if (Native != null) return Native.AutomationId;
                // Observed QQNT MSAA controls: the unnamed More button and the Message List window.
                if (Type == Button && Name == "") {
                    for (Element parent = Parent; parent != null; parent = parent.Parent) {
                        if (parent.Type == 50030 || parent.Type == 50033) break;
                        if (parent.Type == 50021 && parent.Name == "更多") return "id-func-bar-more";
                    }
                }
                if (Type == 50032 && Name == "消息列表") return "ml-root";
                return "";
            }
        }
        int State { get { return Convert.ToInt32(Access.get_accState(ChildId)); } }
        public bool IsEnabled { get { return Native != null ? Native.IsEnabled : (State & 1) == 0; } }
        public string ParentDescription { get { return Parent == null ? "" : Parent.Type + ":" + Parent.Name; } }
        public string Value {
            get {
                if (Native != null) return Native.Value;
                if (Type != Edit) throw new Exception("QQ 目标不是消息输入框");
                return Access.get_accValue(ChildId) ?? "";
            }
        }
        public ValueControl Editable() {
            if (Native != null) Native.Editable();
            else if (Type != Edit || !IsEnabled || (State & 0x40) != 0) throw new Exception("QQ 消息输入框不可写入");
            return new ValueControl(this);
        }
        public InvokeControl Invokable() {
            if (Native != null) Native.Invokable();
            else if (!IsEnabled || String.IsNullOrEmpty(Access.get_accDefaultAction(ChildId))) throw new Exception("QQ 按钮不可调用");
            return new InvokeControl(this);
        }
        public void SetFocus() { if (Native != null) Native.SetFocus(); else Access.accSelect(1, ChildId); }
        internal Element Child(int id) {
            if (id == 0) return this;
            IAccessible accessible = null;
            try { accessible = Access.get_accChild(id) as IAccessible; } catch (COMException) { }
            return accessible != null ? new Element(accessible, 0, this) : new Element(Access, id, this);
        }
        IEnumerable<Element> Children() {
            if (ChildId != 0) yield break;
            int count = Access.accChildCount;
            if (count < 0 || count > 10000) throw new Exception("QQ 控件数量异常，暂停发送");
            for (int start = 0; start < count; start += 128) {
                int size = Math.Min(128, count - start), obtained;
                var children = new object[size];
                Marshal.ThrowExceptionForHR(AccessibleChildren(Access, start, size, children, out obtained));
                for (int i = 0; i < obtained; i++) {
                    var accessible = children[i] as IAccessible;
                    if (accessible != null) yield return new Element(accessible, 0, this);
                    else if (children[i] is int) yield return Child((int)children[i]);
                }
            }
        }
        public List<Element> DirectChildren() {
            var result = new List<Element>();
            if (Native != null) foreach (var child in Native.Children()) result.Add(new Element(child));
            else foreach (var child in Children()) result.Add(child);
            return result;
        }
        void Collect(Condition condition, List<Element> result, ref int visited, int depth, bool firstOnly) {
            if (depth > 40 || visited > 10000) throw new Exception("QQ 控件层级异常，暂停发送");
            foreach (var child in Children()) {
                visited++;
                try { if (condition.Matches(child)) result.Add(child); } catch (COMException) { continue; }
                if (firstOnly && result.Count > 0) return;
                child.Collect(condition, result, ref visited, depth + 1, firstOnly);
                if (firstOnly && result.Count > 0) return;
            }
        }
        public Element Find(int property, object value) { return Find(Property(property, value)); }
        public Element Find(Condition condition) {
            if (Native != null) { var result = Native.Find(condition.Native); return result == null ? null : new Element(result); }
            var list = new List<Element>(); int visited = 0; Collect(condition, list, ref visited, 0, true);
            return list.Count == 0 ? null : list[0];
        }
        public List<Element> FindAll(Condition condition) {
            var result = new List<Element>();
            if (Native != null) foreach (var item in Native.FindAll(condition.Native)) result.Add(new Element(item));
            else { int visited = 0; Collect(condition, result, ref visited, 0, false); }
            return result;
        }
    }
}
