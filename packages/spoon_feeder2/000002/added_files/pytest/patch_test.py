"""AI出力の推測・差分・反映を実ファイルで確認する統合テスト。"""

from pathlib import Path

from backend.patcher import apply_preview, prepare_preview


def test_一意なPython関数はファイル名なしで特定する(tmp_path: Path):
    (tmp_path / "service.py").write_text("def total(a, b):\n    return a + b\n", encoding="utf-8")
    preview = prepare_preview(tmp_path, "```python\ndef total(a, b):\n    return a * b\n```")
    assert preview["changes"][0]["path"] == "service.py"


def test_Python関数の差分を実ファイルへ反映する(tmp_path: Path):
    target = tmp_path / "service.py"
    target.write_text("def total(a, b):\n    return a + b\n", encoding="utf-8")
    preview = prepare_preview(tmp_path, "```python\ndef total(a, b):\n    return a * b\n```")
    apply_preview(tmp_path, preview)
    assert "return a * b" in target.read_text(encoding="utf-8")


def test_同名CSharpメソッドは候補選択を返す(tmp_path: Path):
    code = "public class Demo { public void Run() { } }\n"
    (tmp_path / "A.cs").write_text(code, encoding="utf-8")
    (tmp_path / "B.cs").write_text(code, encoding="utf-8")
    preview = prepare_preview(tmp_path, "```csharp\npublic void Run() { System.Console.WriteLine(1); }\n```")
    assert preview["status"] == "needs_selection"


def test_file_changesで新規ファイルを作成する(tmp_path: Path):
    output = '<file_changes><file path="src/new.py" action="create"><![CDATA[value = 1\n]]></file></file_changes>'
    preview = prepare_preview(tmp_path, output)
    apply_preview(tmp_path, preview)
    assert (tmp_path / "src" / "new.py").exists()


def test_コードフェンス内のファイルパスを認識する(tmp_path: Path):
    preview = prepare_preview(tmp_path, "```python src/config.py\nVALUE = 2\n```")
    assert preview["changes"][0]["path"] == "src/config.py"


def test_ファイルパス付きPython関数をファイル全文にせず反映する(tmp_path: Path):
    target = tmp_path / "service.py"
    target.write_text("VALUE = 1\n\ndef total(a, b):\n    return a + b\n", encoding="utf-8")

    preview = prepare_preview(tmp_path, "```python path: service.py\ndef total(a, b):\n    return a * b\n```")
    result = apply_preview(tmp_path, preview)

    source = target.read_text(encoding="utf-8")
    assert result["status"] == "success" and "VALUE = 1" in source and "return a * b" in source


def test_同じコードブロックの複数Python関数をすべて反映する(tmp_path: Path):
    target = tmp_path / "service.py"
    target.write_text("def one():\n    return 1\n\ndef two():\n    return 2\n", encoding="utf-8")
    output = "```python path: service.py\ndef one():\n    return 10\n\ndef two():\n    return 20\n```"

    preview = prepare_preview(tmp_path, output)
    result = apply_preview(tmp_path, preview)

    source = target.read_text(encoding="utf-8")
    assert result["status"] == "success" and "return 10" in source and "return 20" in source


def test_Pythonクラスメソッドのインデントを維持して反映する(tmp_path: Path):
    target = tmp_path / "service.py"
    target.write_text("class Service:\n    def run(self):\n        return 'old'\n", encoding="utf-8")

    preview = prepare_preview(tmp_path, "```python path: service.py\ndef run(self):\n    return 'new'\n```")
    result = apply_preview(tmp_path, preview)

    source = target.read_text(encoding="utf-8")
    assert result["status"] == "success" and "    def run(self):\n        return 'new'" in source


def test_既存デコレータを関数反映時に維持する(tmp_path: Path):
    target = tmp_path / "api.py"
    target.write_text("@route('/health')\ndef health():\n    return 'old'\n", encoding="utf-8")
    preview = prepare_preview(tmp_path, "```python\ndef health():\n    return 'ok'\n```")
    apply_preview(tmp_path, preview)
    assert target.read_text(encoding="utf-8").startswith("@route('/health')")


