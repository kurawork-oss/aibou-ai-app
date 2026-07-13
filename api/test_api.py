"""
api/test_api.py — FastAPI エンドポイントのテスト
外部サービス（Gemini/Supabase）なしで全エンドポイントの応答を検証する。
"""

import pytest
from fastapi.testclient import TestClient

# 外部サービスが無い状態でも import できることを確認
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from main import app

client = TestClient(app)


# ── /health ────────────────────────────────────────────────────────
def test_health_returns_ok():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


# ── /chat (Gemini未設定→SSEエラー) ──────────────────────────────────
def test_chat_without_api_key():
    r = client.post("/chat", json={"message": "hello"})
    assert r.status_code == 200
    # SSE stream returned
    body = r.text
    assert "data:" in body or "error" in body.lower() or "done" in body


# ── /vision ─────────────────────────────────────────────────────────
def test_vision_without_api_key():
    r = client.post("/vision", json={
        "prompt": "test",
        "image_base64": "aGVsbG8=",  # base64("hello")
        "mime": "image/jpeg"
    })
    # Should return 503 or 500 (no Gemini key), never crash
    assert r.status_code in (200, 400, 500, 503)
    data = r.json()
    assert "error" in data or "text" in data


# ── /tts ─────────────────────────────────────────────────────────────
def test_tts_missing_edge_tts():
    """edge-tts が無い環境でも crash しない。"""
    r = client.post("/tts", json={"text": "テスト", "voice": "ja-JP-KeitaNeural"})
    assert r.status_code == 200
    data = r.json()
    assert "audio_base64" in data  # "" でも ok


# ── /tts empty text ───────────────────────────────────────────────────
def test_tts_empty_text():
    r = client.post("/tts", json={"text": ""})
    assert r.status_code == 200
    data = r.json()
    assert data.get("audio_base64") == ""
    assert "error" in data


# ── /memory ───────────────────────────────────────────────────────────
def test_memory_add_without_supabase():
    r = client.post("/memory/add", json={"role": "user", "content": "test memory"})
    assert r.status_code == 200
    data = r.json()
    assert "ok" in data  # ok=False is fine (Supabase not configured)


def test_memory_recent_without_supabase():
    r = client.get("/memory/recent")
    assert r.status_code == 200
    data = r.json()
    assert "items" in data
    assert isinstance(data["items"], list)


# ── /forge/generate ───────────────────────────────────────────────────
def test_forge_generate_without_gemini():
    r = client.post("/forge/generate", json={"kind": "app", "prompt": "家計簿アプリ"})
    # 503 (Gemini not configured) or 200 with error field
    assert r.status_code in (200, 503)
    data = r.json()
    assert "error" in data or "code" in data or "kind" in data


def test_forge_invalid_kind():
    r = client.post("/forge/generate", json={"kind": "invalid_kind", "prompt": "test"})
    assert r.status_code in (200, 400, 422, 503)


# ── /income ───────────────────────────────────────────────────────────
def test_income_summary_without_supabase():
    r = client.get("/income/summary")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, dict)


def test_income_jobs_without_supabase():
    r = client.get("/income/jobs")
    assert r.status_code == 200
    data = r.json()
    assert "items" in data
    assert isinstance(data["items"], list)


def test_income_enqueue_without_gemini():
    r = client.post("/income/enqueue", json={"theme": "テスト"})
    assert r.status_code in (200, 503)
    data = r.json()
    assert isinstance(data, dict)


def test_income_approve_not_found():
    r = client.post("/income/approve", json={"id": "nonexistent-id"})
    assert r.status_code == 200
    assert r.json().get("ok") in (True, False)


def test_income_reject_not_found():
    r = client.post("/income/reject", json={"id": "nonexistent-id"})
    assert r.status_code == 200
    assert r.json().get("ok") in (True, False)


# ── /vault ────────────────────────────────────────────────────────────
def test_vault_notebooks_without_supabase():
    r = client.get("/vault/notebooks")
    assert r.status_code == 200
    data = r.json()
    assert "items" in data
    assert isinstance(data["items"], list)


