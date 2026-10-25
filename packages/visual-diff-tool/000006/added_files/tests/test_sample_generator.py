"""
画像diffアプリ用のテストサンプル（30枚、15ペア）が正しく生成されているかを検証するテストコード。
TDDアプローチに則り、期待される出力ファイルの存在、形式、妥当性を確認します。
"""

import os
import unittest

from PIL import Image


class TestSampleGenerator(unittest.TestCase):
    def setUp(self):
        # サンプル画像が保存されるディレクトリ
        self.samples_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "samples")

        # 期待される15個のペア
        self.expected_pairs = [
            "gear",                  # 歯車図面
            "flange",                # フランジ継手
            "shaft",                 # 段付きシャフト
            "bracket",               # L字ブラケット
            "bolt",                  # ボルト・ナット
            "pcb",                   # 電子回路基板
            "stress_strain",         # 応力-ひずみ曲線
            "thermal_heatmap",       # 熱解析カラーマップ
            "fft_spectrum",          # 振動スペクトル
            "bathtub_curve",         # バスタブ曲線
            "bom",                   # 部品表 (BOM)
            "ecn",                   # 設計変更通知書
            "workflow_flowchart",    # ワークフローフローチャート
            "factory_layout",        # 工場レイアウト
            "inspection_certificate" # 検査成績書
        ]

    def test_samples_directory_exists(self):
        """samplesディレクトリが存在することを確認する"""
        self.assertTrue(os.path.isdir(self.samples_dir), f"Directory not found: {self.samples_dir}")

    def test_all_sample_files_exist_and_valid(self):
        """全30枚（15ペア、各AとB）の画像ファイルが存在し、Pillowで正常に開けることを確認する"""
        missing_files = []
        invalid_images = []

        for pair in self.expected_pairs:
            for suffix in ["_a.png", "_b.png"]:
                filename = f"{pair}{suffix}"
                filepath = os.path.join(self.samples_dir, filename)

                # ファイル存在確認
                if not os.path.exists(filepath):
                    missing_files.append(filename)
                    continue

                # 画像の妥当性確認
                try:
                    with Image.open(filepath) as img:
                        img.verify() # 破損がないかチェック
                except Exception as e:
                    invalid_images.append((filename, str(e)))

        # エラー情報の整形
        error_msg = ""
        if missing_files:
            error_msg += f"\n欠落しているファイル ({len(missing_files)}個): {', '.join(missing_files)}"
        if invalid_images:
            error_msg += f"\n破損している画像 ({len(invalid_images)}個): " + \
                         ", ".join([f"{name} ({err})" for name, err in invalid_images])

        self.assertEqual(len(missing_files) + len(invalid_images), 0, error_msg)

if __name__ == "__main__":
    unittest.main()