def test_文字列リテラル内に物理改行があるPython関数を正規化して抽出する(tmp_path: Path):
    target = tmp_path / "service.py"
    target.write_text('def get_text():\n    return "old"\n', encoding="utf-8")
    output = '```python\ndef get_text():\n    return "hello\nworld"\n```'
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert preview["changes"][0]["symbol"] == "get_text"
    apply_preview(tmp_path, preview)
    assert 'return "hello\\nworld"' in target.read_text(encoding="utf-8")


def test_トリプルクォート内の物理改行は維持して関数を抽出する(tmp_path: Path):
    target = tmp_path / "service.py"
    target.write_text('def doc_func():\n    return "old"\n', encoding="utf-8")
    output = '```python\ndef doc_func():\n    """line1\nline2"""\n    return "new"\n```'
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert '"""line1\nline2"""' in content


def test_言語タグのないコードブロックからPython関数を自動検出する(tmp_path: Path):
    target = tmp_path / "service.py"
    target.write_text('def calc(n):\n    return n\n', encoding="utf-8")
    output = '```\ndef calc(n):\n    return n * 2\n```'
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert preview["changes"][0]["symbol"] == "calc"
    apply_preview(tmp_path, preview)
    assert 'return n * 2' in target.read_text(encoding="utf-8")


def test_f文字列やCRLF改行およびコメントを含むPython関数の改行正規化(tmp_path: Path):
    target = tmp_path / "service.py"
    target.write_text('def format_msg(name):\n    return "old"\n', encoding="utf-8")
    # f文字列内にCRLF改行、および手前にコメント
    output = '```python\n# note: "comment quote"\ndef format_msg(name):\n    return f"Hello\r\n{name}"\n```'
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert preview["changes"][0]["symbol"] == "format_msg"
    apply_preview(tmp_path, preview)
    assert 'return f"Hello\\n{name}"' in target.read_text(encoding="utf-8")


def test_言語タグのないコードブロックからCSharpメソッドを自動検出する(tmp_path: Path):
    target = tmp_path / "Program.cs"
    target.write_text("public class Demo { public void Execute() { } }\n", encoding="utf-8")
    output = '```\npublic void Execute()\n{\n    System.Console.WriteLine("updated");\n}\n```'
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert preview["changes"][0]["symbol"] == "Execute"
    apply_preview(tmp_path, preview)
    assert 'System.Console.WriteLine("updated");' in target.read_text(encoding="utf-8")


def test_Pythonクラスの差分を実ファイルへ反映する(tmp_path: Path):
    target = tmp_path / "service.py"
    target.write_text("class Service:\n    def run(self):\n        return 1\n", encoding="utf-8")
    output = "```python\nclass Service:\n    def run(self):\n        return 2\n    def stop(self):\n        return 0\n```"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert preview["changes"][0]["symbol"] == "Service"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert "return 2" in content and "def stop(self):" in content


def test_単純にPythonクラスが素のテキストで貼り付けられた場合に反映する(tmp_path: Path):
    target = tmp_path / "calc.py"
    target.write_text("class Calculator:\n    def add(self, a, b):\n        return 0\n", encoding="utf-8")
    output = "class Calculator:\n    def add(self, a, b):\n        return a + b\n"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert preview["changes"][0]["symbol"] == "Calculator"
    apply_preview(tmp_path, preview)
    assert "return a + b" in target.read_text(encoding="utf-8")


def test_デコレータ付きPythonクラスを反映する(tmp_path: Path):
    target = tmp_path / "model.py"
    target.write_text("@dataclass\nclass Config:\n    host: str = 'old'\n", encoding="utf-8")
    output = "```python\n@dataclass\nclass Config:\n    host: str = 'new'\n    port: int = 8080\n```"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert preview["changes"][0]["symbol"] == "Config"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert "host: str = 'new'" in content and "port: int = 8080" in content


