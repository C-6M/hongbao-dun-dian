#!/usr/bin/env python3
"""Read two configured QQ groups from a fresh, read-only local database copy."""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

TZ = timezone(timedelta(hours=8))
GROUPS = {"850739736": "喜不喜欢姐姐的大包", "1127875934": "莓来-推送群"}
PROJECT = Path(__file__).resolve().parent.parent


def stamp(seconds):
    return datetime.fromtimestamp(seconds, TZ).strftime("%Y-%m-%d %H:%M:%S") if seconds else ""


def varint(data, pos):
    value, shift, start = 0, 0, pos
    while pos < len(data) and shift < 70:
        byte = data[pos]
        pos += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, pos, data[start:pos]
        shift += 7
    raise ValueError("Invalid protobuf varint")


def packint(value):
    out = bytearray()
    while value > 127:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def sanitize(data, descriptor):
    pos, out = 0, bytearray()
    while pos < len(data):
        key, pos, raw = varint(data, pos)
        out += raw
        wire = key & 7
        if wire == 0:
            _, pos, raw = varint(data, pos)
            out += raw
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            if pos + size > len(data):
                raise ValueError("Truncated protobuf")
            out += data[pos:pos + size]
            pos += size
        elif wire == 2:
            size, pos, _ = varint(data, pos)
            if pos + size > len(data):
                raise ValueError("Truncated protobuf")
            value = data[pos:pos + size]
            pos += size
            field = descriptor.fields_by_number.get(key >> 3)
            if field and field.type == field.TYPE_MESSAGE:
                value = sanitize(value, field.message_type)
            elif field and field.type == field.TYPE_STRING:
                value = value.decode("utf-8", "replace").encode("utf-8")
            out += packint(len(value)) + value
        else:
            raise ValueError("Unsupported protobuf wire")
    return bytes(out)


def parse_requirement(text):
    match = re.search(r"(?:门槛|参与要求|参与条件|要求|条件)\s*[:：]\s*([^\r\n｜|]*)", text)
    if not match:
        return None, "missing", ""
    raw = re.split(r"开奖时间", match.group(1), maxsplit=1)[0].strip()
    if re.search(r"大航海|舰长|提督|总督", raw):
        return 3, "special", raw
    normalized = re.sub(r"\s+", "", raw)
    ordinary = {"无要求": 0, "无门槛": 0, "无": 0, "关注": 1, "需关注": 1,
                "关注主播": 1, "粉丝团": 2, "普通粉丝团": 2, "加入粉丝团": 2,
                "加入普通粉丝团": 2}
    if normalized in ordinary:
        return ordinary[normalized], "ordinary", raw
    return "unknown", "unknown", raw


def parse_report_time(value):
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ)
    except (TypeError, ValueError):
        return None


def parse_remaining(value):
    match = re.fullmatch(r"(?:约\s*)?(?:(\d+)\s*(?:小时|时)\s*)?(?:(\d+)\s*分(?:钟)?\s*)?(?:(\d+)\s*秒\s*)?", value)
    if not match or not any(part is not None for part in match.groups()):
        return None
    hours, minutes, seconds = (int(part or 0) for part in match.groups())
    return hours * 3600 + minutes * 60 + seconds


