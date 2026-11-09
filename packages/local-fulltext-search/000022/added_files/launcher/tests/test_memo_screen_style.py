"""1ページ4ペイン（検索・opencode CLI・永続メモ・ganttメモ）のUI契約を検証する。"""

from pathlib import Path
import re


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_native_macos_panel_has_four_pane_controls() -> None:
    """macOS ネイティブ版が横幅1170（縦画面向け780の1.5倍）で4ペインを持つことを検証する。"""
    source = (PROJECT_ROOT / "launcher/src/launcher_app/ui/native_mac.py").read_text(encoding="utf-8")

    assert "PANEL_WIDTH = 1170" in source
    assert "PANEL_HEIGHT = 780" in source
    assert "self.panel.setOpaque_(True)" in source
    assert "colorWithCalibratedRed_green_blue_alpha_(0.06, 0.09, 0.16, 1.0)" in source
    assert "NSTextFieldNoBezel" not in source
    assert "self.memo_body_view.setRichText_(False)" in source
    assert "self.memo_body_view.setImportsGraphics_(False)" in source
    assert "scratchpad_view" in source
    assert "opencode_prompt_view" in source
    assert "opencode_output_view" in source


def test_windows_main_window_has_four_pane_grid_and_bordered_inputs() -> None:
    """Windows WPF版が縦画面向け横幅（1040px）で右上opencode・右下ganttの4ペインを並べることを検証する。"""
    source = (PROJECT_ROOT / "launcher/windows/LocalSearchLauncher/MainWindow.xaml").read_text(encoding="utf-8")

    assert 'Width="1040"' in source
    assert 'Height="940"' in source
    assert 'x:Name="WindowSurface"' in source

    opencode_grid = re.search(r'<Grid x:Name="OpenCodeView"[^>]*>', source)
    assert opencode_grid is not None
    assert 'Grid.Row="0"' in opencode_grid.group(0)
    assert 'Grid.Column="1"' in opencode_grid.group(0)

    memo_grid = re.search(r'<Grid x:Name="MemoView"[^>]*>', source)
    assert memo_grid is not None
    assert 'Grid.Row="1"' in memo_grid.group(0)
    assert 'Grid.Column="1"' in memo_grid.group(0)
    assert 'Visibility="Collapsed"' not in memo_grid.group(0)

    # OpenCode の出力は Claudian 風のチャット表示（OpenCodeChatPanel）。入力欄だけが枠付きの TextBox
    assert 'x:Name="OpenCodeChatPanel"' in source
    for control_name in ("MemoTitle", "MemoBody", "ScratchpadBox", "OpenCodeInput"):
        control = re.search(rf'<TextBox x:Name="{control_name}"[^>]*/>', source)
        assert control is not None, f"{control_name} が MainWindow.xaml に存在すること"
        assert 'BorderThickness="1"' in control.group(0)
        assert 'Background="#CC1E293B"' in control.group(0)
        assert 'BorderBrush=' in control.group(0)
        assert 'BorderBrush="Transparent"' not in control.group(0)