def test_vault_create_empty_name():
    r = client.post("/vault/create", json={"name": ""})
    # Should return error dict (400 or 200 with error)
    data = r.json()
    assert "error" in data or "id" in data


def test_vault_create_without_supabase():
    r = client.post("/vault/create", json={"name": "テストノート"})
    assert r.status_code in (200, 503)
    data = r.json()
    assert "error" in data or "id" in data


def test_vault_add_without_supabase():
    r = client.post("/vault/add", json={
        "notebook_id": "fake-id",
        "title": "テスト資料",
        "content": "テスト内容"
    })
    assert r.status_code == 200
    data = r.json()
    assert "ok" in data or "error" in data


def test_vault_query_without_supabase():
    r = client.post("/vault/query", json={
        "notebook_id": "fake-id",
        "question": "テスト質問"
    })
    assert r.status_code == 200
    data = r.json()
    assert "answer" in data or "error" in data


# ── /briefing ─────────────────────────────────────────────────────────
def test_briefing_without_gemini():
    r = client.get("/briefing")
    assert r.status_code == 200
    data = r.json()
    assert "text" in data
    assert isinstance(data["text"], str)


# ── /video ────────────────────────────────────────────────────────────
def test_video_no_renderer():
    r = client.post("/video", json={
        "scenes": [{"narration": "テスト", "visual": "テスト"}],
        "image_prompt": ""
    })
    # renderer.py が無ければ 503
    assert r.status_code in (200, 503)
    data = r.json()
    assert "video_base64" in data or "error" in data


# ── /tasks (新機能) ────────────────────────────────────────────────────
def test_tasks_list_empty():
    r = client.get("/tasks")
    assert r.status_code == 200
    data = r.json()
    assert "items" in data
    assert isinstance(data["items"], list)


def test_tasks_create_and_list():
    # Create
    r = client.post("/tasks", json={"title": "テストタスク", "content": "内容"})
    assert r.status_code == 200
    task = r.json()
    assert "id" in task
    assert task["title"] == "テストタスク"
    assert task["status"] == "pending"

    task_id = task["id"]

    # List — should appear
    r2 = client.get("/tasks")
    assert r2.status_code == 200
    ids = [t["id"] for t in r2.json()["items"]]
    assert task_id in ids


def test_tasks_create_empty_title():
    r = client.post("/tasks", json={"title": "", "content": ""})
    assert r.status_code in (400, 422)
    data = r.json()
    assert "error" in data or "detail" in data


def test_tasks_update_status():
    # Create first
    r = client.post("/tasks", json={"title": "更新テスト"})
    assert r.status_code == 200
    task_id = r.json()["id"]

    # Update status
    r2 = client.patch(f"/tasks/{task_id}", json={"status": "in_progress"})
    assert r2.status_code == 200
    updated = r2.json()
    assert updated["status"] == "in_progress"


def test_tasks_update_response():
    r = client.post("/tasks", json={"title": "返答テスト"})
    task_id = r.json()["id"]

    r2 = client.patch(f"/tasks/{task_id}", json={"response": "テスト返答"})
    assert r2.status_code == 200
    assert r2.json()["response"] == "テスト返答"


def test_tasks_delete():
    r = client.post("/tasks", json={"title": "削除テスト"})
    task_id = r.json()["id"]

    r2 = client.delete(f"/tasks/{task_id}")
    assert r2.status_code == 200
    assert r2.json()["ok"] is True

    # Should not appear in list
    r3 = client.get("/tasks")
    ids = [t["id"] for t in r3.json()["items"]]
    assert task_id not in ids


def test_tasks_filter_by_status():
    # Create pending and completed tasks
    client.post("/tasks", json={"title": "pending_filter_test", "status": "pending"})
    client.post("/tasks", json={"title": "completed_filter_test", "status": "completed"})

    r = client.get("/tasks?status=completed")
    assert r.status_code == 200
    for t in r.json()["items"]:
        assert t["status"] == "completed"