def parse_push(text, seq, seconds, gid):
    if "红包" not in text:
        return None
    room = re.search(r"(?:房间|直播间)[:：]\s*#?\s*(\d{4,12})", text)
    if not room:
        room = re.search(r"live\.bilibili\.com/(\d{4,12})", text)
    if not room:
        return None
    value = re.search(r"(?:价值|总计|金额)[:：]\s*([\d,]+(?:\.\d+)?)\s*电池", text)
    if not value:
        value = re.search(r"电池红包\s*([\d,]+(?:\.\d+)?)\s*电池", text)
    anchor = re.search(r"主播[:：]\s*([^\r\n]+)", text)
    if not anchor:
        anchor = re.search(r"(?:^|\n)([^\r\n]+?)[（(]房间\s*\d+[）)]", text)
    # The first bot's 时间 is the observation/scan timestamp, never the packet start.
    report_match = re.search(r"(?:^|\n)(?:报告时间|扫描时间|时间)[:：]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", text)
    report_time = report_match.group(1) if report_match else ""
    report_at = parse_report_time(report_time)
    message_at = datetime.fromtimestamp(seconds, TZ) if seconds and seconds > 0 else None
    left_match = re.search(r"剩余\s*[:：]?\s*([^\r\n（）()｜|]+)", text)
    left = left_match.group(1).strip() if left_match else ""
    left_seconds = parse_remaining(left)
    packet = re.search(r"(?:lotteryId|lot_id|lottery_id)=(\d+)", text)
    end_match = re.search(r"开奖时间\s*[:：]?\s*((?:\d{4}-\d{2}-\d{2}\s+)?\d{2}:\d{2}:\d{2})", text)
    end_time, end_source, end_reference = "", "", ""
    if end_match:
        end_raw = end_match.group(1)
        if len(end_raw) > 8:
            end_at = parse_report_time(end_raw)
            end_source = "explicit_datetime"
        elif message_at:
            end_at = parse_report_time(message_at.strftime("%Y-%m-%d ") + end_raw)
            if end_at and (end_at - message_at).total_seconds() < -12 * 3600:
                end_at += timedelta(days=1)
            elif end_at and (end_at - message_at).total_seconds() > 12 * 3600:
                end_at -= timedelta(days=1)
            end_source, end_reference = "explicit_clock_message_date", stamp(seconds)
        else:
            end_at = None
        if end_at:
            end_time = end_at.strftime("%Y-%m-%d %H:%M:%S")
        else:
            end_source, end_reference = "", ""
    elif left_seconds is not None and report_at and message_at and report_at <= message_at:
        # A delayed message must use the bot's observation reference, not receipt time.
        end_time = (report_at + timedelta(seconds=left_seconds)).strftime("%Y-%m-%d %H:%M:%S")
        end_source, end_reference = "remaining_report_time", report_time
    battery = float(value.group(1).replace(",", "")) if value else 0
    prize = re.search(r"奖品[:：]\s*([^\r\n]+)", text)
    if prize and "电池红包" not in prize.group(1):
        battery = 0
    recipients = re.search(r"电池[，,]\s*(\d+)\s*份", text)
    prize_counts = re.findall(r"电池红包\s*[xX×]\s*(\d+)\s*(?:份)?", prize.group(1)) if prize else []
    award_num = sum(int(count) for count in prize_counts) if prize_counts else int(recipients.group(1)) if recipients else 0
    requirement, requirement_state, requirement_text = parse_requirement(text)
    return {"group": GROUPS[gid], "group_id": gid, "message_id": str(seq),
            "room": room.group(1), "anchor": anchor.group(1).strip() if anchor else "",
            "battery": battery, "award_name": "电池红包" if battery > 0 else "",
            "award_num": award_num,
            "join_requirement": requirement, "requirement_state": requirement_state,
            "requirement_text": requirement_text,
            "push_time": report_time, "push_time_source": "report_scan_time" if report_time else "",
            "msg_time": stamp(seconds), "left": left, "left_seconds": left_seconds,
            "lot_id": packet.group(1) if packet else "", "end_time": end_time,
            "end_time_source": end_source, "end_time_reference": end_reference,
            "end_time_approximate": bool(end_source.startswith("remaining_") and "约" in left)}


def metadata(database):
    return {p.name: (p.stat().st_size, p.stat().st_mtime_ns)
            for p in (database, Path(str(database) + "-wal")) if p.exists()}


