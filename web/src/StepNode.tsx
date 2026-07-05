import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export type StepRuleType = "example" | "validation" | "custom";

export interface StepRule {
  type: StepRuleType;
  text: string;
}

export interface StepFields {
  goal: string;
  required: boolean;
  maxAttempts: number;
  fieldName?: string;
  rules: StepRule[];
}

export interface StepNodeData extends StepFields {
  isLast: boolean;
  selected: boolean;
  [key: string]: unknown;
}

export function StepNode({ data }: NodeProps) {
  const d = data as StepNodeData;

  return (
    <div
      className={`bg-white rounded-xl border-2 shadow-sm w-56 cursor-pointer transition-shadow hover:shadow-md ${
        d.selected ? "border-red-500 ring-2 ring-red-100" : d.isLast ? "border-emerald-400" : "border-slate-300"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />

      <div className="px-3 py-2 border-b border-slate-100">
        <span className={`text-xs font-semibold ${d.isLast ? "text-emerald-600" : "text-slate-500"}`}>
          {d.isLast ? "🏁 Завершающий" : "◆ Шаг"}
        </span>
      </div>

      <div className="p-3">
        <div className={`text-sm ${d.goal ? "text-slate-900" : "text-slate-400 italic"}`}>
          {d.goal || "нажмите, чтобы задать цель"}
        </div>
        <div className="flex gap-1.5 mt-2">
          <span className="text-[10px] bg-slate-100 text-slate-500 rounded-full px-2 py-0.5">
            {d.required ? "обязательный" : "необязательный"}
          </span>
          <span className="text-[10px] bg-slate-100 text-slate-500 rounded-full px-2 py-0.5">
            {d.maxAttempts} попыт.
          </span>
          {d.rules.length > 0 && (
            <span className="text-[10px] bg-slate-100 text-slate-500 rounded-full px-2 py-0.5">
              {d.rules.length} правил
            </span>
          )}
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
    </div>
  );
}