# ── /studio/ais (新機能) ───────────────────────────────────────────────
def test_studio_ais_list_empty_initially():
    r = client.get("/studio/ais")
    assert r.status_code == 200
    assert "items" in r.json()


def test_studio_create_ai():
    r = client.post("/studio/ais", json={
        "name": "テストAI",
        "persona": "テストペルソナ",
        "model": "gemini-2.5-flash",
        "rules": "常に日本語で返答すること"
    })
    assert r.status_code == 200
    ai = r.json()
    assert "id" in ai
    assert ai["name"] == "テストAI"
    assert ai["model"] == "gemini-2.5-flash"


def test_studio_create_ai_empty_name():
    r = client.post("/studio/ais", json={"name": ""})
    assert r.status_code in (400, 422)


def test_studio_delete_ai():
    r = client.post("/studio/ais", json={"name": "削除AI"})
    ai_id = r.json()["id"]

    r2 = client.delete(f"/studio/ais/{ai_id}")
    assert r2.status_code == 200
    assert r2.json()["ok"] is True

    # Should not be in list
    r3 = client.get("/studio/ais")
    ids = [a["id"] for a in r3.json()["items"]]
    assert ai_id not in ids


# ── /studio/workflows (新機能) ─────────────────────────────────────────
def test_studio_workflows_list():
    r = client.get("/studio/workflows")
    assert r.status_code == 200
    assert "items" in r.json()


def test_studio_create_workflow():
    r = client.post("/studio/workflows", json={
        "name": "テストワークフロー",
        "steps": [
            {"name": "Step 1", "prompt": "{input}を要約してください"},
            {"name": "Step 2", "prompt": "{input}を箇条書きにしてください"}
        ]
    })
    assert r.status_code == 200
    wf = r.json()
    assert "id" in wf
    assert wf["name"] == "テストワークフロー"
    assert len(wf["steps"]) == 2


def test_studio_create_workflow_empty_name():
    r = client.post("/studio/workflows", json={"name": "", "steps": []})
    assert r.status_code in (400, 422)


def test_studio_delete_workflow():
    r = client.post("/studio/workflows", json={
        "name": "削除ワークフロー",
        "steps": [{"prompt": "test"}]
    })
    wf_id = r.json()["id"]

    r2 = client.delete(f"/studio/workflows/{wf_id}")
    assert r2.status_code == 200
    assert r2.json()["ok"] is True


def test_studio_run_workflow_not_found():
    r = client.post("/studio/workflows/nonexistent-id/run", json={"input": "test"})
    assert r.status_code in (503, 404)
    assert "error" in r.json()


def test_studio_run_workflow_without_gemini():
    # Create workflow first
    r = client.post("/studio/workflows", json={
        "name": "実行テスト",
        "steps": [{"name": "S1", "prompt": "{input}を分析してください"}]
    })
    wf_id = r.json()["id"]

    # Run it — without Gemini key should return error (not crash)
    r2 = client.post(f"/studio/workflows/{wf_id}/run", json={"input": "テスト入力"})
    assert r2.status_code in (200, 503)
    data = r2.json()
    assert "error" in data or "final_output" in data


# ── /keys（APIキー保管庫） ──────────────────────────────────────────
def test_keys_list_returns_known_keys():
    r = client.get("/keys")
    assert r.status_code == 200
    data = r.json()
    assert "items" in data
    names = [k["name"] for k in data["items"]]
    assert "GEMINI_API_KEY" in names
    assert "LINE_NOTIFY_TOKEN" in names
    # フル値は決して返らない（masked / set のみ）
    for k in data["items"]:
        assert "masked" in k and "set" in k
        assert "value" not in k


def test_keys_set_and_masked():
    r = client.post("/keys", json={"name": "TEST_KEY", "value": "abcdef123456"})
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["set"] is True
    assert data["masked"] != "abcdef123456"
    assert data["masked"].startswith("ab")
    assert data["masked"].endswith("56")

    r2 = client.get("/keys")
    item = next(k for k in r2.json()["items"] if k["name"] == "TEST_KEY")
    assert item["set"] is True