def refresh(args):
    sys.path.insert(0, str(args.tools / "python-libs"))
    sys.path.insert(0, str(args.tools))
    from sqlcipher3 import dbapi2 as sqlcipher
    import element_pb2

    args.work_dir.mkdir(parents=True, exist_ok=True)
    snapshot_dir = Path(tempfile.mkdtemp(prefix="qq-source-", dir=args.work_dir)).resolve()
    if snapshot_dir.parent != args.work_dir.resolve():
        raise ValueError("Unexpected snapshot directory")
    copied = snapshot_dir / "nt_msg.db.stripped"
    connection = None
    try:
        for attempt in range(3):
            before = metadata(args.database)
            with args.database.open("rb") as source, copied.open("wb") as dest:
                source.seek(1024)
                shutil.copyfileobj(source, dest, 32 * 1024 * 1024)
            wal = Path(str(args.database) + "-wal")
            copied_wal = Path(str(copied) + "-wal")
            if wal.exists():
                shutil.copy2(wal, copied_wal)
            elif copied_wal.exists():
                copied_wal.unlink()
            after = metadata(args.database)
            if before == after:
                break
        else:
            raise RuntimeError("QQ database changed during all three copy attempts; export preserved")

        connection = sqlcipher.connect(str(copied), isolation_level=None)
        connection.execute("PRAGMA cipher_page_size=4096")
        key = args.key_file.read_text(encoding="ascii").strip()
        connection.execute("PRAGMA key='" + key.replace("'", "''") + "'")
        del key
        connection.execute("PRAGMA kdf_iter=4000")
        connection.execute("PRAGMA cipher_hmac_algorithm=HMAC_SHA1")
        connection.execute("PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512")
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
        pushes, sources = [], []
        for gid, name in GROUPS.items():
            rows = connection.execute("""SELECT [40003],[40050],[40800]
                FROM group_msg_table WHERE [40027]=? ORDER BY [40050],[40003]""", (gid,)).fetchall()
            failures, extracted = 0, 0
            for seq, seconds, body in rows:
                if not seconds or not body:
                    continue
                container = element_pb2.Elements()
                try:
                    try:
                        container.ParseFromString(body)
                    except Exception:
                        container.ParseFromString(sanitize(body, container.DESCRIPTOR))
                    # Quoted or forwarded content is not a new source report.
                    if any(e.type == 7 for e in container.elements):
                        continue
                    text = "".join(e.text for e in container.elements if e.type == 1)
                    push = parse_push(text, seq, seconds, gid)
                    if push:
                        pushes.append(push)
                        extracted += 1
                except Exception:
                    failures += 1
            sources.append({"group_id": gid, "name": name, "messages": len(rows),
                            "latest_message": stamp(max((r[1] or 0 for r in rows), default=0)),
                            "pushes": extracted, "parse_failures": failures})
        connection.execute("COMMIT")
        rooms = {}
        for push in pushes:
            room = rooms.setdefault(push["room"], {"room": push["room"], "count": 0,
                                                  "total_battery": 0, "anchors": [], "last": ""})
            room["count"] += 1
            room["total_battery"] += push["battery"]
            room["last"] = max(room["last"], push["msg_time"])
            if push["anchor"] and push["anchor"] not in room["anchors"]:
                room["anchors"].append(push["anchor"])
        exported = {"schema_version": 3, "extracted_at": stamp(datetime.now(TZ).timestamp()),
                    "source_kind": "qq_local_cache", "sources": sources,
                    "total_pushes": len(pushes), "unique_rooms": len(rooms),
                    "rooms": sorted(rooms.values(), key=lambda r: (-r["count"], -r["total_battery"])),
                    "pushes": pushes}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temp_output = args.output.with_name(args.output.name + "." + str(os.getpid()) + ".tmp")
        try:
            temp_output.write_text(json.dumps(exported, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(temp_output, args.output)
        finally:
            if temp_output.exists():
                temp_output.unlink()
        print(json.dumps({k: exported[k] for k in ("extracted_at", "sources", "total_pushes", "unique_rooms")}, ensure_ascii=False))
    finally:
        if connection:
            connection.close()
        # Only files in this newly created, verified directory are removed.
        for file in snapshot_dir.iterdir():
            if file.is_file():
                file.unlink()
        snapshot_dir.rmdir()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--tools", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=PROJECT / "data/qq_redpacket_extract.json")
    options = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    refresh(options)
