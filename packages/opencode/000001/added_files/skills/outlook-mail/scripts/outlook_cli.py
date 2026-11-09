"""Outlook のメールと予定を扱うコマンド (スキル outlook-mail から呼ぶ)。

使い方は `outlook_cli.py --help`、または各サブコマンドの `--help` を見る。
読み取り、返信の下書き保存、予定の作成、フォルダの作成、メールのフォルダ間の移動ができる。
移動は記録され、mail-undo で戻せる。送信と削除はできない。
読み取りは、キャッシュ (cache-search / cache-show) が速い。受信トレイと送信済みを取っておき、前回より新しい分だけを足す。
出力が長いときは `--out .handoff/ファイル名` でファイルに書ける。
"""
from __future__ import annotations

import argparse
import os
import sys
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterator, TextIO

sys.path.insert(0, str(Path(__file__).resolve().parent))

import outlook_cache as cache  # noqa: E402
import outlook_client as oc  # noqa: E402

DEFAULT_LIMIT_MAX = 100
SHOW_LIMIT = 10  # cache-show で、一度に読める通数


def now() -> datetime:
    """今の日時 (テストで差し替える)。"""
    return datetime.now()


# ---------------------------------------------------------------------------
# 入力の解釈
# ---------------------------------------------------------------------------

def parse_when(text: str, *, upper_bound: bool = False) -> datetime:
    """'2026-11-07'、'2026-11-07 09:30'、'today'、'tomorrow' を日時にする。

    upper_bound=True で、日付だけの指定は、その日の終わり (翌日の 0 時) を表す。
    """
    value = text.strip().lower()
    today = datetime.combine(date.today(), datetime.min.time())
    if value == "today":
        base, has_time = today, False
    elif value == "tomorrow":
        base, has_time = today + timedelta(days=1), False
    else:
        base, has_time = None, False  # type: ignore[assignment]
        for fmt, with_time in (("%Y-%m-%d %H:%M", True), ("%Y-%m-%dT%H:%M", True), ("%Y-%m-%d", False), ("%Y/%m/%d", False)):
            try:
                base, has_time = datetime.strptime(text.strip(), fmt), with_time
                break
            except ValueError:
                continue
        if base is None:
            raise ValueError(f"日時 '{text}' を読めません。2026-11-07 または '2026-11-07 09:30' の形で指定してください")
    if upper_bound and not has_time:
        return base + timedelta(days=1)
    return base


def read_body_file(path: str) -> str:
    try:
        text = Path(path).read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise ValueError(f"本文のファイル '{path}' を読めません: {exc}") from exc
    if not text.strip():
        raise ValueError(f"本文のファイル '{path}' が空です")
    return text.strip("\n")


def check_out_path(raw: str, cwd: Path | None = None) -> Path:
    """--out は、作業フォルダ直下の .handoff/ の中で、まだ無い場所だけを許す。
    `..` やリンクを解いた後の場所で判定する (`.handoff/../../x` のように、外へ出る指定を拒否する)。
    メールの本文 (外から届く文章) を書くので、置き場所を厳しく絞る。"""
    work = cwd or Path.cwd()
    path = Path(raw)
    path = path if path.is_absolute() else work / path
    base = os.path.normcase(os.path.realpath(work / ".handoff"))
    parent = os.path.normcase(os.path.realpath(path.parent))
    if path.name in ("", ".", "..") or not (parent == base or parent.startswith(base.rstrip("\\/") + os.sep)):
        raise ValueError("--out は、作業フォルダ直下の .handoff フォルダの中だけ指定できます (例: .handoff/outlook_受信確認.md)")
    target = Path(os.path.realpath(path.parent)) / path.name
    if target.exists() or path.exists():
        raise ValueError(f"'{raw}' はすでにあります。別の名前にしてください (末尾に _2 など)")
    return target


# ---------------------------------------------------------------------------
# 出力の整形
# ---------------------------------------------------------------------------

def format_mail_list(result: dict[str, Any], header: str) -> str:
    lines = [f"件数: {len(result['items'])} ({header})"]
    if result["scan_limited"]:
        lines.append(f"注意: 新しい順に {result['scanned'] - 1} 件まで調べて打ち切りました。期間や条件を絞ると、続きが見えます")
    for index, row in enumerate(result["items"], start=1):
        flags = ("未読 " if row["unread"] else "") + (f"添付{row['attachments']} " if row["attachments"] else "")
        lines.append(f"[{index}] {row['id']} | {row['time']} | {row['sender']} | {flags}{row['subject']}")
        if row["preview"]:
            lines.append(f"    冒頭: {row['preview']}")
    return "\n".join(lines)