def test_keys_set_empty_name():
    r = client.post("/keys", json={"name": "", "value": "x"})
    assert r.status_code == 400
    assert "error" in r.json()


def test_keys_delete():
    client.post("/keys", json={"name": "DEL_KEY", "value": "secretvalue"})
    r = client.delete("/keys/DEL_KEY")
    assert r.status_code == 200
    assert r.json()["ok"] is True

    r2 = client.get("/keys")
    item = next((k for k in r2.json()["items"] if k["name"] == "DEL_KEY"), None)
    if item is not None:
        assert item["set"] is False


def test_keys_gemini_reconfigure_does_not_crash():
    r = client.post("/keys", json={"name": "GEMINI_API_KEY", "value": "dummy-key-xyz"})
    assert r.status_code == 200
    client.delete("/keys/GEMINI_API_KEY")


# ── keychain encryption (Supabaseに保存する値はFernet暗号化される) ──
def _reset_fernet():
    import keychain
    keychain._fernet_cache = None
    keychain._fernet_tried = False


def test_keychain_encryption_roundtrip(monkeypatch):
    import config
    import keychain
    monkeypatch.setattr(config, "KEYCHAIN_SECRET", "unit-test-master-secret")
    _reset_fernet()
    secret = "super-secret-value-1234567890"
    token = keychain._encrypt(secret)
    # 暗号文プレフィックス付き & 平文はDBに残らない
    assert token.startswith("enc:v1:")
    assert secret not in token
    # 同じ鍵で復号できる
    assert keychain._decrypt(token) == secret
    # 旧データ（平文）は後方互換でそのまま読める
    assert keychain._decrypt("legacy-plaintext") == "legacy-plaintext"
    _reset_fernet()


def test_keychain_wrong_secret_cannot_decrypt(monkeypatch):
    import config
    import keychain
    monkeypatch.setattr(config, "KEYCHAIN_SECRET", "secret-A")
    _reset_fernet()
    token = keychain._encrypt("value-xyz")
    assert token.startswith("enc:v1:")
    # 別のシークレット → 別の鍵 → 復号不可（空を返す＝漏れない）
    monkeypatch.setattr(config, "KEYCHAIN_SECRET", "secret-B")
    _reset_fernet()
    assert keychain._decrypt(token) == ""
    _reset_fernet()


def test_keychain_no_secret_passthrough(monkeypatch):
    import config
    import keychain
    monkeypatch.setattr(config, "KEYCHAIN_SECRET", "")
    monkeypatch.setattr(config, "SUPABASE_SERVICE_KEY", "")
    monkeypatch.setattr(config, "APP_TOKEN", "")
    _reset_fernet()
    # シークレットが一切無ければ平文のまま（メモリ運用のみ想定 / crashしない）
    assert keychain._encrypt("abc") == "abc"
    assert keychain._decrypt("abc") == "abc"
    _reset_fernet()


# ── /code（AIコーディングエージェント） ─────────────────────────────
def test_code_generate_without_gemini_returns_503():
    r = client.post("/code/generate", json={"instruction": "Webアプリを作って", "files": []})
    assert r.status_code == 503
    assert "error" in r.json()


def test_code_generate_requires_instruction():
    r = client.post("/code/generate", json={"instruction": "", "files": []})
    assert r.status_code == 503
    assert "error" in r.json()


def test_code_scaffold_web():
    r = client.get("/code/scaffold", params={"kind": "web"})
    assert r.status_code == 200
    files = r.json()["files"]
    assert any(f["path"] == "index.html" for f in files)


def test_code_scaffold_empty():
    r = client.get("/code/scaffold", params={"kind": "empty"})
    assert r.status_code == 200
    assert r.json() == {"files": []}


# ── /tts rate（話速） ───────────────────────────────────────────────
def test_tts_with_rate():
    r = client.post("/tts", json={"text": "テスト", "voice": "ja-JP-NanamiNeural", "rate": "+20%"})
    assert r.status_code == 200
    assert "audio_base64" in r.json()


