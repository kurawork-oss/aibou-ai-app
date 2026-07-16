# tools.py — /chat に「実際に行動する」力を与える自己完結ツール層
# =====================================================================
# このモジュールは、AIモデルが会話の中で出力する「ツール呼び出しマーカー」を
# 解釈し、実際の副作用（記憶・通知・副業ジョブ投入・ノート保存など）を実行する。
#
# 設計方針（既存 config.py / main.py / agent.py と統一）:
#   * Streamlit / core.py には一切依存しない自己完結版（api/ 内で完結）。
#   * 設定や依存モジュールが欠けていても絶対に crash させず、人間向けの
#     分かりやすい結果文字列を返して優雅に縮退する（graceful degradation）。
#   * 追加認証（Google Sheets / Calendar 等）が必要なツールは含めない。
#     手持ち / 無料で動くもの（記憶・副業・Discord Webhook・ノート）だけを実装する。
#
# マーカープロトコル（既存 agent.py と同方式）:
#   モデルは返答の行頭で次の1行を“正確に”出力する：
#       <<<TOOL_CALL>>>{"tool": "ツール名", "params": { ... }}
#   extract_tool_call() がこれを安全に切り出してパースする。
# =====================================================================

import json
import os

# requests は通知(notify)で使う。未インストールでも import 自体は失敗させない。
try:
    import requests
except Exception:  # pragma: no cover
    requests = None

# 記憶・副業は api/ 内の自己完結モジュール（main.py と同じ参照の仕方）。
from memory_store import mem_add, mem_recall
import income

# vault は「ノート保存」用の任意モジュール。存在しない環境でも落ちないよう遅延的に扱う。
# （api/ 内に vault.py が無い場合は None になり、save_note は Supabase 直書きへ縮退する。）
try:
    import vault  # type: ignore
except Exception:  # pragma: no cover
    vault = None


# === マーカープロトコル =====================================================
# モデルが行頭で出力するツール呼び出しの目印（既存 agent.py と同一文字列）。
TOOL_CALL_MARKER = "<<<TOOL_CALL>>>"


