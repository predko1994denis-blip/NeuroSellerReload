import type { ScenarioStyle } from "./api";

interface SliderDef {
  key: keyof Omit<ScenarioStyle, "address" | "emoji" | "gender">;
  label: string;
  low: string;
  high: string;
}

const SLIDERS: SliderDef[] = [
  { key: "formality", label: "Формальность", low: "Разговорный", high: "Деловой" },
  { key: "warmth", label: "Теплота", low: "Нейтральный", high: "Очень тёплый" },
  { key: "responseLength", label: "Длина ответов", low: "Кратко", high: "Развёрнуто" },
  { key: "energy", label: "Напор", low: "Мягкий", high: "Настойчивый" },
  { key: "initiative", label: "Инициативность", low: "Реактивный", high: "Проактивный" },
  { key: "humor", label: "Юмор", low: "Серьёзный", high: "С юмором" },
  { key: "confidence", label: "Уверенность", low: "Осторожный", high: "Уверенный" },
  { key: "structure", label: "Структура", low: "Сплошной текст", high: "Списки/пункты" },
];

export function StylePanel({
  style,
  onChange,
  onClose,
}: {
  style: ScenarioStyle;
  onChange: (style: ScenarioStyle) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-slate-900">🎨 Стиль общения бота</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">
            ×
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-4">
          Применяется ко всем шагам сценария, кроме завершающих сообщений — те всегда живые и тёплые.
        </p>

        <div className="flex flex-col gap-4">
          <div>
            <div className="text-sm font-medium text-slate-700 mb-1.5">Обращение к клиенту</div>
            <div className="flex gap-2">
              {(["вы", "ты"] as const).map((opt) => (
                <button
                  key={opt}
                  onClick={() => onChange({ ...style, address: opt })}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium border ${
                    style.address === opt
                      ? "bg-red-600 border-red-600 text-white"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  на «{opt}»
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-sm font-medium text-slate-700 mb-1.5">Род бота</div>
            <div className="flex gap-2">
              {(["м", "ж"] as const).map((opt) => (
                <button
                  key={opt}
                  onClick={() => onChange({ ...style, gender: opt })}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium border ${
                    style.gender === opt
                      ? "bg-red-600 border-red-600 text-white"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {opt === "м" ? "Мужской" : "Женский"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-sm font-medium text-slate-700 mb-1.5">Эмодзи</div>
            <div className="flex gap-2">
              {[
                { v: 1, label: "Не использует" },
                { v: 2, label: "Умеренно" },
                { v: 3, label: "Активно" },
              ].map((opt) => (
                <button
                  key={opt.v}
                  onClick={() => onChange({ ...style, emoji: opt.v })}
                  className={`flex-1 rounded-lg px-2 py-2 text-xs font-medium border ${
                    style.emoji === opt.v
                      ? "bg-red-600 border-red-600 text-white"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {SLIDERS.map(({ key, label, low, high }) => (
            <div key={key}>
              <div className="flex items-center justify-between text-sm font-medium text-slate-700 mb-1">
                <span>{label}</span>
                <span className="text-slate-400 text-xs">{style[key]}/5</span>
              </div>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={style[key] as number}
                onChange={(e) => onChange({ ...style, [key]: Number(e.target.value) })}
                className="w-full accent-red-600"
              />
              <div className="flex justify-between text-[11px] text-slate-400">
                <span>{low}</span>
                <span>{high}</span>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={onClose}
          className="mt-6 w-full bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg px-4 py-2.5"
        >
          Готово
        </button>
      </div>
    </div>
  );
}
