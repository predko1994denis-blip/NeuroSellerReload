import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

export interface BranchNodeData {
  conditions: string[];
  selected: boolean;
  onChangeCondition: (index: number, value: string) => void;
  onAddCondition: () => void;
  onRemoveCondition: (index: number) => void;
  [key: string]: unknown;
}

export function BranchNode({ data }: NodeProps) {
  const d = data as BranchNodeData;
  const n = d.conditions.length;

  return (
    <div
      className={`bg-white rounded-xl border-2 shadow-sm w-64 ${
        d.selected ? "border-red-500 ring-2 ring-red-100" : "border-amber-400"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />

      <div className="px-3 py-2 border-b border-slate-100">
        <span className="text-xs font-semibold text-amber-600">⑃ Ветвление</span>
      </div>

      <div className="p-3 flex flex-col gap-2">
        <div className="text-[11px] text-slate-400">Условия веток (соедини каждое с началом ветки):</div>
        {d.conditions.map((c, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              value={c}
              onChange={(e) => d.onChangeCondition(i, e.target.value)}
              placeholder={`условие ${i + 1}`}
              className="nodrag flex-1 border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-900 outline-none focus:border-amber-400"
            />
            {n > 1 && (
              <button
                onClick={() => d.onRemoveCondition(i)}
                className="nodrag text-slate-300 hover:text-red-500 text-xs"
              >
                ×
              </button>
            )}
          </div>
        ))}
        {/* Один выходной хэндл на каждое условие, распределены по правому краю */}
        {d.conditions.map((_, i) => (
          <Handle
            key={`h-${i}`}
            type="source"
            position={Position.Right}
            id={String(i)}
            style={{ top: `${((i + 1) / (n + 1)) * 100}%` }}
            className="!bg-amber-400"
          />
        ))}
        <button
          onClick={d.onAddCondition}
          className="nodrag text-xs text-amber-600 hover:text-amber-700 self-start"
        >
          + условие
        </button>
      </div>
    </div>
  );
}
