import { useState } from "react";

// Поле пароля с кнопкой-глазком показать/скрыть. className передаётся на сам <input>,
// чтобы выглядело идентично обычным текстовым полям в местах, где это подключается.
export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
  required,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  className: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        className={`${className} pr-10`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
        aria-label={visible ? "Скрыть пароль" : "Показать пароль"}
      >
        {visible ? "🙈" : "👁️"}
      </button>
    </div>
  );
}
