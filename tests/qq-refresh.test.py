import importlib.util
import json
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path

spec = importlib.util.spec_from_file_location("refresh_qq", Path(__file__).resolve().parents[1] / "core/refresh-qq.py")
qq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qq)


class QQRefreshTests(unittest.TestCase):
    def test_first_group_format_and_non_battery_prize(self):
        text = "主播: ice咩宝Oo\n房间: #1814037792\n价值: 200 电池\n时间: 2026-11-06 16:05:48\n奖品: 电池红包 x 10"
        push = qq.parse_push(text, 1, 1793952573, "850739736")
        self.assertEqual(push["battery"], 200)
        self.assertEqual(push["award_num"], 10)
        self.assertEqual(push["push_time"], "2026-11-06 16:05:48")
        self.assertEqual(push["push_time_source"], "report_scan_time")
        self.assertIsNone(push["join_requirement"])
        self.assertEqual(push["requirement_state"], "missing")
        self.assertEqual(qq.parse_push(text.replace("电池红包 x 10", "亲密度红包 x 10"), 1, 1793952573, "850739736")["battery"], 0)

    def test_second_group_format_has_amount_room_and_end_time(self):
        text = "🔴 电池红包 200电池，10份\nice咩宝Oo（房间 1814037792）\n门槛：粉丝团｜开奖时间 16:11:02（剩余 09分33秒）\nhttps://live.bilibili.com/1814037792"
        timestamp = datetime(2026, 11, 6, 16, 1, 28, tzinfo=qq.TZ).timestamp()
        push = qq.parse_push(text, 2, timestamp, "1127875934")
        self.assertEqual((push["room"], push["battery"], push["award_num"]), ("1814037792", 200, 10))
        self.assertEqual(push["anchor"], "ice咩宝Oo")
        self.assertEqual(push["end_time"], "2026-11-06 16:11:02")
        self.assertEqual(push["end_time_source"], "explicit_clock_message_date")
        self.assertEqual(push["left"], "09分33秒")
        self.assertEqual(push["left_seconds"], 573)
        self.assertEqual(push["join_requirement"], 2)

    def test_end_time_rolls_over_midnight_and_chat_is_ignored(self):
        timestamp = datetime(2026, 11, 6, 23, 58, tzinfo=qq.TZ).timestamp()
        push = qq.parse_push("电池红包 100电池，5份\n开奖时间 00:05:00\nhttps://live.bilibili.com/12345", 3, timestamp, "1127875934")
        self.assertEqual(push["end_time"], "2026-11-07 00:05:00")
        self.assertIsNone(qq.parse_push("普通聊天", 4, timestamp, "1127875934"))

    def test_unicode_multiplication_and_multiple_battery_prizes_add_recipients(self):
        timestamp = datetime(2026, 11, 6, 16, tzinfo=qq.TZ).timestamp()
        for prize, expected in [("电池红包 ×50 份", 50), ("电池红包 x 10, 电池红包 × 5, 人气票 x 121", 15)]:
            push = qq.parse_push("房间: #12345\n价值: 200 电池\n奖品: " + prize, 5, timestamp, "850739736")
            self.assertEqual(push["award_num"], expected)

    def test_explicit_requirements_distinguish_ordinary_special_unknown_and_missing(self):
        timestamp = datetime(2026, 11, 6, 16, tzinfo=qq.TZ).timestamp()
        base = "电池红包 100电池，10份\nhttps://live.bilibili.com/12345\n"
        for text, expected, state in [("无要求", 0, "ordinary"), ("关注", 1, "ordinary"),
                                     ("普通粉丝团", 2, "ordinary"), ("粉丝团", 2, "ordinary"),
                                     ("大航海", 3, "special"), ("舰长", 3, "special"),
                                     ("提督", 3, "special"), ("总督", 3, "special"),
                                     ("粉丝团且舰长", 3, "special"), ("未知", "unknown", "unknown"),
                                     ("粉丝团（舰长）", 3, "special"),
                                     ("粉丝团等级 10", "unknown", "unknown"), ("", "unknown", "unknown")]:
            with self.subTest(text=text):
                push = qq.parse_push(base + "门槛：" + text + "｜开奖时间 16:05:00", 6, timestamp, "1127875934")
                self.assertEqual((push["join_requirement"], push["requirement_state"]), (expected, state))
                self.assertEqual(push["requirement_text"], text)
        missing = qq.parse_push(base, 7, timestamp, "1127875934")
        self.assertEqual((missing["join_requirement"], missing["requirement_state"]), (None, "missing"))

    def test_remaining_uses_scan_reference_and_never_invents_start_or_receipt_reference(self):
        timestamp = datetime(2026, 11, 6, 16, 12, tzinfo=qq.TZ).timestamp()
        base = "房间: #12345\n价值: 100 电池\n奖品: 电池红包 x 10\n剩余: 约 4分 25秒\n"
        push = qq.parse_push(base + "时间: 2026-11-06 16:07:00", 8, timestamp, "850739736")
        self.assertEqual(push["end_time"], "2026-11-06 16:11:25")
        self.assertEqual(push["end_time_source"], "remaining_report_time")
        self.assertEqual(push["end_time_reference"], "2026-11-06 16:07:00")
        self.assertTrue(push["end_time_approximate"])
        self.assertEqual(push["left"], "约 4分 25秒")
        self.assertNotIn("start_time", push)
        for suffix in ["", "时间: 2026-11-06 16:13:00", "时间: 2026-11-99 16:07:00"]:
            self.assertEqual(qq.parse_push(base + suffix, 9, timestamp, "850739736")["end_time"], "")
        malformed = qq.parse_push(base.replace("约 4分 25秒", "稍后再看") + "时间: 2026-11-06 16:07:00", 10, timestamp, "850739736")
        self.assertEqual(malformed["left"], "稍后再看")
        self.assertIsNone(malformed["left_seconds"])
        self.assertEqual(malformed["end_time"], "")

    def test_explicit_full_draw_datetime_is_preserved_without_becoming_report_time(self):
        timestamp = datetime(2026, 11, 6, 23, 58, tzinfo=qq.TZ).timestamp()
        text = "电池红包 100电池，5份\n开奖时间：2026-11-07 00:05:00（剩余 07分00秒）\nhttps://live.bilibili.com/12345"
        push = qq.parse_push(text, 11, timestamp, "1127875934")
        self.assertEqual(push["end_time"], "2026-11-07 00:05:00")
        self.assertEqual(push["end_time_source"], "explicit_datetime")
        self.assertEqual(push["push_time"], "")

    def test_recent_first_group_fixture_has_no_missing_battery_prize_counts(self):
        fixture = Path(__file__).resolve().parents[1] / "docs/qq-refresh-20261110-154633/recent-chat-texts.json"
        data = json.loads(fixture.read_text(encoding="utf-8"))
        reports = []
        for item in data["messages"]:
            if item["group_id"] != "850739736" or item["quoted_or_forwarded"]:
                continue
            at = datetime.strptime(item["msg_time"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=qq.TZ).timestamp()
            push = qq.parse_push(item["text"], item["message_id"], at, item["group_id"])
            if push and push["battery"] > 0:
                reports.append(push)
        self.assertEqual(len(reports), 47)
        self.assertTrue(all(push["award_num"] > 0 for push in reports))


if __name__ == "__main__":
    unittest.main()