# === ツール説明文（system prompt 用） =======================================
# 各ツールの「名前・用途・params」を箇条書きにした説明。/chat の system prompt に
# 差し込み、モデルにどんな行動が取れるかを伝えるためのドキュメント。
TOOLS_DOC = (
    "【利用可能なツール】\n"
    '- add_task: ToDo（タスク）を1件追加する。「〜しておいて」「〜を忘れないように」等の依頼で使う '
    '/ params: { "title": "タスク名", "content": "補足（任意）" }\n'
    '- add_agenda: 予定（カレンダー）を1件追加する。日付は YYYY-MM-DD、時刻は HH:MM。'
    '相対表現（明日・金曜など）は system に記載の今日の日付を基準に自分で計算して埋める '
    '/ params: { "title": "予定名", "date": "2026-07-17", "time": "15:00" }\n'
    '- list_state: 今のタスク・予定・副業ジョブ・未読通知の件数と概要を取得する（状況把握に使う） '
    "/ params: { }\n"
    '- create_document: Markdownのドキュメントを生成してAibou内に保存（ダウンロード可）。'
    'contentには完成した本文を自分で書いて渡す '
    '/ params: { "title": "見出し", "content": "Markdown本文" }\n'
    '- create_spreadsheet: 表データからCSVスプレッドシートを生成して保存（ダウンロード可）。'
    'rowsは1行目を見出しにした二次元配列 '
    '/ params: { "title": "表の名前", "rows": [["名前","金額"],["家賃","80000"]] }\n'
    '- google_sheet: Googleスプレッドシートを新規作成してrowsを書き込む（Google連携が必要）。'
    'クラウドで共有・編集したい表に使う '
    '/ params: { "title": "表の名前", "rows": [["名前","金額"],["家賃","80000"]] }\n'
    '- google_doc: Googleドキュメントを新規作成して本文を書く（Google連携が必要） '
    '/ params: { "title": "見出し", "content": "本文" }\n'
    '- calendar_add: Googleカレンダーに予定を追加する（Google連携が必要）。日付=YYYY-MM-DD、時刻=HH:MM '
    '/ params: { "title": "予定名", "date": "2026-07-20", "time": "15:00" }\n'
    '- calendar_list: Googleカレンダーの直近の予定を取得する '
    '/ params: { "days": 7 }\n'
    '- send_email: メールを送信する（機微な操作。承認が必要な場合あり） '
    '/ params: { "to": "宛先@example.com", "subject": "件名", "body": "本文" }\n'
    '- email_inbox: 受信トレイの最新メールを確認する '
    '/ params: { "limit": 5 }\n'
    '- web_search: Webを検索して最新情報の上位結果（タイトル/URL/要約）を得る '
    '/ params: { "query": "検索したいこと" }\n'
    '- web_read: 指定URLのページ本文を読み取る（記事や資料の要約に使う） '
    '/ params: { "url": "https://example.com/article" }\n'
    '- generate_image: プロンプトから画像を生成する（HOMEの生成物に保存される） '
    '/ params: { "prompt": "夕焼けの富士山、油絵風" }\n'
    '- schedule_add: きまった時刻に指示を自動実行する定期タスクを登録する。'
    'daysは "daily"（毎日）か "mon,wed,fri" のような曜日カンマ区切り '
    '/ params: { "instruction": "AIニュースを検索してメールで送る", "time": "07:00", "days": "daily" }\n'
    '- schedule_list: 登録済みの定期実行を一覧する / params: { }\n'
    '- notion_add: Notionのページ/データベースにメモ（新規ページ）を追記する '
    '/ params: { "title": "メモの見出し", "content": "本文" }\n'
    '- create_automation: ノーコード自動化フロー（Zapier風）を作る。stepsのtypeは '
    'ai_generate / notify / create_task のみ '
    '/ params: { "name": "フロー名", "steps": [{"type":"ai_generate","params":{"prompt":"..."}}] }\n'
    '- run_automation: 既存の自動化フローを名前かIDで実行する '
    '/ params: { "name": "フロー名", "input": "任意の入力" }\n'
    '- create_mission: オートパイロットのミッション（ゴールを自動でステップ分解）を作る '
    '/ params: { "objective": "達成したいゴール" }\n'
    '- remember: ユーザーが「覚えておいて」と言った事実・好み・重要情報を長期記憶に保存する '
    '/ params: { "content": "覚える内容（例：私の誕生日は6月12日）" }\n'
    '- recall: 長期記憶から過去の事実・文脈を検索して思い出す '
    '/ params: { "query": "思い出したいキーワード" }\n'
    '- enqueue_income: 副業オートメーションにテーマを投入し、各媒体メタデータを生成して承認待ちに積む '
    '/ params: { "theme": "生成テーマ（例：雪のロッジの環境音）" }\n'
    '- income_status: 副業ジョブの状況（承認待ち/承認済/完了/失敗 などの件数）を報告する '
    "/ params: { }\n"
    '- notify: 設定済みの通知先（LINE / Discord / Slack）へメッセージを送る '
    '/ params: { "message": "送信するメッセージ" }\n'
    '- save_note: ノート（Vault）にメモを保存する。ノートブックが無ければ作成する '
    '/ params: { "notebook": "保存先ノートブック名", "title": "タイトル", "content": "本文" }'
)


# === ツール呼び出しの抽出 ===================================================
def extract_tool_call(text: str):
    """
    テキストから <<<TOOL_CALL>>>{...} を取り出して (call_dict, preface_text) を返す。

    波括弧の深さを数えて“対応する閉じ括弧”まで正確に切り出すため、params に
    入れ子オブジェクトがあっても壊れない。文字列リテラル内の括弧も無視する。

    returns:
        (call_dict or None, preface_text)
        - call_dict : {"tool": ..., "params": {...}} のパース結果。失敗時 None。
        - preface_text : マーカー宣言を取り除いた、ユーザーに見せてよいテキスト。
    """
    text = text or ""
    idx = text.find(TOOL_CALL_MARKER)
    if idx == -1:
        # マーカー無し＝通常の会話。テキストはそのまま preface とする。
        return None, text

    # マーカー以降で最初の '{' を探す（ここから JSON 本体）。
    start = text.find("{", idx)
    if start == -1:
        return None, text

    # 波括弧の対応を数えながら JSON の終端 '}' を見つける。
    depth, end, in_str, esc = 0, -1, False, False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            # 文字列リテラル内：エスケープと閉じクォートだけを見る。
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end == -1:
        # 閉じ括弧が見つからない（途中で切れている等）＝呼び出し不成立。
        return None, text

    try:
        call = json.loads(text[start:end + 1])
    except Exception:
        # JSON として壊れている場合は呼び出し無しとして扱う。
        return None, text

    # マーカー＋JSON を取り除いた残りを、人間に見せる preface として整形する。
    visible = (text[:idx] + text[end + 1:]).replace(TOOL_CALL_MARKER, "").strip()
    return call, visible