def format_mail(mail: dict[str, Any], max_chars: int) -> str:
    body = mail["body"]
    total = len(body)
    shown = body if total <= max_chars else body[:max_chars]
    lines = [
        f"id: {mail['id']}",
        f"件名: {mail['subject']}",
        f"差出人: {mail['sender']}",
        f"宛先: {mail['to']}",
    ]
    if mail["cc"]:
        lines.append(f"Cc: {mail['cc']}")
    lines.append(f"日時: {mail['time']}")
    if mail["attachments"]:
        lines.append("添付: " + ", ".join(mail["attachments"]))
    lines.append(f"--- 本文 ({len(shown)} / 全 {total} 文字) ---")
    lines.append(shown)
    if total > max_chars:
        lines.append(f"--- 以降の {total - max_chars} 文字は省略しました (--max-chars で増やせます) ---")
    return "\n".join(lines)


def format_events(result: dict[str, Any], header: str) -> str:
    lines = [f"件数: {len(result['items'])} ({header})"]
    for row in result["items"]:
        if row["all_day"]:
            when = f"{row['start'][:10]} 終日"
        else:
            same_day = row["start"][:10] == row["end"][:10]
            when = f"{row['start']}〜{row['end'][11:] if same_day else row['end']}"
        extras = [part for part in (
            f"場所: {row['location']}" if row["location"] else "",
            f"主催: {row['organizer']}" if row["organizer"] else "",
            "繰り返し" if row["recurring"] else "",
            f"出席者: {row['attendees']}" if row["attendees"] else "",
        ) if part]
        lines.append(f"- {when} | {row['subject']}" + (" | " + " | ".join(extras) if extras else ""))
    return "\n".join(lines)


def format_folders(result: dict[str, Any]) -> str:
    rows = result["rows"]
    lines = [f"フォルダ (起点: {result['root']}。--to にはこの左側のパスを使う。'.' は起点そのもの)"]
    for row in rows:
        unread = f", 未読{row['unread']}" if row["unread"] else ""
        label = f"{row['path']}  [{row['name']}]" if row["path"] == "." else row["path"]
        lines.append(f"- {label} ({row['count']}件{unread})")
    return "\n".join(lines)


def format_moves(result: dict[str, Any], dry_run: bool) -> str:
    rows = result["rows"]
    lines = []
    if "to_path" in result:
        created = f" (新規作成: {'/'.join(result['created'])})" if result["created"] else ""
        lines.append(f"{'[dry-run] ' if dry_run else ''}移動先: {result['to_path']}{created} / 対象 {len(rows)} 通")
    for index, row in enumerate(rows, start=1):
        arrow = f"{row.get('from_path', '?')} → {row.get('to_path', '?')}"
        new_id = f" → 新ID {row['new_id']}" if row.get("new_id") else ""
        detail = f" ({row['error']})" if row.get("error") else ""
        lines.append(f"[{index}] {row['ref']}{new_id} | {row.get('subject', '')} | {arrow} | {row['status']}{detail}")
    ok = sum(1 for r in rows if r["status"] in ("移動しました", "元に戻しました"))
    failed = sum(1 for r in rows if r["status"] == "失敗")
    if not dry_run:
        lines.append(f"結果: 成功 {ok} / 失敗 {failed} / 対象外 {len(rows) - ok - failed}")
        if ok:
            lines.append("元に戻すには: mail-undo <新ID> または mail-undo --last " + str(ok))
    return "\n".join(lines)


def format_move_log(result: dict[str, Any]) -> str:
    rows = result["rows"]
    lines = [f"移動の記録 (新しい順、{len(rows)} 件)"]
    for row in rows:
        mark = " [元に戻し済み]" if row["undone"] else ""
        lines.append(f"- {row['time']} | {row['new_alias']} | {row.get('subject', '')} | {row.get('from_path', '?')} → {row.get('to_path', '?')}{mark}")
    return "\n".join(lines)