def test_tts_invalid_rate_does_not_crash():
    r = client.post("/tts", json={"text": "テスト", "rate": "bogus"})
    assert r.status_code == 200
    assert "audio_base64" in r.json()


# ── /vault/generate, /vault/diagram（NotebookLM風） ─────────────────
def test_vault_generate_without_supabase():
    r = client.post("/vault/generate", json={"notebook_id": "fake", "instruction": "要約して"})
    assert r.status_code in (200, 503)
    assert "error" in r.json() or "markdown" in r.json()


def test_vault_diagram_without_supabase():
    r = client.post("/vault/diagram", json={"notebook_id": "fake", "kind": "tree"})
    assert r.status_code in (200, 503)
    assert "error" in r.json() or "mermaid" in r.json()


# ── /autopilot（ゴール自動実行） ────────────────────────────────────
def test_autopilot_list():
    r = client.get("/autopilot/missions")
    assert r.status_code == 200
    assert "items" in r.json()
    assert isinstance(r.json()["items"], list)


def test_autopilot_create_and_steps():
    r = client.post("/autopilot/missions", json={"goal": "テストのゴール", "notify": False})
    assert r.status_code == 200
    m = r.json()
    assert "id" in m
    assert m["goal"] == "テストのゴール"
    assert m["status"] == "active"
    assert isinstance(m["steps"], list) and len(m["steps"]) >= 1

    # ステップ実行（Gemini無し → failed になるが crash しない）
    r2 = client.post(f"/autopilot/missions/{m['id']}/step")
    assert r2.status_code == 200
    data = r2.json()
    assert "mission" in data or "error" in data

    # 一覧に出る
    r3 = client.get("/autopilot/missions")
    ids = [x["id"] for x in r3.json()["items"]]
    assert m["id"] in ids


def test_autopilot_create_empty_goal():
    r = client.post("/autopilot/missions", json={"goal": "", "notify": False})
    assert r.status_code in (400, 422)


def test_autopilot_step_not_found():
    r = client.post("/autopilot/missions/nonexistent/step")
    assert r.status_code == 404
    assert "error" in r.json()


def test_autopilot_delete():
    r = client.post("/autopilot/missions", json={"goal": "削除用ゴール", "notify": False})
    mid = r.json()["id"]
    r2 = client.delete(f"/autopilot/missions/{mid}")
    assert r2.status_code == 200
    assert r2.json()["ok"] is True


# ── /notify（外部通知） ─────────────────────────────────────────────
def test_notify_without_tokens_skips_safely():
    """トークン未設定なら何も送らず skipped を返す（ネットワークアクセスもしない）。"""
    r = client.post("/notify", json={"message": "テスト通知"})
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is False
    assert data["skipped"] is True


# ── /automations（ノーコード自動化 / Zapier風） ───────────────────────
def test_automations_list():
    r = client.get("/automations")
    assert r.status_code == 200
    assert "items" in r.json()


def test_automations_create_and_normalize_steps():
    r = client.post("/automations", json={
        "name": "テスト自動化",
        "steps": [
            {"type": "ai_generate", "name": "要約", "params": {"prompt": "{input}を要約"}},
            {"type": "notify", "name": "通知", "params": {"message": "完了: {input}"}},
            {"type": "bogus_type", "name": "無効"},  # 不正な type は除外される
        ],
    })
    assert r.status_code == 200
    f = r.json()
    assert "id" in f
    assert f["name"] == "テスト自動化"
    # 不正ステップが除外され 2 ステップになる
    assert len(f["steps"]) == 2
    assert {s["type"] for s in f["steps"]} == {"ai_generate", "notify"}


def test_automations_create_empty_name():
    r = client.post("/automations", json={"name": "", "steps": []})
    assert r.status_code in (400, 422)