# === 各ツールの実装（内部ヘルパー） =========================================
def _do_remember(params: dict) -> str:
    """重要な事実を長期記憶（importance=2）として保存する。"""
    content = (params.get("content") or "").strip()
    if not content:
        return "覚える内容が空です。"
    ok = mem_add("fact", content, importance=2)
    if not ok:
        return "記憶を保存できませんでした（記憶ストアが未設定の可能性があります）。"
    return f"覚えました：{content}"


def _do_recall(params: dict) -> str:
    """長期記憶から関連する文脈を想起して返す。"""
    query = (params.get("query") or "").strip()
    block = mem_recall(query)
    return block or "関連する記憶は見つかりませんでした。"


def _do_enqueue_income(params: dict) -> str:
    """副業オートメーションにテーマを投入し、承認待ちジョブとして積む。"""
    theme = (params.get("theme") or "").strip()
    if not theme:
        return "テーマが空です。"
    job = income.enqueue(theme)
    # enqueue は dict を返す（成功時はジョブ、失敗時は {"error": ...}）。
    if isinstance(job, dict):
        if job.get("error"):
            return f"テーマの投入に失敗しました：{job['error']}"
        if job.get("warning"):
            return f"「{theme}」を生成しましたが保存で問題がありました：{job['warning']}"
    return f"「{theme}」を承認待ちジョブとして投入しました。"


def _do_income_status(_params: dict) -> str:
    """副業ジョブをステータス別に集計して文章で報告する。"""
    jobs = income.list_jobs(limit=1000) or []
    if not jobs:
        return "副業ジョブはまだありません（または記憶ストアが未設定です）。"
    counts: dict = {}
    for j in jobs:
        st = (j.get("status") or "unknown").strip() or "unknown"
        counts[st] = counts.get(st, 0) + 1
    total = len(jobs)
    # よく使うステータスは日本語ラベルで読みやすく表示する。
    labels = {
        "pending": "承認待ち",
        "approved": "承認済",
        "rejected": "却下",
        "completed": "完了",
        "failed": "失敗",
    }
    parts = []
    for key, label in labels.items():
        if counts.get(key):
            parts.append(f"{label} {counts[key]}件")
    # 既知ラベル外のステータスもこぼさず加える。
    for key, n in counts.items():
        if key not in labels:
            parts.append(f"{key} {n}件")
    detail = "、".join(parts) if parts else "内訳なし"
    return f"副業ジョブの状況：合計 {total}件（{detail}）。"


def _do_notify(params: dict) -> str:
    """設定済みの通知先（LINE / Discord / Slack）へメッセージを送る。
    どのチャンネルも未設定でも、アプリ内通知ログには必ず残るので優雅に縮退する。"""
    message = (params.get("message") or "").strip()
    if not message:
        return "送信するメッセージが空です。"
    try:
        import notify
        res = notify.notify_all(message[:1900])
    except Exception as e:
        return f"通知の送信に失敗しました：{e}"
    sent = res.get("sent") or []
    if sent:
        return f"{'・'.join(sent)} に通知を送信しました。"
    # 外部チャンネル未設定でも log_internal 済み → ホームの通知に出る。
    return "外部の通知先（LINE / Discord / Slack）が未設定のため、アプリ内通知に記録しました。"


def _do_add_task(params: dict) -> str:
    """ToDo（タスク）を1件追加する。"""
    title = (params.get("title") or "").strip()
    if not title:
        return "タスクのタイトルが空です。"
    content = (params.get("content") or "").strip()
    try:
        import tasks
        t = tasks.create_task(title, content)
    except Exception as e:
        return f"タスクの作成に失敗しました：{e}"
    if isinstance(t, dict) and t.get("error"):
        return f"タスクの作成に失敗しました：{t['error']}"
    return f"タスクを追加しました：{title}"