def format_sync(result: dict[str, Any]) -> str:
    added = result["added"]
    kind = "全体の取り直し" if result["full"] else "差分"
    lines = [
        f"取り込み ({kind}): 新規 {added['inbox'] + added['sent']} 通 (受信 {added['inbox']} / 送信 {added['sent']}) / "
        f"フォルダ {result['folders']} 個 / 直近 {result['days']} 日 / {result['seconds']:.1f} 秒"
    ]
    if result["removed"]:
        lines.append(f"Outlook に無くなった {result['removed']} 通を、キャッシュから除きました")
    if result["errors"]:
        lines.append(f"注意: {result['errors']} 通は読めず、取り込んでいません")
    if result["timed_out"]:
        lines.append("注意: 時間切れで、取り込みが途中です。もう一度 cache-sync を実行すると、続きから取り込みます (取り込んだ分は検索できます)")
    return "\n".join(lines)


def format_cache_status(status: dict[str, Any]) -> str:
    lines = [
        f"キャッシュ: {status['count']} 通 (受信 {status['inbox']} / 送信 {status['sent']}) / フォルダ {status['folders']} 個 / 取り込む期間 直近 {status['days']} 日",
        f"範囲: {status['oldest'][:16] or '-'} 〜 {status['newest'][:16] or '-'}",
        f"最終の取り込み: {status['last_sync'][:16] or 'なし'} / 全体の取り直し: {status['last_full'][:16] or 'なし'}",
        f"場所: {status['path']}",
    ]
    if status["partial_folders"]:
        lines.append(f"注意: {status['partial_folders']} 個のフォルダは、取り込みが途中です (cache-sync で続きを取り込む)")
    return "\n".join(lines)


def format_cache_list(result: dict[str, Any], header: str, words: list[str], preview_chars: int) -> str:
    rows = result["items"]
    lines = [f"キャッシュ検索: 表示 {len(rows)} 件 / 該当 {result['total']} 件 ({header})"]
    if result["total"] > len(rows):
        lines.append(f"注意: 残り {result['total'] - len(rows)} 件は表示していません。条件を足すか、--limit を増やす")
    for index, row in enumerate(rows, start=1):
        who = row["sender"] + (f" → {oc.one_line(row['recipients'], 40)}" if row["kind"] == "sent" else "")
        flags = f"添付{row['attachments']} " if row["attachments"] else ""
        lines.append(f"[{index}] {row['alias']} | {row['time'][:16]} | {cache.KIND_LABELS[row['kind']]} {row['folder']} | {who} | {flags}{row['subject']}")
        piece = cache.excerpt(row["body"], words, preview_chars)
        if piece:
            lines.append(f"    {piece}")
    if not rows:
        lines.append("見つかりませんでした。語を減らす・言い換える、期間を広げる。期間より古いメールは、キャッシュに無い (cache-status で範囲が分かる)")
    return "\n".join(lines)


def format_cached_mail(row: Any, max_chars: int, strip_quotes: bool) -> str:
    body = oc.strip_quoted(row["body"]) if strip_quotes else row["body"]
    total = len(body)
    shown = body if total <= max_chars else body[:max_chars]
    lines = [
        f"id: {row['alias']}",
        f"件名: {row['subject']}",
        f"差出人: {row['sender']}",
        f"宛先: {row['recipients']}",
    ]
    if row["cc"]:
        lines.append(f"Cc: {row['cc']}")
    lines.append(f"日時: {row['time'][:16]}")
    lines.append(f"フォルダ: {cache.KIND_LABELS[row['kind']]} {row['folder']}")
    if row["attachments"]:
        lines.append(f"添付: {row['attachments']} 件 (キャッシュには入れていない)")
    lines.append(f"--- 本文 ({len(shown)} / 全 {total} 文字) ---")
    lines.append(shown)
    if total > max_chars:
        lines.append(f"--- 以降の {total - max_chars} 文字は省略しました (--max-chars で増やせます) ---")
    if row["truncated"]:
        lines.append(f"--- キャッシュの本文は {cache.BODY_MAX_CHARS} 文字で切ってあります。続きは mail-get {row['alias']} ---")
    return "\n".join(lines)


def emit(text: str, out_raw: str | None, stdout: TextIO) -> None:
    if out_raw:
        path = check_out_path(out_raw)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", encoding="utf-8")
        stdout.write(f"出力: {path} ({len(text.splitlines())} 行, {len(text)} 文字)\n")
    else:
        stdout.write(text + "\n")


# ---------------------------------------------------------------------------
# サブコマンド
# ---------------------------------------------------------------------------