def test_automations_run_without_gemini():
    r = client.post("/automations", json={
        "name": "実行テスト",
        "steps": [{"type": "ai_generate", "params": {"prompt": "{input}を分析"}}],
    })
    fid = r.json()["id"]
    r2 = client.post(f"/automations/{fid}/run", json={"input": "テスト入力"})
    # Gemini 無しでも crash せず、results を返す
    assert r2.status_code == 200
    data = r2.json()
    assert "results" in data
    assert isinstance(data["results"], list)


def test_automations_run_notify_step_without_tokens():
    """notify ステップのみの自動化は、トークン無しでも crash しない。"""
    r = client.post("/automations", json={
        "name": "通知のみ",
        "steps": [{"type": "notify", "params": {"message": "やあ {input}"}}],
    })
    fid = r.json()["id"]
    r2 = client.post(f"/automations/{fid}/run", json={"input": "world"})
    assert r2.status_code == 200
    assert "results" in r2.json()


def test_automations_run_not_found():
    r = client.post("/automations/nonexistent/run", json={"input": "x"})
    assert r.status_code == 404
    assert "error" in r.json()


def test_automations_delete():
    r = client.post("/automations", json={"name": "削除自動化", "steps": []})
    fid = r.json()["id"]
    r2 = client.delete(f"/automations/{fid}")
    assert r2.status_code == 200
    assert r2.json()["ok"] is True


# ── /evolve（セルフ進化） ───────────────────────────────────────────
def test_evolve_without_gemini():
    r = client.post("/evolve/propose", json={"instruction": "在庫管理アプリが欲しい"})
    # Gemini 無し → 503 error（crash しない）
    assert r.status_code in (200, 503)
    data = r.json()
    assert "error" in data or "type" in data


def test_evolve_empty_instruction():
    r = client.post("/evolve/propose", json={"instruction": ""})
    assert r.status_code in (400, 422, 503)
    data = r.json()
    assert "error" in data or "detail" in data


# ── /agenda（組み込みカレンダー） ──────────────────────────────────
def test_agenda_list():
    r = client.get("/agenda")
    assert r.status_code == 200
    assert "items" in r.json()


def test_agenda_add_and_list():
    r = client.post("/agenda", json={"title": "歯医者", "date": "2026-07-01", "time": "15:00"})
    assert r.status_code == 200
    ev = r.json()
    assert "id" in ev and ev["title"] == "歯医者"

    r2 = client.get("/agenda")
    ids = [e["id"] for e in r2.json()["items"]]
    assert ev["id"] in ids


def test_agenda_add_empty_title():
    r = client.post("/agenda", json={"title": ""})
    assert r.status_code in (400, 422)


def test_agenda_parse_without_gemini_falls_back():
    # Gemini 無しでも、文面をタイトルとして登録できる（crashしない）
    r = client.post("/agenda/parse", json={"text": "金曜10時 定例MTG", "today": "2026-06-27"})
    assert r.status_code == 200
    assert "id" in r.json()


def test_agenda_delete():
    r = client.post("/agenda", json={"title": "削除予定"})
    eid = r.json()["id"]
    r2 = client.delete(f"/agenda/{eid}")
    assert r2.status_code == 200
    assert r2.json()["ok"] is True


# ── /notifications（アプリ内通知） ─────────────────────────────────
def test_notifications_list_and_read():
    # notify を1回呼ぶと内部ログに残る
    client.post("/notify", json={"message": "テスト通知ログ"})
    r = client.get("/notifications")
    assert r.status_code == 200
    data = r.json()
    assert "items" in data and "unread" in data
    assert any("テスト通知ログ" in (n.get("message") or "") for n in data["items"])

    r2 = client.post("/notifications/read")
    assert r2.status_code == 200
    assert r2.json()["ok"] is True


# ── /home/summary（コックピット集約） ──────────────────────────────
def test_home_summary_aggregates():
    r = client.get("/home/summary")
    assert r.status_code == 200
    data = r.json()
    for key in ("tasks", "missions", "automations", "income", "events", "notifications"):
        assert key in data
    assert "open" in data["tasks"]
    assert "active" in data["missions"]
    assert "unread" in data["notifications"]