def _do_add_agenda(params: dict) -> str:
    """予定（カレンダー）を1件追加する。date=YYYY-MM-DD, time=HH:MM。"""
    title = (params.get("title") or "").strip()
    if not title:
        return "予定のタイトルが空です。"
    date = (params.get("date") or "").strip()
    time = (params.get("time") or "").strip()
    try:
        import agenda
        ev = agenda.add_event(title, date, time)
    except Exception as e:
        return f"予定の追加に失敗しました：{e}"
    if isinstance(ev, dict) and ev.get("error"):
        return f"予定の追加に失敗しました：{ev['error']}"
    when = " ".join(x for x in (date, time) if x) or "日時未指定"
    return f"予定を追加しました：{when} {title}"


def _do_list_state(_params: dict) -> str:
    """今のタスク・予定・副業・未読通知の状況を1文にまとめて返す（状況把握用）。"""
    parts: list = []
    try:
        import tasks
        all_tasks = tasks.list_tasks(None, 1000) or []
        open_tasks = [t for t in all_tasks if (t.get("status") or "pending") in ("pending", "in_progress")]
        parts.append(f"未完了タスク {len(open_tasks)}件")
        for t in open_tasks[:5]:
            parts.append(f"・{t.get('title', '(無題)')}")
    except Exception:
        pass
    try:
        import agenda
        events = agenda.list_events(1000) or []
        parts.append(f"予定 {len(events)}件")
        for e in events[:5]:
            when = " ".join(x for x in (e.get("date", ""), e.get("time", "")) if x)
            parts.append(f"・{when} {e.get('title', '(無題)')}".strip())
    except Exception:
        pass
    try:
        pending = len(income.list_jobs("pending", 1000) or [])
        if pending:
            parts.append(f"副業の承認待ち {pending}件")
    except Exception:
        pass
    try:
        import notify
        unread = notify.unread_count()
        if unread:
            parts.append(f"未読通知 {unread}件")
    except Exception:
        pass
    return "現在の状況：\n" + "\n".join(parts) if parts else "現在、記録されたタスク・予定はありません。"


def _do_save_note(params: dict) -> str:
    """ノート（Vault）にメモを保存する。
    vault モジュールがあれば create_notebook（無ければ既存検索）→ add_text を使う。
    vault が無い環境では Supabase の vault_notebooks へ直接書き込んで縮退する。"""
    notebook = (params.get("notebook") or "").strip() or "Inbox"
    title = (params.get("title") or "").strip() or "無題"
    content = (params.get("content") or "").strip()
    if not content:
        return "保存する本文が空です。"

    # 1) vault モジュールがあればそれを使う（仕様どおりの優先パス）。
    if vault is not None:
        try:
            nb_id = None
            # 既存ノートブックを探す（list_notebooks があれば名前一致で再利用）。
            if hasattr(vault, "list_notebooks"):
                for nb in (vault.list_notebooks() or []):
                    name = nb.get("name") if isinstance(nb, dict) else getattr(nb, "name", None)
                    if name == notebook:
                        nb_id = nb.get("id") if isinstance(nb, dict) else getattr(nb, "id", None)
                        break
            # 無ければ作成する。
            if nb_id is None and hasattr(vault, "create_notebook"):
                created = vault.create_notebook(notebook)
                nb_id = created.get("id") if isinstance(created, dict) else getattr(created, "id", created)
            # 本文を追記する。
            if hasattr(vault, "add_text"):
                if nb_id is not None:
                    vault.add_text(nb_id, title, content)
                else:
                    vault.add_text(notebook, title, content)
                return f"ノート「{notebook}」に保存しました：{title}"
        except Exception as e:
            return f"ノート保存に失敗しました（vault）: {e}"

    # 2) フォールバック：Supabase の vault_notebooks へ直接1行追加する。
    try:
        import config
        c = config.get_supabase()
        if not c:
            return "ノートを保存できませんでした（Vault も Supabase も未設定です）。"
        c.table("vault_notebooks").insert({
            "name": notebook,
            "docs": {title: content},
            "chat": [],
        }).execute()
        return f"ノート「{notebook}」に保存しました：{title}"
    except Exception as e:
        return f"ノート保存に失敗しました（vault_notebooks テーブル未作成の可能性）: {e}"