def test_CSharpクラスのコードブロックからクラス全体を反映する(tmp_path: Path):
    target = tmp_path / "Service.cs"
    target.write_text("public class OrderService {\n    public void Cancel() { }\n}\n", encoding="utf-8")
    output = "```csharp\npublic class OrderService\n{\n    public void Cancel() { System.Console.WriteLine(1); }\n    public void Complete() { }\n}\n```"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert preview["changes"][0]["symbol"] == "OrderService"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert "System.Console.WriteLine(1);" in content and "public void Complete()" in content


def test_Pythonクラス内の文字列リテラル物理改行を正規化してクラスを反映する(tmp_path: Path):
    target = tmp_path / "service.py"
    target.write_text("class Config:\n    msg: str = 'old'\n", encoding="utf-8")
    output = 'class Config:\n    msg: str = "line1\nline2"\n'
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert preview["changes"][0]["symbol"] == "Config"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert 'msg: str = "line1\\nline2"' in content


def test_複数クラスが存在するファイルで対象クラスのみ置換する(tmp_path: Path):
    target = tmp_path / "models.py"
    target.write_text("class First:\n    a = 1\n\nclass Second:\n    b = 2\n", encoding="utf-8")
    output = "```python\nclass Second:\n    b = 20\n    c = 30\n```"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert "class First:\n    a = 1" in content and "class Second:\n    b = 20\n    c = 30" in content


def test_CSharpインターフェースの置換を反映する(tmp_path: Path):
    target = tmp_path / "IRepository.cs"
    target.write_text("public interface IRepository {\n    void Save();\n}\n", encoding="utf-8")
    output = "```csharp\npublic interface IRepository\n{\n    void Save();\n    void Delete();\n}\n```"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert preview["changes"][0]["symbol"] == "IRepository"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert "void Delete();" in content


def test_AIの自然言語チャット文に囲まれたPythonクラスを反映する(tmp_path: Path):
    target = tmp_path / "processor.py"
    target.write_text("class DataProcessor:\n    def process(self):\n        return 'old'\n", encoding="utf-8")
    output = (
        "修正したコードです。ご確認ください。\n\n"
        "```python\n"
        "class DataProcessor:\n"
        "    def process(self):\n"
        "        return 'new_processed'\n"
        "```\n\n"
        "以上の内容で動作するはずです。"
    )
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert preview["changes"][0]["symbol"] == "DataProcessor"
    apply_preview(tmp_path, preview)
    assert "return 'new_processed'" in target.read_text(encoding="utf-8")


def test_ファイルパスヒント付きコードブロックのPythonクラスを反映する(tmp_path: Path):
    sub = tmp_path / "services"
    sub.mkdir(parents=True)
    target = sub / "user_service.py"
    target.write_text("class UserService:\n    def get_user(self):\n        return None\n", encoding="utf-8")

    output = "```python services/user_service.py\nclass UserService:\n    def get_user(self):\n        return {'id': 1}\n```"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert preview["changes"][0]["path"] == "services/user_service.py"
    apply_preview(tmp_path, preview)
    assert "return {'id': 1}" in target.read_text(encoding="utf-8")


def test_継承やプロパティやクラスメソッドを含む複雑なクラスを反映する(tmp_path: Path):
    target = tmp_path / "models.py"
    target.write_text(
        "class Base:\n    pass\n\n"
        "class AdvancedModel(Base):\n"
        "    @property\n"
        "    def name(self):\n"
        "        return 'old'\n",
        encoding="utf-8",
    )
    output = (
        "```python\n"
        "class AdvancedModel(Base):\n"
        "    @property\n"
        "    def name(self):\n"
        "        return 'new'\n\n"
        "    @classmethod\n"
        "    def create(cls):\n"
        "        return cls()\n"
        "```"
    )
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert "class Base:\n    pass" in content
    assert "return 'new'" in content
    assert "@classmethod\n    def create(cls):" in content


