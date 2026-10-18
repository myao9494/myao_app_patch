/**
 * プロフィールかんたんコピーボタン
 * 設定に保存したメール・電話・住所・部署・家アドを、ワンクリックでクリップボードへコピーする
 */
import type { BackendSettings } from '../utils/api'

type ProfileCopyField = 'my_email' | 'my_phone' | 'my_address' | 'my_dept' | 'my_home_email'

/** ボタン表示名とトースト用の項目名 */
const PROFILE_BUTTONS: Array<{ field: ProfileCopyField; button: string; label: string }> = [
  { field: 'my_email', button: 'メール', label: 'メールアドレス' },
  { field: 'my_phone', button: '電話', label: '電話番号' },
  { field: 'my_address', button: '住所', label: '住所' },
  { field: 'my_dept', button: '部署', label: '部署' },
  { field: 'my_home_email', button: '家アド', label: '家のメールアドレス' },
]

type ProfileCopyButtonsProps = {
  settings: BackendSettings
  onCopy: (value: string | undefined, label: string) => void
}

export function ProfileCopyButtons({ settings, onCopy }: ProfileCopyButtonsProps) {
  return (
    <div className="flex gap-1 border-l border-gray-700 pl-2">
      {PROFILE_BUTTONS.map(({ field, button, label }) => (
        <button
          key={field}
          type="button"
          onClick={() => onCopy(settings[field], label)}
          className="px-2.5 py-2 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-[10px] text-gray-200 transition-colors font-medium"
        >
          {button}
        </button>
      ))}
    </div>
  )
}
