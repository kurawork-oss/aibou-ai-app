"""
道具を足したら、画面の呼び名も足すこと。

経過の表示（webapp/src/components/AgentTrace.tsx の TOOL_LABELS）に名前が
無い道具は、`browser_act` のような中の名前がそのまま画面に出る。ブラウザの
道具を畳んだときに、12個ぶん抜けていたのを見つけた（手元の相棒・図・ボード
など、足した順に抜けていた）。足し忘れは必ず起きるので、ここで縛る。
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import risk

TRACE = os.path.join(os.path.dirname(__file__), "..", "webapp", "src",
                     "components", "AgentTrace.tsx")


def _labels() -> set:
    src = open(TRACE, encoding="utf-8").read()
    block = src.split("export const TOOL_LABELS", 1)[1].split("};", 1)[0]
    return set(re.findall(r"^\s*([a-z_]+):", block, flags=re.M))


def test_every_tool_has_a_name_on_screen():
    missing = sorted(set(risk.LEVELS) - _labels())
    assert not missing, f"画面の呼び名が無い道具: {missing}"
