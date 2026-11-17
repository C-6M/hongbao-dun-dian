using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[ComImport, Guid("352ffba8-0973-437c-a61f-f64cafd81df9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationCondition { }

// Native UIA COM client. The legacy WPF client cannot traverse QQNT's Chromium provider.
// Interface order and GUIDs: Microsoft win32metadata, UIAutomationClient.h.
// Only the leading methods needed by this sender are declared, in SDK vtable order.
[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomation {
    void CompareElements(IUIAutomationElement a, IUIAutomationElement b, [MarshalAs(UnmanagedType.Bool)] out bool same);
    void CompareRuntimeIds([MarshalAs(UnmanagedType.SafeArray)] Array a, [MarshalAs(UnmanagedType.SafeArray)] Array b, [MarshalAs(UnmanagedType.Bool)] out bool same);
    void GetRootElement(out IUIAutomationElement element);
    void ElementFromHandle(IntPtr window, out IUIAutomationElement element);
    void ElementFromPoint(UiaPoint point, out IUIAutomationElement element);
    void GetFocusedElement(out IUIAutomationElement element);
    void GetRootElementBuildCache(IntPtr cache, out IUIAutomationElement element);
    void ElementFromHandleBuildCache(IntPtr window, IntPtr cache, out IUIAutomationElement element);
    void ElementFromPointBuildCache(UiaPoint point, IntPtr cache, out IUIAutomationElement element);
    void GetFocusedElementBuildCache(IntPtr cache, out IUIAutomationElement element);
    void CreateTreeWalker(IUIAutomationCondition condition, out IntPtr walker);
    void GetControlViewWalker(out IntPtr walker);
    void GetContentViewWalker(out IntPtr walker);
    void GetRawViewWalker(out IntPtr walker);
    void GetRawViewCondition(out IUIAutomationCondition condition);
    void GetControlViewCondition(out IUIAutomationCondition condition);
    void GetContentViewCondition(out IUIAutomationCondition condition);
    void CreateCacheRequest(out IntPtr cache);
    void CreateTrueCondition(out IUIAutomationCondition condition);
    void CreateFalseCondition(out IUIAutomationCondition condition);
    void CreatePropertyCondition(int property, [MarshalAs(UnmanagedType.Struct)] object value, out IUIAutomationCondition condition);
    void CreatePropertyConditionEx(int property, [MarshalAs(UnmanagedType.Struct)] object value, int flags, out IUIAutomationCondition condition);
    void CreateAndCondition(IUIAutomationCondition a, IUIAutomationCondition b, out IUIAutomationCondition condition);
    void CreateAndConditionFromArray([MarshalAs(UnmanagedType.SafeArray)] Array conditions, out IUIAutomationCondition condition);
    void CreateAndConditionFromNativeArray(IntPtr conditions, int count, out IUIAutomationCondition condition);
    void CreateOrCondition(IUIAutomationCondition a, IUIAutomationCondition b, out IUIAutomationCondition condition);
}
[StructLayout(LayoutKind.Sequential)] struct UiaPoint { public int X, Y; }
[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationElement {
    void SetFocus();
    void GetRuntimeId([MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_I4)] out int[] id);
    void FindFirst(int scope, IUIAutomationCondition condition, out IUIAutomationElement element);
    void FindAll(int scope, IUIAutomationCondition condition, out IUIAutomationElementArray elements);
    void FindFirstBuildCache(int scope, IUIAutomationCondition condition, IntPtr cache, out IUIAutomationElement element);
    void FindAllBuildCache(int scope, IUIAutomationCondition condition, IntPtr cache, out IUIAutomationElementArray elements);
    void BuildUpdatedCache(IntPtr cache, out IUIAutomationElement element);
    void GetCurrentPropertyValue(int property, [MarshalAs(UnmanagedType.Struct)] out object value);
    void GetCurrentPropertyValueEx(int property, [MarshalAs(UnmanagedType.Bool)] bool ignoreDefault, [MarshalAs(UnmanagedType.Struct)] out object value);
    void GetCachedPropertyValue(int property, [MarshalAs(UnmanagedType.Struct)] out object value);
    void GetCachedPropertyValueEx(int property, [MarshalAs(UnmanagedType.Bool)] bool ignoreDefault, [MarshalAs(UnmanagedType.Struct)] out object value);
    void GetCurrentPatternAs(int pattern, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object value);
    void GetCachedPatternAs(int pattern, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object value);
    void GetCurrentPattern(int pattern, [MarshalAs(UnmanagedType.IUnknown)] out object value);
}
[ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationElementArray {
    void GetLength(out int length);
    void GetElement(int index, out IUIAutomationElement element);
}
[ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationInvokePattern { void Invoke(); }
[ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUIAutomationValuePattern {
    void SetValue([MarshalAs(UnmanagedType.BStr)] string value);
    void GetCurrentValue([MarshalAs(UnmanagedType.BStr)] out string value);
    void GetCurrentIsReadOnly([MarshalAs(UnmanagedType.Bool)] out bool value);
}

static class Uia {
    public const int Name = 30005, AutomationId = 30011, ControlType = 30003, Enabled = 30010;
    public const int Button = 50000, Edit = 50004, Text = 50020;
    static readonly IUIAutomation Client = (IUIAutomation)Activator.CreateInstance(
        Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9")));
    public static IUIAutomationCondition TrueCondition {
        get { IUIAutomationCondition condition; Client.CreateTrueCondition(out condition); return condition; }
    }
    public static Element FromHandle(IntPtr window) {
        IUIAutomationElement element; Client.ElementFromHandle(window, out element); return Wrap(element);
    }
    public static Element FocusedElement {
        get { IUIAutomationElement element; Client.GetFocusedElement(out element); return Wrap(element); }
    }
    public static bool Same(Element a, Element b) {
        if (a == null || b == null) return false;
        bool same; Client.CompareElements(a.Native, b.Native, out same); return same;
    }
    static Element Wrap(IUIAutomationElement native) { return native == null ? null : new Element(native); }
    public static IUIAutomationCondition Property(int property, object value) {
        IUIAutomationCondition condition; Client.CreatePropertyCondition(property, value, out condition); return condition;
    }
    public static IUIAutomationCondition And(IUIAutomationCondition a, IUIAutomationCondition b) {
        IUIAutomationCondition condition; Client.CreateAndCondition(a, b, out condition); return condition;
    }
    public static IUIAutomationCondition Or(IUIAutomationCondition a, IUIAutomationCondition b) {
        IUIAutomationCondition condition; Client.CreateOrCondition(a, b, out condition); return condition;
    }
    public sealed class Element {
        internal readonly IUIAutomationElement Native;
        internal Element(IUIAutomationElement element) { Native = element; }
        public object Get(int property) { object value; Native.GetCurrentPropertyValue(property, out value); return value; }
        public string Name { get { return Convert.ToString(Get(Uia.Name)); } }
        public string AutomationId { get { return Convert.ToString(Get(Uia.AutomationId)); } }
        public int Type { get { return Convert.ToInt32(Get(Uia.ControlType)); } }
        public bool IsEnabled { get { return Convert.ToBoolean(Get(Uia.Enabled)); } }
        public Element Find(int property, object value) { return Find(Property(property, value)); }
        public Element Find(IUIAutomationCondition condition) {
            IUIAutomationElement element; Native.FindFirst(4, condition, out element); return Wrap(element);
        }
        public List<Element> FindAll(IUIAutomationCondition condition) {
            return FindAll(condition, 4);
        }
        public List<Element> Children() { return FindAll(TrueCondition, 2); }
        List<Element> FindAll(IUIAutomationCondition condition, int scope) {
            IUIAutomationElementArray elements; Native.FindAll(scope, condition, out elements);
            var result = new List<Element>(); if (elements == null) return result;
            int count; elements.GetLength(out count);
            for (int i = 0; i < count; i++) { IUIAutomationElement element; elements.GetElement(i, out element); result.Add(Wrap(element)); }
            return result;
        }
        public IUIAutomationValuePattern Editable() {
            object pattern; Native.GetCurrentPattern(10002, out pattern);
            var editable = pattern as IUIAutomationValuePattern;
            bool readOnly = true; if (editable != null) editable.GetCurrentIsReadOnly(out readOnly);
            if (readOnly) throw new Exception("当前 QQ 不支持安全写入输入框"); return editable;
        }
        public string Value {
            get { string value; Editable().GetCurrentValue(out value); return value ?? ""; }
        }
        public IUIAutomationInvokePattern Invokable() {
            if (!IsEnabled) throw new Exception("QQ 按钮不可用");
            object pattern; Native.GetCurrentPattern(10000, out pattern);
            var invoke = pattern as IUIAutomationInvokePattern;
            if (invoke == null) throw new Exception("QQ 按钮不支持调用"); return invoke;
        }
        public void SetFocus() { Native.SetFocus(); }
    }
}
