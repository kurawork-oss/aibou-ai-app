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
