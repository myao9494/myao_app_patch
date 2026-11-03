/**
 * STEP 以外の CAD ファイル（OBJ / STL / FCStd）の読み込み
 *
 * 1. OBJ / STL は三角形メッシュのため OCCT を通さず読み込む
 * 2. FCStd は ZIP の中の BREP を OCCT で読み込む（キャッシュしない）
 * 3. ファイルを直接開いたビュー（StepView）とノートの埋め込み（StepEmbed）で共通に使う
 * 4. STEP のファイルには null を返す（呼び出し側が OCCT の STEP 読み込みとキャッシュを使う）
 **/

import { App, TFile } from "obsidian";
import { objToStepModel, stlToStepModel } from "./MeshLoaders";
import { fcstdToStepModel } from "./FreeCadLoader";
import { paramsForDeflection } from "./params";
import { StepModel } from "./StepToThree";

export async function loadNonStepModel(
  app: App,
  file: TFile,
  deflection: number,
): Promise<StepModel | null> {
  const ext = file.extension.toLowerCase();
  if (ext !== "obj" && ext !== "stl" && ext !== "fcstd") return null;

  const buffer = await app.vault.readBinary(file);
  if (ext === "obj") return objToStepModel(new TextDecoder().decode(buffer), file.basename);
  if (ext === "stl") return stlToStepModel(buffer, file.basename);
  return fcstdToStepModel(new Uint8Array(buffer), file.basename, paramsForDeflection(deflection));
}