def _rows_to_csv(rows) -> str:
    """[[...],[...]] や ["a","b"] を正しくクォートした CSV 文字列にする。"""
    import csv
    import io
    buf = io.StringIO()
    w = csv.writer(buf)
    for r in rows:
        if isinstance(r, (list, tuple)):
            w.writerow(["" if c is None else str(c) for c in r])
        else:
            w.writerow([str(r)])
    return buf.getvalue()


def _do_create_document(params: dict) -> str:
    """Markdown ドキュメントを生成して Aibou 内に保存（ダウンロード可）。"""
    title = (params.get("title") or "").strip()
    content = (params.get("content") or "").strip()
    if not content:
        return "ドキュメントの本文が空です。"
    try:
        import artifacts
        art = artifacts.create("document", title or "ドキュメント", content, "text/markdown")
    except Exception as e:
        return f"ドキュメントの作成に失敗しました：{e}"
    return f"ドキュメント「{art.get('title')}」を作成しました。HOMEの『生成物』からダウンロードできます。"


def _do_create_spreadsheet(params: dict) -> str:
    """表データ（rows or csv）から CSV を生成して Aibou 内に保存（ダウンロード可）。"""
    title = (params.get("title") or "").strip()
    rows = params.get("rows")
    csv_text = (params.get("csv") or "").strip()
    if isinstance(rows, list) and rows:
        csv_text = _rows_to_csv(rows)
    if not csv_text:
        return "スプレッドシートの中身（rows か csv）が空です。"
    try:
        import artifacts
        art = artifacts.create("spreadsheet", title or "スプレッドシート", csv_text, "text/csv")
    except Exception as e:
        return f"スプレッドシートの作成に失敗しました：{e}"
    n = csv_text.strip().count("\n") + 1
    return f"スプレッドシート「{art.get('title')}」を作成しました（{n}行・CSV）。HOMEの『生成物』からダウンロードできます。"


def _do_google_sheet(params: dict) -> str:
    """Google スプレッドシートを作成して rows を書き込み、共有URLを返す。"""
    title = (params.get("title") or "").strip()
    rows = params.get("rows")
    if not (isinstance(rows, list) and rows):
        return "スプレッドシートの行データ（rows）が空です。"
    try:
        import gservice
        res = gservice.create_sheet(title or "スプレッドシート", rows)
    except Exception as e:
        return f"Googleスプレッドシートの作成に失敗しました：{e}"
    if not res.get("ok"):
        return f"Googleスプレッドシートを作成できませんでした：{res.get('error')}"
    return f"Googleスプレッドシート「{title or '無題'}」を作成しました：{res.get('url')}"


def _do_google_doc(params: dict) -> str:
    """Google ドキュメントを作成して本文を挿入し、共有URLを返す。"""
    title = (params.get("title") or "").strip()
    content = (params.get("content") or "").strip()
    if not content:
        return "ドキュメントの本文が空です。"
    try:
        import gservice
        res = gservice.create_doc(title or "ドキュメント", content)
    except Exception as e:
        return f"Googleドキュメントの作成に失敗しました：{e}"
    if not res.get("ok"):
        return f"Googleドキュメントを作成できませんでした：{res.get('error')}"
    return f"Googleドキュメント「{title or '無題'}」を作成しました：{res.get('url')}"


def _do_calendar_add(params: dict) -> str:
    """Google カレンダーに予定を追加する。"""
    title = (params.get("title") or "").strip()
    date = (params.get("date") or "").strip()
    time = (params.get("time") or "").strip()
    if not (title and date):
        return "予定のタイトルと日付(date=YYYY-MM-DD)が必要です。"
    try:
        import gservice
        res = gservice.create_event(title, date, time, params.get("duration_min") or 60)
    except Exception as e:
        return f"カレンダー登録に失敗しました：{e}"
    if not res.get("ok"):
        return f"カレンダーに登録できませんでした：{res.get('error')}"
    when = f"{date}{(' ' + time) if time else ''}"
    return f"Googleカレンダーに「{title}」({when})を登録しました：{res.get('url')}"


