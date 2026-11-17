using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

static class QQGroupDedup {
    static readonly Regex Room = new Regex(@"https?://live\.bilibili\.com/(?<room>\d+)\b");
    const string TimePattern = @"(?:(?:(?<year>\d{4})[-/])?(?<month>\d{1,2})[-/](?<day>\d{1,2})\s*)?(?<hour>\d{1,2})[:：](?<minute>\d{2})(?:[:：](?<second>\d{2}))?";
    static readonly Regex Deadline = new Regex(@"(?:(?:开奖时间|结束时间|截止时间|开奖|结束)\s*[:：]?\s*" + TimePattern + "|" + TimePattern + @"\s*(?:开奖|结束|截止))");
    static readonly Regex Battery = new Regex(@"(?<value>\d+(?:\.\d+)?)\s*电池");
    static readonly Regex People = new Regex(@"(?<value>\d+)\s*(?:份|人(?:名额)?|个名额)");
    static readonly TimeZoneInfo China = TimeZoneInfo.FindSystemTimeZoneById("China Standard Time");
    static bool NumberIs(Match match, double expected) {
        double value; return Double.TryParse(match.Groups["value"].Value, NumberStyles.Number, CultureInfo.InvariantCulture, out value) && value == expected;
    }
    public static bool HasPacket(IEnumerable<string> messages, string room, long expiresAt, double battery, int people) {
        var deadline = TimeZoneInfo.ConvertTimeFromUtc(new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(expiresAt), China);
        foreach (string message in messages) {
            var rooms = new HashSet<string>(); foreach (Match match in Room.Matches(message)) rooms.Add(match.Groups["room"].Value);
            // Keep separate message cards separate, even when several notices are visible at once.
            if (rooms.Count != 1 || !rooms.Contains(room)) continue;
            bool sameTime = false;
            foreach (Match match in Deadline.Matches(message)) {
                if (Int32.Parse(match.Groups["hour"].Value) != deadline.Hour || Int32.Parse(match.Groups["minute"].Value) != deadline.Minute) continue;
                if (match.Groups["second"].Success && Int32.Parse(match.Groups["second"].Value) != deadline.Second) continue;
                if (match.Groups["month"].Success && (Int32.Parse(match.Groups["month"].Value) != deadline.Month || Int32.Parse(match.Groups["day"].Value) != deadline.Day)) continue;
                if (match.Groups["year"].Success && Int32.Parse(match.Groups["year"].Value) != deadline.Year) continue;
                sameTime = true;
            }
            if (!sameTime) continue;
            bool hasBattery = false, sameBattery = false, hasPeople = false, samePeople = false;
            foreach (Match match in Battery.Matches(message)) {
                string prefix = message.Substring(Math.Max(0, match.Index - 8), Math.Min(8, match.Index));
                if (Regex.IsMatch(prefix, @"人均\s*$")) continue;
                hasBattery = true; if (NumberIs(match, battery)) sameBattery = true;
            }
            foreach (Match match in People.Matches(message)) { hasPeople = true; if (NumberIs(match, people)) samePeople = true; }
            if ((!hasBattery || sameBattery) && (!hasPeople || samePeople)) return true;
        }
        return false;
    }
    public static int SelfTest() {
        long expires = (long)(new DateTime(2026, 11, 13, 13, 40, 1, DateTimeKind.Utc) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        string a = "🔴 电池红包 100电池，10份 开奖时间 21:40:01（剩余 09分55秒） https://live.bilibili.com/12345";
        string b = "电池红包 · 人均 10 电池\n100 电池 / 10 份\n剩余 9分55秒 · 21:40:01 开奖（北京时间）\nhttps://live.bilibili.com/12345";
        var cases = new List<bool> {
            HasPacket(new [] { a }, "12345", expires, 100, 10),
            HasPacket(new [] { b }, "12345", expires, 100, 10),
            !HasPacket(new [] { a }, "99999", expires, 100, 10),
            !HasPacket(new [] { a }, "12345", expires + 60000, 100, 10),
            !HasPacket(new [] { a }, "12345", expires, 500, 10),
            !HasPacket(new [] { a }, "12345", expires, 100, 20),
            HasPacket(new [] { "总金额：100电池 份数：10份 结束时间：11/13 21:40:01 https://live.bilibili.com/12345" }, "12345", expires, 100, 10),
            !HasPacket(new [] { "100电池 10份 结束时间：11/12 21:40:01 https://live.bilibili.com/12345" }, "12345", expires, 100, 10),
            !HasPacket(new [] { a + " https://live.bilibili.com/99999" }, "12345", expires, 100, 10),
            !HasPacket(new [] { a.Replace("21:40:01", "21:40:02") }, "12345", expires, 100, 10),
            HasPacket(new [] { a.Replace("21:40:01", "21:40") }, "12345", expires, 100, 10),
            HasPacket(new [] { a.Replace("开奖时间 21:40:01", "截止时间：2026/11/13 21:40:01") }, "12345", expires, 100, 10),
            !HasPacket(new [] { a.Replace("开奖时间 21:40:01", "截止时间：2025/11/13 21:40:01") }, "12345", expires, 100, 10),
            !HasPacket(new [] { "100电池 10份 开奖时间 21:40:01", "https://live.bilibili.com/12345" }, "12345", expires, 100, 10)
        };
        foreach (bool passed in cases) if (!passed) throw new Exception("群消息查重自检失败");
        return cases.Count;
    }
}
