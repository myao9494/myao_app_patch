import { useState, useEffect, useRef } from 'react';
import '../../styles/gantt.css';
import { formatDateToYMD } from '../../utils/dateUtils';

interface DateSettingModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (startDate: Date, duration: number) => void;
    initialDate: Date;
    initialDuration: number;
}

/** タスクの開始日と期間（日数）を設定するモーダル */
export function DateSettingModal(props: DateSettingModalProps) {
    // 開くたびに入力内容を初期値へ戻すため、開いている間だけ中身をマウントする
    return props.isOpen ? <DateSettingModalContent {...props} /> : null;
}

function DateSettingModalContent({
    onClose,
    onSave,
    initialDate,
    initialDuration,
}: DateSettingModalProps) {
    const [startDate, setStartDate] = useState<string>(() => formatDateToYMD(initialDate));
    const [duration, setDuration] = useState<number | string>(initialDuration);
    const durationInputRef = useRef<HTMLInputElement>(null);

    // モーダルが開いたときに期間入力欄にフォーカスし、全選択状態にする
    useEffect(() => {
        const timerId = window.setTimeout(() => {
            durationInputRef.current?.focus();
            durationInputRef.current?.select();
        }, 100);
        return () => window.clearTimeout(timerId);
    }, []);

    const handleSave = () => {
        const parsedDuration = Number(duration);
        if (!startDate || isNaN(parsedDuration) || parsedDuration < 1) return;
        const date = new Date(startDate);
        // Maintain time part if necessary, but gantt usually works with date boundaries
        // We'll set it to 00:00:00 as per formatDateString usage
        date.setHours(0, 0, 0, 0);
        onSave(date, parsedDuration);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSave();
        }
    };

    return (
        <div className="gantt-modal-overlay">
            <div className="gantt-modal-content">
                <h3>期間設定</h3>
                <div className="gantt-modal-field">
                    <label>開始日:</label>
                    <input
                        type="date"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                        onKeyDown={handleKeyDown}
                    />
                </div>
                <div className="gantt-modal-field">
                    <label>期間 (日):</label>
                    <input
                        type="number"
                        min="1"
                        ref={durationInputRef}
                        value={duration}
                        onChange={(e) => setDuration(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                </div>
                <div className="gantt-modal-actions">
                    <button onClick={onClose} className="gantt-modal-cancel">
                        キャンセル
                    </button>
                    <button onClick={handleSave} className="gantt-modal-save">
                        保存
                    </button>
                </div>
            </div>
            <style>{`
        .gantt-modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(0, 0, 0, 0.5);
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 1000;
        }
        .gantt-modal-content {
          background: white;
          padding: 20px;
          border-radius: 8px;
          width: 300px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }
        .gantt-modal-content h3 {
          margin-top: 0;
          margin-bottom: 20px;
          font-size: 1.2em;
          color: #333;
        }
        .gantt-modal-field {
          margin-bottom: 15px;
        }
        .gantt-modal-field label {
          display: block;
          margin-bottom: 5px;
          font-size: 0.9em;
          color: #666;
        }
        .gantt-modal-field input {
          width: 100%;
          padding: 8px;
          border: 1px solid #ddd;
          border-radius: 4px;
          box-sizing: border-box;
        }
        .gantt-modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          margin-top: 20px;
        }
        .gantt-modal-actions button {
          padding: 8px 16px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.9em;
        }
        .gantt-modal-cancel {
          background-color: #f5f5f5;
          color: #333;
        }
        .gantt-modal-cancel:hover {
          background-color: #e0e0e0;
        }
        .gantt-modal-save {
          background-color: #007bff;
          color: white;
        }
        .gantt-modal-save:hover {
          background-color: #0056b3;
        }
      `}</style>
        </div>
    );
}