def cmd_check(args: argparse.Namespace, client: oc.OutlookClient, stdout: TextIO) -> None:
    info = client.check()
    stdout.write(
        f"接続OK: Outlook {info['version']} / ユーザー: {info['user']} / "
        f"受信トレイ {info['inbox_count']} 件 / 予定表 {info['calendar_count']} 件\n"
    )


def cmd_mail_list(args: argparse.Namespace, client: oc.OutlookClient, stdout: TextIO) -> None:
    since = parse_when(args.since) if args.since else None
    until = parse_when(args.until, upper_bound=True) if args.until else None
    result = client.list_mail(
        folder=args.folder, since=since, until=until, sender=args.sender, subject=args.subject,
        unread_only=args.unread, limit=min(args.limit, DEFAULT_LIMIT_MAX), preview_chars=args.preview,
    )
    conditions = [f"フォルダ: {args.folder}"]
    if since:
        conditions.append(f"{oc.fmt_time(since)} 以降")
    if until:
        conditions.append(f"{oc.fmt_time(until)} より前")
    if args.sender:
        conditions.append(f"差出人に '{args.sender}'")
    if args.subject:
        conditions.append(f"件名に '{args.subject}'")
    if args.unread:
        conditions.append("未読のみ")
    emit(format_mail_list(result, ", ".join(conditions)), args.out, stdout)


def cmd_mail_get(args: argparse.Namespace, client: oc.OutlookClient, stdout: TextIO) -> None:
    mail = client.get_mail(args.id, strip_quotes=args.no_quote)
    emit(format_mail(mail, args.max_chars), args.out, stdout)


def cmd_reply_draft(args: argparse.Namespace, client_factory: Callable[[], Any], stdout: TextIO) -> None:
    body = read_body_file(args.body_file)
    if args.dry_run:
        stdout.write(
            f"[dry-run] 返信の下書きを作ります (保存だけ。送信はしません)\n"
            f"  対象: {args.id} / 全員に返信: {'はい' if args.reply_all else 'いいえ'}\n"
            f"  本文: {len(body)} 文字\n"
        )
        return
    with client_factory() as client:
        draft = client.create_reply_draft(args.id, body, reply_all=args.reply_all)
    stdout.write(
        "下書きを保存しました。送信はしていません。Outlook の下書きフォルダで確認してください。\n"
        f"id: {draft['id']}\n宛先: {draft['to']}\n" + (f"Cc: {draft['cc']}\n" if draft["cc"] else "") + f"件名: {draft['subject']}\n"
    )


def cmd_folder_list(args: argparse.Namespace, client: oc.OutlookClient, stdout: TextIO) -> None:
    emit(format_folders(client.list_folders(root=args.root, depth=args.depth)), args.out, stdout)


def cmd_folder_create(args: argparse.Namespace, client: oc.OutlookClient, stdout: TextIO) -> None:
    result = client.create_folder(args.path, root=args.root, dry_run=args.dry_run)
    prefix = "[dry-run] " if args.dry_run else ""
    if result["created"]:
        stdout.write(f"{prefix}フォルダを作成{'します' if args.dry_run else 'しました'}: {result['path']} (新規: {'/'.join(result['created'])})\n")
    else:
        stdout.write(f"フォルダはすでにあります: {result['path']}\n")


def note_moves_in_cache(rows: list[dict[str, Any]]) -> None:
    """移動でメールの ID と場所が変わったことを、キャッシュに写す (キャッシュがあるときだけ。失敗しても、移動の結果は変えない)。"""
    path = cache.cache_db_path()
    if not path.exists():
        return
    try:
        with cache.CacheStore(path) as store:
            for row in rows:
                if row.get("new_id"):
                    store.note_moved(oc.resolve_id(row["ref"]), oc.resolve_id(row["new_id"]), row.get("to_path", ""))
    except Exception:  # noqa: BLE001 - キャッシュは作り直せる。次の cache-sync --full で合う
        pass


def cmd_mail_move(args: argparse.Namespace, client: oc.OutlookClient, stdout: TextIO) -> int:
    result = client.move_mails(args.ids, args.to, root=args.root, create_missing=args.create_missing, dry_run=args.dry_run)
    note_moves_in_cache(result["rows"])
    emit(format_moves(result, args.dry_run), args.out, stdout)
    return 1 if any(r["status"] == "失敗" for r in result["rows"]) else 0