def _do_calendar_list(params: dict) -> str:
    """Google カレンダーの直近予定を取得する。"""
    try:
        import gservice
        res = gservice.list_events(params.get("days") or 7)
    except Exception as e:
        return f"カレンダーの取得に失敗しました：{e}"
    if not res.get("ok"):
        return f"カレンダーを取得できませんでした：{res.get('error')}"
    items = res.get("items") or []
    if not items:
        return "直近の予定はありません。"
    lines = [f"・{it.get('start', '')} {it.get('title', '')}" for it in items[:15]]
    return "直近の予定：\n" + "\n".join(lines)


def _do_send_email(params: dict) -> str:
    """メールを送信する（SMTP）。※機微な操作 → 承認モード対象。"""
    to = (params.get("to") or "").strip()
    subject = (params.get("subject") or "").strip()
    body = (params.get("body") or "").strip()
    if not (to and (subject or body)):
        return "宛先(to)と本文(または件名)が必要です。"
    try:
        import email_svc
        res = email_svc.send(to, subject, body)
    except Exception as e:
        return f"メール送信に失敗しました：{e}"
    if not res.get("ok"):
        return f"メールを送信できませんでした：{res.get('error')}"
    return f"{to} にメールを送信しました（件名：{subject or '(なし)'}）。"


def _do_email_inbox(params: dict) -> str:
    """受信トレイの最新メールを要約して返す。"""
    try:
        import email_svc
        res = email_svc.inbox(params.get("limit") or 5)
    except Exception as e:
        return f"受信メールの取得に失敗しました：{e}"
    if not res.get("ok"):
        return f"受信メールを取得できませんでした：{res.get('error')}"
    items = res.get("items") or []
    if not items:
        return "受信トレイに新しいメールはありません。"
    lines = []
    for m in items:
        lines.append(f"・{m.get('from', '')}｜{m.get('subject', '(件名なし)')}\n  {m.get('snippet', '')}")
    return "最新メール：\n" + "\n".join(lines)


def _do_web_search(params: dict) -> str:
    """Webを検索して上位結果を返す。"""
    query = (params.get("query") or params.get("q") or "").strip()
    if not query:
        return "検索クエリ(query)が空です。"
    try:
        import web
        res = web.web_search(query, params.get("n") or 5)
    except Exception as e:
        return f"Web検索に失敗しました：{e}"
    if not res.get("ok"):
        return f"Web検索できませんでした：{res.get('error')}"
    lines = []
    for i, r in enumerate(res.get("results", []), start=1):
        lines.append(f"{i}. {r.get('title', '')}\n   {r.get('url', '')}\n   {r.get('snippet', '')}")
    return f"「{query}」の検索結果：\n" + "\n".join(lines)


def _do_web_read(params: dict) -> str:
    """URLのページ本文を取得して返す。"""
    url = (params.get("url") or "").strip()
    if not url:
        return "URLが空です。"
    try:
        import web
        res = web.web_read(url, params.get("max_chars") or 4000)
    except Exception as e:
        return f"ページの取得に失敗しました：{e}"
    if not res.get("ok"):
        return f"ページを取得できませんでした：{res.get('error')}"
    title = res.get("title") or ""
    return f"【{title}】\n{res.get('text', '')}"


def _do_generate_image(params: dict) -> str:
    """プロンプトから画像を生成して保存（HOMEの生成物で閲覧）。"""
    prompt = (params.get("prompt") or "").strip()
    if not prompt:
        return "画像の指示(prompt)が空です。"
    try:
        import imagegen
        res = imagegen.generate(prompt, params.get("width") or 1024, params.get("height") or 1024)
    except Exception as e:
        return f"画像生成に失敗しました：{e}"
    if not res.get("ok"):
        return f"画像を生成できませんでした：{res.get('error')}"
    url = res.get("url")
    try:
        import artifacts
        artifacts.create("image", prompt[:60], url, "image/url")
    except Exception:
        pass
    return f"画像を生成しました：{url}（HOMEの『生成物』からも見られます）"


_DAY_JP = {"mon": "月", "tue": "火", "wed": "水", "thu": "木", "fri": "金", "sat": "土", "sun": "日"}


def _days_label(days: str) -> str:
    days = (days or "daily").strip().lower()
    if days == "daily":
        return "毎日"
    return "毎週" + "・".join(_DAY_JP.get(d.strip(), d) for d in days.split(",") if d.strip())


