from app.runtime_env import configure_native_runtime_env

# torch / faiss を import するモジュールより先に、OpenMP 関連の環境変数を確定させる
configure_native_runtime_env()