def test_既存ファイルに存在しない新規クラスをファイル末尾に追加する(tmp_path: Path):
    target = tmp_path / "models.py"
    target.write_text("class User:\n    name: str = 'mine'\n", encoding="utf-8")

    # 1つしか.pyファイルがない場合、推測でそのファイルへ新規シンボルが追加される
    output = "```python\nclass Order:\n    id: int = 1\n```"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert "class User:" in content
    assert "class Order:" in content


def test_クラスと関数が同時に含まれるコードブロックを一括反映する(tmp_path: Path):
    target = tmp_path / "service.py"
    target.write_text(
        "class Helper:\n    def run(self):\n        return 1\n\n"
        "def standalone_func():\n    return 'old'\n",
        encoding="utf-8",
    )
    output = (
        "```python\n"
        "class Helper:\n"
        "    def run(self):\n"
        "        return 100\n\n"
        "def standalone_func():\n"
        "    return 'new'\n"
        "```"
    )
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    assert len(preview["changes"]) == 2
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert "return 100" in content and "return 'new'" in content


def test_CRLF改行コードのファイルをクラス反映時にも維持する(tmp_path: Path):
    target = tmp_path / "win_service.py"
    target.write_bytes(b"class WinService:\r\n    def start(self):\r\n        return False\r\n")

    output = "class WinService:\n    def start(self):\n        return True\n"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    apply_preview(tmp_path, preview)
    raw = target.read_bytes()
    assert b"\r\n" in raw
    assert b"return True\r\n" in raw


def test_if_name_mainがある場合は新規関数をその直前に追加する(tmp_path: Path):
    target = tmp_path / "main.py"
    target.write_text(
        "def existing():\n"
        "    return 1\n\n\n"
        'if __name__ == "__main__":\n'
        "    print(existing())\n",
        encoding="utf-8",
    )
    output = "```python\ndef new_func():\n    return 2\n```"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert "def new_func():" in content
    assert content.index("def new_func():") < content.index('if __name__ == "__main__":')
    assert content.strip().endswith("print(existing())")


def test_if_name_mainにシングルクォートが使われている場合も直前に追加する(tmp_path: Path):
    target = tmp_path / "app.py"
    target.write_text(
        "def hello():\n"
        "    return 'hi'\n\n"
        "if __name__ == '__main__':\n"
        "    hello()\n",
        encoding="utf-8",
    )
    output = "```python\ndef bye():\n    return 'bye'\n```"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert "def bye():" in content
    assert content.index("def bye():") < content.index("if __name__ == '__main__':")


def test_クラスメソッドと同名のトップレベル関数を反映する際に重複追加せず置換する(tmp_path: Path):
    target = tmp_path / "service.py"
    target.write_text(
        "class Service:\n"
        "    def run(self):\n"
        "        return 'method_old'\n\n"
        "def run():\n"
        "    return 'func_old'\n",
        encoding="utf-8",
    )
    output = "```python\ndef run():\n    return 'func_new'\n```"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert "return 'func_new'" in content
    assert "return 'method_old'" in content
    # runの出現回数が2回（クラス内1回、トップレベル1回）であり、3個目に末尾追加されていないこと
    assert content.count("def run(") == 2


def test_同名関数がファイル内に複数存在する場合でも重複追加せず置換する(tmp_path: Path):
    target = tmp_path / "duplicate.py"
    target.write_text(
        "def helper():\n"
        "    return 1\n\n"
        "def helper():\n"
        "    return 2\n",
        encoding="utf-8",
    )
    output = "```python\ndef helper():\n    return 3\n```"
    preview = prepare_preview(tmp_path, output)
    assert preview["status"] == "success"
    apply_preview(tmp_path, preview)
    content = target.read_text(encoding="utf-8")
    assert "return 3" in content
    # 新たに末尾追加されて3個になるのではなく、既存の定義を置換して2個のままであること
    assert content.count("def helper():") == 2