def _do_schedule_add(params: dict) -> str:
    """毎日 or 曜日指定の時刻に指示を自動実行する定期タスクを登録する。"""
    instruction = (params.get("instruction") or "").strip()
    time = (params.get("time") or "08:00").strip()
    days = params.get("days") or "daily"
    if not instruction:
        return "定期実行する指示(instruction)が空です。"
    try:
        import scheduler
        s = scheduler.add(instruction, time, days)
    except Exception as e:
        return f"定期実行の登録に失敗しました：{e}"
    if isinstance(s, dict) and s.get("error"):
        return f"定期実行の登録に失敗しました：{s['error']}"
    return f"{_days_label(s.get('days'))} {s.get('time')} に「{instruction}」を実行する定期タスクを登録しました。"


def _do_schedule_list(_params: dict) -> str:
    """登録済みの定期実行を一覧する。"""
    try:
        import scheduler
        items = scheduler.list_schedules(100)
    except Exception as e:
        return f"定期実行の取得に失敗しました：{e}"
    if not items:
        return "登録された定期実行はありません。"
    return "定期実行：\n" + "\n".join(
        f"・{_days_label(s.get('days'))} {s.get('time')} — {s.get('instruction')}" for s in items[:15]
    )


def _notion_blocks(content: str) -> list:
    """本文を Notion の paragraph ブロック配列に変換する（行=段落）。"""
    blocks = []
    for line in (content or "").split("\n"):
        line = line[:1900]
        blocks.append({
            "object": "block",
            "type": "paragraph",
            "paragraph": {"rich_text": ([{"type": "text", "text": {"content": line}}] if line else [])},
        })
        if len(blocks) >= 90:  # children は最大100。余裕をもって打ち切る。
            break
    return blocks or [{"object": "block", "type": "paragraph", "paragraph": {"rich_text": []}}]


def _notion_result(r, title: str) -> str:
    if 200 <= r.status_code < 300:
        return f"Notionに「{title}」を追記しました。"
    if r.status_code in (401, 403):
        return ("Notionの認証に失敗しました。トークンが正しいか、対象のページ/データベースを"
                "インテグレーションに『共有（Connections）』しているか確認してください。")
    try:
        msg = (r.json() or {}).get("message", "")
    except Exception:
        msg = (r.text or "")[:200]
    return f"Notionへの追記に失敗しました（{r.status_code}）：{msg}"


def _do_notion_add(params: dict) -> str:
    """Notion のページ/データベースにメモ（ページ）を追記する。"""
    title = (params.get("title") or "").strip()
    content = (params.get("content") or "").strip()
    if not title and not content:
        return "Notionに書く内容が空です。"
    if requests is None:
        return "requests が無いためNotionに送れません。"
    import keychain
    token = (keychain.get_key("NOTION_TOKEN") or "").strip()
    parent = (params.get("parent") or keychain.get_key("NOTION_PARENT_ID") or "").strip()
    if not token:
        return "NOTION_TOKEN が未設定です。KEYCHAIN で設定してください（発行手順は各欄の「?」参照）。"
    if not parent:
        return "NOTION_PARENT_ID（追記先のページ or データベースID）が未設定です。KEYCHAIN で設定してください。"

    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }
    children = _notion_blocks(content)
    title = (title or "メモ")[:200]

    # 1) parent がデータベースなら、タイトル型プロパティ名を調べて1行追加する。
    try:
        db = requests.get(f"https://api.notion.com/v1/databases/{parent}", headers=headers, timeout=30)
        if db.status_code == 200:
            props = (db.json() or {}).get("properties", {}) or {}
            title_key = next((k for k, v in props.items() if (v or {}).get("type") == "title"), "Name")
            body = {
                "parent": {"database_id": parent},
                "properties": {title_key: {"title": [{"text": {"content": title}}]}},
                "children": children,
            }
            return _notion_result(requests.post("https://api.notion.com/v1/pages", headers=headers, json=body, timeout=30), title)
    except Exception:
        pass

    # 2) それ以外は parent をページとみなし、子ページとして追記する。
    try:
        body = {
            "parent": {"page_id": parent},
            "properties": {"title": {"title": [{"text": {"content": title}}]}},
            "children": children,
        }
        return _notion_result(requests.post("https://api.notion.com/v1/pages", headers=headers, json=body, timeout=30), title)
    except Exception as e:
        return f"Notionへの追記に失敗しました：{e}"