def cmd_mail_undo(args: argparse.Namespace, client: oc.OutlookClient, stdout: TextIO) -> int:
    result = client.undo_moves(refs=args.ids or None, last=args.last, dry_run=args.dry_run)
    note_moves_in_cache(result["rows"])
    emit(format_moves(result, args.dry_run), None, stdout)
    return 1 if any(r["status"] == "失敗" for r in result["rows"]) else 0


def cmd_move_log(args: argparse.Namespace, client: oc.OutlookClient, stdout: TextIO) -> None:
    emit(format_move_log(client.move_log(limit=args.limit)), args.out, stdout)


def cmd_cal_list(args: argparse.Namespace, client: oc.OutlookClient, stdout: TextIO) -> None:
    since = parse_when(args.since or "today")
    until = parse_when(args.until, upper_bound=True) if args.until else since + timedelta(days=7)
    if until <= since:
        raise ValueError("--until は --since より後にしてください")
    result = client.list_events(since, until, limit=min(args.limit, DEFAULT_LIMIT_MAX))
    emit(format_events(result, f"{oc.fmt_time(since)} から {oc.fmt_time(until)} まで"), args.out, stdout)


def cmd_cal_create(args: argparse.Namespace, client_factory: Callable[[], Any], stdout: TextIO) -> None:
    start = parse_when(args.start)
    if args.all_day:
        start = datetime.combine(start.date(), datetime.min.time())
    if args.end:
        end = parse_when(args.end)
        if end <= start:
            raise ValueError("--end は --start より後にしてください")
        duration = int((end - start).total_seconds() // 60)
    else:
        duration = args.duration_min
    if duration <= 0:
        raise ValueError("予定の長さは 1 分以上にしてください")
    body = read_body_file(args.body_file) if args.body_file else ""
    attendees = [a.strip() for a in (args.attendees or "").replace(",", ";").split(";") if a.strip()]
    summary = (
        f"  件名: {args.subject}\n  開始: {oc.fmt_time(start)}" + ("(終日)" if args.all_day else f" / {duration} 分")
        + (f"\n  場所: {args.location}" if args.location else "")
        + (f"\n  出席者: {', '.join(attendees)} (保存だけ。招待は送りません)" if attendees else "")
        + "\n"
    )
    if args.dry_run:
        stdout.write("[dry-run] 予定を作ります\n" + summary)
        return
    with client_factory() as client:
        client.create_event(
            subject=args.subject, start=start, duration_min=duration, location=args.location or "", body=body,
            attendees=attendees, reminder_min=args.reminder_min, all_day=args.all_day,
        )
    stdout.write("予定を保存しました。出席者への招待は送っていません。Outlook で確認してください。\n" + summary)


# ---------------------------------------------------------------------------
# キャッシュ (受信トレイと送信済みを取っておき、Outlook を毎回読み直さない)
# ---------------------------------------------------------------------------

def refresh_cache(store: cache.CacheStore, client_factory: Callable[[], Any], max_age_min: int, skip: bool) -> list[str]:
    """検索の前に、前回の取り込みが古ければ、差分を取り込む。Outlook につながらなくても、キャッシュで続ける。"""
    if skip:
        return []
    last = store.last_sync()
    if last is not None and now() - last < timedelta(minutes=max_age_min):
        return []
    try:
        with client_factory() as client:
            return [format_sync(cache.sync(client, store, now=now()))]
    except Exception as exc:  # noqa: BLE001 - COM のエラーは型が多様
        return [f"注意: Outlook から最新を取り込めませんでした ({exc})。キャッシュだけで答えます (最終の取り込み: {(store.get_meta('last_sync') or 'なし')[:16]})"]


def cmd_cache_sync(args: argparse.Namespace, client_factory: Callable[[], Any], stdout: TextIO) -> None:
    if args.days is not None and args.days < 1:
        raise ValueError("--days は 1 以上にしてください")
    with cache.CacheStore() as store:
        with client_factory() as client:
            result = cache.sync(client, store, days=args.days, full=args.full, max_seconds=args.max_seconds, now=now())
        stdout.write(format_sync(result) + "\n" + format_cache_status(store.status()) + "\n")


def cmd_cache_status(args: argparse.Namespace, client_factory: Callable[[], Any], stdout: TextIO) -> None:
    with cache.CacheStore() as store:
        stdout.write(format_cache_status(store.status()) + "\n")


def cmd_cache_search(args: argparse.Namespace, client_factory: Callable[[], Any], stdout: TextIO) -> None:
    since = parse_when(args.since) if args.since else None
    until = parse_when(args.until, upper_bound=True) if args.until else None
    with cache.CacheStore() as store:
        notes = refresh_cache(store, client_factory, args.max_age_min, args.no_sync)
        thread = None
        conditions = [f"フォルダ: {args.folder}"]
        if args.thread:
            origin = store.find(args.thread)
            if origin is None:
                raise LookupError(f"ID '{args.thread}' が、キャッシュにありません。先に cache-search で探して、表示された ID を使ってください")
            thread = origin["thread"]
            conditions.append(f"'{origin['subject']}' と同じ件のやり取り (古い順)")
        if args.words:
            conditions.append("語: " + " ".join(args.words))
        if since:
            conditions.append(f"{oc.fmt_time(since)} 以降")
        if until:
            conditions.append(f"{oc.fmt_time(until)} より前")
        for label, value in (("差出人", args.sender), ("宛先", args.to), ("件名", args.subject), ("フォルダ名", args.in_folder)):
            if value:
                conditions.append(f"{label}に '{value}'")
        result = store.search(
            words=args.words, kind=None if args.folder == "all" else args.folder, since=since, until=until, sender=args.sender,
            to=args.to, subject=args.subject, folder=args.in_folder, thread=thread, limit=max(1, min(args.limit, DEFAULT_LIMIT_MAX)),
        )
        oc.remember_aliases({row["alias"]: row["entry_id"] for row in result["items"]})  # 返信の下書きや移動に、同じ ID を使えるようにする
        status = store.status()
    text = format_cache_list(result, ", ".join(conditions), args.words, args.preview)
    footer = f"(キャッシュ: {status['count']} 通, {status['oldest'][:10] or '-'} 〜 {status['newest'][:10] or '-'}, 最終の取り込み {status['last_sync'][:16] or 'なし'})"
    emit("\n".join([*notes, text, footer]), args.out, stdout)


def cmd_cache_show(args: argparse.Namespace, client_factory: Callable[[], Any], stdout: TextIO) -> int:
    if len(args.ids) > SHOW_LIMIT:
        raise ValueError(f"一度に読めるのは {SHOW_LIMIT} 通までです (指定: {len(args.ids)} 通)")
    blocks: list[str] = []
    missing = 0
    with cache.CacheStore() as store:
        for ref in args.ids:
            row = store.find(ref)
            if row is None:
                missing += 1
                blocks.append(f"id: {ref}\nキャッシュにありません。cache-search で表示された ID を使う。下書きや、期間より古いメールは mail-get で読む")
            else:
                blocks.append(format_cached_mail(row, args.max_chars, args.no_quote))
    emit("\n\n==========\n\n".join(blocks), args.out, stdout)
    return 1 if missing else 0


# ---------------------------------------------------------------------------
# 引数
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="outlook_cli",
        description="Outlook のメール・予定・フォルダを扱う。メールの送信と削除はできない。",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_out(p: argparse.ArgumentParser) -> None:
        p.add_argument("--out", help="結果を .handoff フォルダ内のファイルに書く (長い出力向け)")

    sub.add_parser("check", help="Outlook に接続できるか確認する")

    p = sub.add_parser("mail-list", help="メールの一覧 (新しい順)")
    p.add_argument("--folder", default="inbox", choices=sorted(oc.FOLDERS), help="既定: inbox")
    p.add_argument("--since", help="この日時以降 (例: 2026-11-01)")
    p.add_argument("--until", help="この日まで (日付だけの指定は、その日を含む)")
    p.add_argument("--from", dest="sender", help="差出人 (名前かアドレスの一部)")
    p.add_argument("--subject", help="件名の一部")
    p.add_argument("--unread", action="store_true", help="未読だけ")
    p.add_argument("--limit", type=int, default=20, help=f"最大件数 (既定 20、上限 {DEFAULT_LIMIT_MAX})")
    p.add_argument("--preview", type=int, default=80, help="本文の冒頭を何文字見せるか (0 で非表示)")
    add_out(p)

    p = sub.add_parser("mail-get", help="1 通の本文を読む")
    p.add_argument("id", help="mail-list で表示された ID")
    p.add_argument("--max-chars", type=int, default=4000, help="本文の最大文字数 (既定 4000)")
    p.add_argument("--no-quote", action="store_true", help="引用された過去のやり取りを省く")
    add_out(p)

    p = sub.add_parser("cache-search", help="キャッシュからメールを探す (受信と送信。先に、新しい分だけを Outlook から取り込む)")
    p.add_argument("words", nargs="*", help="探す語 (件名・差出人・宛先・本文。スペースで並べると AND)。省略すると、条件に合う全部")
    p.add_argument("--folder", default="all", choices=["all", "inbox", "sent"], help="all: 受信と送信 (既定)、inbox: 受信トレイとその下、sent: 送信済み")
    p.add_argument("--since", help="この日時以降 (例: 2026-11-01、today)")
    p.add_argument("--until", help="この日まで (日付だけの指定は、その日を含む)")
    p.add_argument("--from", dest="sender", help="差出人 (名前かアドレスの一部)")
    p.add_argument("--to", help="宛先・Cc (名前かアドレスの一部)")
    p.add_argument("--subject", help="件名の一部")
    p.add_argument("--in-folder", help="フォルダのパスの一部 (例: 案件A)")
    p.add_argument("--thread", metavar="ID", help="この ID のメールと同じ件 (件名から RE: などを除いて一致) のやり取りを、受信も送信も、古い順に出す")
    p.add_argument("--limit", type=int, default=20, help=f"最大件数 (既定 20、上限 {DEFAULT_LIMIT_MAX})")
    p.add_argument("--preview", type=int, default=120, help="本文の抜粋の文字数 (検索語のあたり。0 で非表示)")
    p.add_argument("--no-sync", action="store_true", help="Outlook から取り込まず、キャッシュだけで探す")
    p.add_argument("--max-age-min", type=int, default=cache.DEFAULT_MAX_AGE_MIN, help=f"前回の取り込みがこの分数より古ければ、先に差分を取り込む (既定 {cache.DEFAULT_MAX_AGE_MIN})")
    add_out(p)

    p = sub.add_parser("cache-show", help="キャッシュから本文を読む (複数の ID を一度に。Outlook に接続しない)")
    p.add_argument("ids", nargs="+", help=f"cache-search で表示された ID (最大 {SHOW_LIMIT} 通)")
    p.add_argument("--max-chars", type=int, default=4000, help="1 通あたりの本文の最大文字数 (既定 4000)")
    p.add_argument("--no-quote", action="store_true", help="引用された過去のやり取りを省く")
    add_out(p)

    p = sub.add_parser("cache-sync", help="Outlook からキャッシュへ取り込む (キャッシュに無いメールだけ)")
    p.add_argument("--days", type=int, help=f"取り込む期間 (直近の日数。指定すると、以後もその期間を使う。最初は {cache.DEFAULT_DAYS})")
    p.add_argument("--full", action="store_true", help="期間の全部を見直し、Outlook で移動・削除されたメールをキャッシュに反映する")
    p.add_argument("--max-seconds", type=float, default=cache.DEFAULT_MAX_SECONDS, help=f"この秒数で止める (既定 {cache.DEFAULT_MAX_SECONDS}。続きは、もう一度実行する)")

    sub.add_parser("cache-status", help="キャッシュの通数、範囲、最終の取り込み、場所を見る (Outlook に接続しない)")

    p = sub.add_parser("reply-draft", help="返信の下書きを保存する (送信はしない)")
    p.add_argument("id", help="返信する元のメールの ID")
    p.add_argument("--body-file", required=True, help="返信の本文を書いた UTF-8 のファイル")
    p.add_argument("--reply-all", action="store_true", help="全員に返信する")
    p.add_argument("--dry-run", action="store_true", help="保存せず、内容だけ確認する")

    def add_root(p: argparse.ArgumentParser) -> None:
        p.add_argument("--root", default="inbox", choices=list(oc.ROOTS), help="パスの起点。inbox: 受信トレイの下 (既定)、mailbox: メールボックス全体の直下")

    p = sub.add_parser("folder-list", help="フォルダの一覧 (件数つき)")
    add_root(p)
    p.add_argument("--depth", type=int, default=2, help="何階層下まで見せるか。既定 2")
    add_out(p)

    p = sub.add_parser("folder-create", help="フォルダを作る (途中のフォルダも作る)")
    p.add_argument("path", help="作るフォルダのパス (例: 案件A/2026)")
    add_root(p)
    p.add_argument("--dry-run", action="store_true", help="作らず、内容だけ確認する")

    p = sub.add_parser("mail-move", help="メールを別のフォルダへ移動する (削除済み・迷惑メールへは不可。記録を残す)")
    p.add_argument("ids", nargs="+", help=f"移動するメールの ID (最大 {oc.MOVE_LIMIT} 通)")
    p.add_argument("--to", required=True, help="移動先のフォルダのパス ('.' は起点そのもの)")
    add_root(p)
    p.add_argument("--create-missing", action="store_true", help="移動先が無ければ作る")
    p.add_argument("--dry-run", action="store_true", help="移動せず、計画だけ確認する")
    add_out(p)

    p = sub.add_parser("mail-undo", help="移動したメールを元のフォルダへ戻す")
    p.add_argument("ids", nargs="*", help="移動後の新しい ID (mail-move の結果に表示される)")
    p.add_argument("--last", type=int, help="直近の移動を、新しいものから何通戻すか")
    p.add_argument("--dry-run", action="store_true", help="戻さず、計画だけ確認する")

    p = sub.add_parser("move-log", help="移動の記録を見る")
    p.add_argument("--limit", type=int, default=20)
    add_out(p)

    p = sub.add_parser("cal-list", help="予定の一覧")
    p.add_argument("--since", help="開始日 (既定: today)")
    p.add_argument("--until", help="終了日 (日付だけの指定は、その日を含む。既定: 開始日の 7 日後)")
    p.add_argument("--limit", type=int, default=50, help=f"最大件数 (既定 50、上限 {DEFAULT_LIMIT_MAX})")
    add_out(p)

    p = sub.add_parser("cal-create", help="予定を作る (保存だけ。招待は送らない)")
    p.add_argument("--subject", required=True)
    p.add_argument("--start", required=True, help="例: '2026-11-10 14:00'")
    p.add_argument("--end", help="終了日時。省略時は --duration-min を使う")
    p.add_argument("--duration-min", type=int, default=60, help="長さ (分)。既定 60")
    p.add_argument("--all-day", action="store_true", help="終日の予定にする")
    p.add_argument("--location")
    p.add_argument("--body-file", help="予定の本文を書いた UTF-8 のファイル")
    p.add_argument("--attendees", help="出席者のアドレス。; 区切り")
    p.add_argument("--reminder-min", type=int, default=15, help="何分前に通知するか。既定 15")
    p.add_argument("--dry-run", action="store_true", help="保存せず、内容だけ確認する")
    return parser


@contextmanager
def _use(client: Any) -> Iterator[Any]:
    yield client


CACHE_COMMANDS: dict[str, Callable[[argparse.Namespace, Callable[[], Any], TextIO], int | None]] = {
    "cache-sync": cmd_cache_sync, "cache-search": cmd_cache_search, "cache-show": cmd_cache_show, "cache-status": cmd_cache_status,
}


def main(argv: list[str] | None = None, client_factory: Callable[[], Any] | None = None, stdout: TextIO | None = None, stderr: TextIO | None = None) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    if stdout is None:
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8")  # Windows の標準出力の文字化けを防ぐ
    args = build_parser().parse_args(argv)
    factory = client_factory or oc.open_client
    try:
        if args.command == "reply-draft":
            cmd_reply_draft(args, factory, out)
        elif args.command == "cal-create":
            cmd_cal_create(args, factory, out)
        elif args.command in CACHE_COMMANDS:  # 接続は、必要なときだけ (cache-show と cache-status は接続しない)
            exit_code = CACHE_COMMANDS[args.command](args, factory, out)
            if exit_code:
                return int(exit_code)
        else:
            handlers = {
                "check": cmd_check, "mail-list": cmd_mail_list, "mail-get": cmd_mail_get, "cal-list": cmd_cal_list,
                "folder-list": cmd_folder_list, "folder-create": cmd_folder_create, "mail-move": cmd_mail_move,
                "mail-undo": cmd_mail_undo, "move-log": cmd_move_log,
            }
            with factory() as client:
                exit_code = handlers[args.command](args, client, out)
            if exit_code:
                return int(exit_code)
    except (ValueError, LookupError) as exc:
        err.write(f"エラー: {exc}\n")
        return 2
    except RuntimeError as exc:
        err.write(f"エラー: {exc}\n")
        return 3
    except Exception as exc:  # noqa: BLE001 - COM のエラーは型が多様
        err.write(f"エラー: Outlook の操作に失敗しました ({type(exc).__name__}: {exc})\n")
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
