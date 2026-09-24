# test_screen_names.py — 無くなった画面の名前で、利用者を案内していないか
#
# 入口を 実行／管理 の1つにして、画面の札は英語（CHAT・HOME・BOARD…）から
# 今日・ボード・つくる… に変わった。設定のタブも KEYCHAIN・DIAGNOSTICS から
# 「つなぐ」「しらべる」になり、鍵は「連携」の画面へ移った。
#
# サーバーの文は、そのまま画面に出るか、AIが言い換えて利用者に伝える。
# 「BOARDモードで確認できます」と返すと、押した先に無い場所を案内してしまう。
# 実際に tools.py・hfhub.py・oauth.py などに残っていた。
#
# 数えるのは**文字列だけ**（コメントと docstring は経緯の記録なので数えない）。
# 環境変数の名前（KEYCHAIN_SECRET）と、実在するタブ（AI STUDIO）は対象外。

import ast
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))

OLD = re.compile(
    r"(?<![A-Za-z_])(?<!AI )"
    r"(CHAT|HOME|ARCHIVE|STUDIO|VAULT|CAPTURE|INCOME|AUTOPILOT|AUTO|EXTEND|TASKS|BOARD|CODE|LIFE|GUIDE|ME)"
    r"\s?(で|に|を|の|や|と|タブ|画面|モード|›|から|へ)"
    r"|KEYCHAIN(?!_)|DIAGNOSTICS"
)


def _strings(path):
    tree = ast.parse(open(path, encoding="utf-8").read())
    docs = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
            first = node.body[0]
            if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                    and isinstance(first.value.value, str)):
                docs.add(id(first.value))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs:
            yield node.lineno, node.value


def test_server_messages_do_not_point_at_screens_that_no_longer_exist():
    bad = []
    for name in sorted(os.listdir(HERE)):
        if not name.endswith(".py") or name.startswith("test_"):
            continue
        for line, text in _strings(os.path.join(HERE, name)):
            m = OLD.search(text)
            if m:
                bad.append(f"{name}:{line}: {m.group(0)!r} … {text[:60]!r}")
    assert not bad, "無くなった画面の名前で案内している:\n" + "\n".join(bad)


def test_the_detector_actually_catches_the_old_forms():
    """検出が甘くなって素通りしていないか（見張りの見張り）。"""
    for s in ["BOARDモードで確認できます", "CHATで頼めます", "HOMEの生成物", "STUDIO › 素材",
              "設定 → KEYCHAIN", "AUTOモードで進められます", "手順は GUIDE に載っています"]:
        assert OLD.search(s), s
    for s in ["AI STUDIO のワークフロー", "KEYCHAIN_SECRET", "LOADING TASKS…", "SNSで投稿文を作る", "README の手順"]:
        assert not OLD.search(s), s