def _do_create_automation(params: dict) -> str:
    """ノーコード自動化フロー（Zapier風）を作成する。steps=[{type,name,params}]。
    type は ai_generate / notify / create_task。"""
    name = (params.get("name") or "").strip()
    if not name:
        return "自動化フローの名前が空です。"
    steps = params.get("steps") or []
    try:
        import automations
        flow = automations.create_flow(name, params.get("trigger"), steps)
    except Exception as e:
        return f"自動化の作成に失敗しました：{e}"
    if isinstance(flow, dict) and flow.get("error"):
        return f"自動化の作成に失敗しました：{flow['error']}"
    n = len(flow.get("steps") or [])
    return f"自動化フロー「{name}」を作成しました（{n}ステップ）。BOARDモードから実行・編集できます。"


def _do_run_automation(params: dict) -> str:
    """名前またはIDで自動化フローを実行する。"""
    key = (params.get("name") or params.get("id") or "").strip()
    if not key:
        return "実行する自動化フローの名前かIDが必要です。"
    try:
        import automations
        flows = automations.list_flows(1000) or []
        target = next((f for f in flows if f.get("id") == key or (f.get("name") or "").lower() == key.lower()), None)
        if not target:
            return f"「{key}」という自動化フローは見つかりませんでした。"
        res = automations.run_flow(target["id"], params.get("input") or "")
    except Exception as e:
        return f"自動化の実行に失敗しました：{e}"
    if isinstance(res, dict) and res.get("error"):
        return f"自動化の実行に失敗しました：{res['error']}"
    return f"自動化フロー「{target.get('name')}」を実行しました。"


def _do_create_mission(params: dict) -> str:
    """オートパイロットのミッション（ゴールを自動でステップ分解）を作成する。"""
    goal = (params.get("objective") or params.get("goal") or "").strip()
    if not goal:
        return "ミッションの目標が空です。"
    try:
        import autopilot
        m = autopilot.create_mission(goal)
    except Exception as e:
        return f"ミッションの作成に失敗しました：{e}"
    if isinstance(m, dict) and m.get("error"):
        return f"ミッションの作成に失敗しました：{m['error']}"
    n = len(m.get("steps") or [])
    return f"オートパイロットのミッション「{goal}」を作成しました（{n}ステップに分解）。AUTOモードで進められます。"


# ツール名 → 実装関数のディスパッチ表。
_DISPATCH = {
    "add_task": _do_add_task,
    "add_agenda": _do_add_agenda,
    "list_state": _do_list_state,
    "create_document": _do_create_document,
    "create_spreadsheet": _do_create_spreadsheet,
    "google_sheet": _do_google_sheet,
    "google_doc": _do_google_doc,
    "calendar_add": _do_calendar_add,
    "calendar_list": _do_calendar_list,
    "send_email": _do_send_email,
    "email_inbox": _do_email_inbox,
    "web_search": _do_web_search,
    "web_read": _do_web_read,
    "generate_image": _do_generate_image,
    "schedule_add": _do_schedule_add,
    "schedule_list": _do_schedule_list,
    "notion_add": _do_notion_add,
    "create_automation": _do_create_automation,
    "run_automation": _do_run_automation,
    "create_mission": _do_create_mission,
    "remember": _do_remember,
    "recall": _do_recall,
    "enqueue_income": _do_enqueue_income,
    "income_status": _do_income_status,
    "notify": _do_notify,
    "save_note": _do_save_note,
}


# === ツール実行のエントリポイント ===========================================
def execute_tool(name: str, params: dict) -> str:
    """選択されたツールを実行し、人間向けの結果文字列を返す。絶対に raise しない。"""
    params = params or {}
    handler = _DISPATCH.get((name or "").strip())
    if handler is None:
        return f"不明なツールです：{name}"
    try:
        return handler(params)
    except Exception as e:
        # どのツールでも、想定外の例外は結果文字列に丸めて返す（crash させない）。
        return f"ツール実行エラー（{name}）：{e}"
