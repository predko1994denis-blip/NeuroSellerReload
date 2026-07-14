import { useCallback, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  addEdge,
  reconnectEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type FinalConnectionState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { StepNode, type StepFields, type StepNodeData, type StepRule, type StepRuleType } from "./StepNode";
import { BranchNode, type BranchNodeData } from "./BranchNode";
import {
  generateScenario,
  regenerateScenario,
  DEFAULT_SCENARIO_STYLE,
  type StepInput,
  type ProcessInput,
  type Scenario,
  type ScenarioStyle,
} from "./api";
import { StylePanel } from "./StylePanel";

const nodeTypes = { step: StepNode, branch: BranchNode };

let idCounter = 1;
const newId = () => `n${idCounter++}`;

const emptyStep = (): StepFields & { [k: string]: unknown } => ({
  goal: "",
  required: true,
  maxAttempts: 3,
  rules: [],
  acceptsImage: false,
});

function toStepInput(d: StepFields): StepInput {
  return {
    goal: d.goal.trim(),
    required: d.required,
    maxAttempts: d.maxAttempts,
    fieldName: d.fieldName?.trim() || undefined,
    rules: d.rules.filter((r) => r.text.trim()).map((r) => ({ type: r.type, text: r.text.trim() })),
    acceptsImage: d.acceptsImage ?? false,
  };
}

interface Props {
  botId: number;
  companyName: string;
  scenario?: Scenario; // если задан — режим редактирования существующего сценария
  onClose: () => void;
  onGenerated: () => void;
}

export function ChainBuilder(props: Props) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}

function loadInitialNodesEdges(scenario?: Scenario): { nodes: Node[]; edges: Edge[] } {
  if (!scenario || !scenario.graph?.nodes?.length) {
    return { nodes: [{ id: newId(), type: "step", position: { x: 300, y: 80 }, data: emptyStep() }], edges: [] };
  }
  // Старые сохранённые графы могли не иметь rules (прежний формат с фиксированными полями) —
  // подстраховываемся, чтобы не упасть на .rules у старых узлов.
  const nodes = (scenario.graph.nodes as Node[]).map((n) =>
    n.type === "step" ? { ...n, data: { ...n.data, rules: (n.data as { rules?: unknown }).rules ?? [] } } : n
  );
  const edges = scenario.graph.edges as Edge[];
  // продолжаем нумерацию id, чтобы новые кубики не конфликтовали со старыми
  const maxExisting = nodes.reduce((m, n) => Math.max(m, Number(String(n.id).replace(/\D/g, "")) || 0), 0);
  idCounter = maxExisting + 1;
  return { nodes, edges };
}

function Flow({ botId, companyName, scenario, onClose, onGenerated }: Props) {
  const { screenToFlowPosition } = useReactFlow();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<{ processCount: number; reusedSteps?: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showStyle, setShowStyle] = useState(false);
  const [style, setStyle] = useState<ScenarioStyle>(scenario?.style ?? DEFAULT_SCENARIO_STYLE);
  const [forceRegenerate, setForceRegenerate] = useState(false);
  const [goals, setGoals] = useState<string[]>(scenario?.goals ?? []); // позитивные цели — с чем бот помогает
  const [nonGoals, setNonGoals] = useState<string[]>(scenario?.non_goals ?? []);
  const [showGoals, setShowGoals] = useState(false); // панель «Вне задач» (non-goals)
  const [showPositiveGoals, setShowPositiveGoals] = useState(false); // панель «Цели бота»

  const initial = useMemo(() => loadInitialNodesEdges(scenario), [scenario]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge({ ...c, animated: true }, eds)), [setEdges]);

  // Drag-to-create: тянешь линию из кубика и отпускаешь:
  // - на пустом месте → появляется новый связанный шаг
  // - НА уже существующем кубике (не обязательно точно на хэндл, достаточно попасть в его область) →
  //   соединяется с ним, новый узел не создаётся — так несколько веток можно свести в один кубик.
  const NODE_WIDTH = 224;
  const NODE_HEIGHT_ESTIMATE = 160;

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid || !connectionState.fromNode) return;
      const point = "changedTouches" in event ? event.changedTouches[0]! : event;
      const position = screenToFlowPosition({ x: point.clientX, y: point.clientY });
      const sourceId = connectionState.fromNode.id;
      const sourceHandle = connectionState.fromHandle?.id ?? null;

      const hitNode = nodes.find((n) => {
        if (n.id === sourceId) return false;
        const width = n.measured?.width ?? NODE_WIDTH;
        const height = n.measured?.height ?? NODE_HEIGHT_ESTIMATE;
        return (
          position.x >= n.position.x &&
          position.x <= n.position.x + width &&
          position.y >= n.position.y &&
          position.y <= n.position.y + height
        );
      });

      const targetId = hitNode?.id ?? newId();
      if (!hitNode) {
        setNodes((nds) => nds.concat({ id: targetId, type: "step", position, data: emptyStep() }));
      }
      setEdges((eds) =>
        addEdge(
          {
            id: `e-${sourceId}-${targetId}-${Date.now()}`,
            source: sourceId,
            sourceHandle,
            target: targetId,
            targetHandle: null,
            animated: true,
          },
          eds
        )
      );
    },
    [screenToFlowPosition, setNodes, setEdges, nodes]
  );

  // Перетаскивание УЖЕ СУЩЕСТВУЮЩЕЙ связи за её конец на другой кубик — переключает,
  // куда ведёт эта связь, вместо удаления и пересоздания вручную.
  const reconnectSuccessful = useRef(true);
  const onReconnectStart = useCallback(() => {
    reconnectSuccessful.current = false;
  }, []);
  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      reconnectSuccessful.current = true;
      setEdges((eds) => reconnectEdge(oldEdge, newConnection, eds));
    },
    [setEdges]
  );
  const onReconnectEnd = useCallback(
    (_event: unknown, edge: Edge) => {
      // отпустили конец связи на пустом месте — считаем это удалением связи
      if (!reconnectSuccessful.current) {
        setEdges((eds) => eds.filter((e) => e.id !== edge.id));
      }
      reconnectSuccessful.current = true;
    },
    [setEdges]
  );

  const updateNode = useCallback(
    (id: string, patch: Record<string, unknown>) =>
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))),
    [setNodes]
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== id));
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [setNodes, setEdges]
  );

  const addBranch = useCallback(() => {
    setNodes((nds) => {
      const maxY = nds.reduce((m, n) => Math.max(m, n.position.y), 0);
      return [
        ...nds,
        { id: newId(), type: "branch", position: { x: 300, y: maxY + 160 }, data: { conditions: ["", ""] } },
      ];
    });
  }, [setNodes]);

  const leafStepIds = useMemo(() => {
    const withOut = new Set(edges.map((e) => e.source));
    return new Set(nodes.filter((n) => n.type === "step" && !withOut.has(n.id)).map((n) => n.id));
  }, [nodes, edges]);

  const displayNodes: Node[] = nodes.map((n) => {
    if (n.type === "branch") {
      const conds = (n.data as { conditions: string[] }).conditions;
      const data: BranchNodeData = {
        conditions: conds,
        selected: n.id === selectedId,
        onChangeCondition: (i, v) => updateNode(n.id, { conditions: conds.map((c, idx) => (idx === i ? v : c)) }),
        onAddCondition: () => updateNode(n.id, { conditions: [...conds, ""] }),
        onRemoveCondition: (i) => updateNode(n.id, { conditions: conds.filter((_, idx) => idx !== i) }),
      };
      return { ...n, data };
    }
    const data: StepNodeData = {
      ...(n.data as unknown as StepFields),
      isLast: leafStepIds.has(n.id),
      selected: n.id === selectedId,
    };
    return { ...n, data };
  });

  const selectedNode = nodes.find((n) => n.id === selectedId && n.type === "step");

  function compile(): ProcessInput[] {
    const byId = (id: string) => nodes.find((n) => n.id === id)!;
    const incoming = new Set(edges.map((e) => e.target));
    const entries = nodes.filter((n) => !incoming.has(n.id));
    if (entries.length !== 1) throw new Error("Должен быть ровно один начальный кубик (без входящих связей)");

    const processes: ProcessInput[] = [];
    const memo = new Map<string, number>();

    function compileFrom(startId: string, name: string): number {
      if (memo.has(startId)) return memo.get(startId)!;
      const idx = processes.length;
      processes.push({ name, steps: [] });
      memo.set(startId, idx);

      const steps: StepInput[] = [];
      let cur = startId;
      for (;;) {
        const node = byId(cur);
        if (node.type === "step") {
          steps.push(toStepInput(node.data as unknown as StepFields));
          const outs = edges.filter((e) => e.source === cur);
          if (outs.length === 0) {
            processes[idx] = { name, steps };
            return idx;
          }
          if (outs.length > 1) throw new Error("У шага не может быть больше одной исходящей связи");
          cur = outs[0]!.target;
          continue;
        }
        const conditions = (node.data as { conditions: string[] }).conditions.map((c) => c.trim());
        if (conditions.some((c) => !c)) throw new Error("У ветвления есть пустое условие");
        const branches = conditions.map((condition, i) => {
          const edge = edges.find((e) => e.source === cur && e.sourceHandle === String(i));
          if (!edge) throw new Error(`Условие «${condition}» не соединено с началом ветки`);
          const target = compileFrom(edge.target, `Ветка: ${condition}`);
          return { condition, target };
        });
        processes[idx] = { name, steps, router: { branches } };
        return idx;
      }
    }

    const entryName = (byId(entries[0]!.id).data as { goal?: string }).goal?.trim() || "Основной сценарий";
    compileFrom(entries[0]!.id, entryName);
    return processes;
  }

  async function handleGenerate() {
    setError(null);
    let processes: ProcessInput[];
    try {
      processes = compile();
    } catch (err) {
      return setError(err instanceof Error ? err.message : "Ошибка структуры");
    }
    if (processes.some((p) => p.steps.some((s) => !s.goal))) return setError("У каждого шага должна быть цель");

    const graph = { nodes, edges };
    setLoading(true);
    try {
      const res = scenario
        ? await regenerateScenario(scenario.id, companyName, processes, graph, style, undefined, forceRegenerate, goals, nonGoals)
        : await generateScenario(botId, companyName, processes, graph, style, undefined, goals, nonGoals);
      setDone({ processCount: res.processes.length, reusedSteps: "reused_steps" in res ? (res as { reused_steps?: number }).reused_steps : undefined });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка генерации");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-white z-50 flex flex-col">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-slate-200">
        <span className="text-lg font-bold text-slate-900">
          {scenario ? "✏️ Редактор сценария" : "✨ Конструктор"}
        </span>
        <span className="text-sm text-slate-500">
          {companyName ? `Компания: ${companyName}` : "у бота не задана компания"}
        </span>
        <button
          onClick={addBranch}
          className="border border-amber-300 text-amber-700 rounded-lg px-3 py-1.5 text-sm hover:bg-amber-50"
        >
          + Ветвление
        </button>
        <button
          onClick={() => setShowStyle(true)}
          className="border border-slate-300 text-slate-700 rounded-lg px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          🎨 Стиль
        </button>
        <button
          onClick={() => setShowPositiveGoals(true)}
          className="border border-slate-300 text-slate-700 rounded-lg px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          🎯 Цели {goals.length > 0 ? `(${goals.length})` : ""}
        </button>
        <button
          onClick={() => setShowGoals(true)}
          className="border border-slate-300 text-slate-700 rounded-lg px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          🚫 Вне задач {nonGoals.length > 0 ? `(${nonGoals.length})` : ""}
        </button>
        <div className="ml-auto flex items-center gap-3">
          {error && <span className="text-red-600 text-sm max-w-md">{error}</span>}
          {scenario && (
            <label
              className="flex items-center gap-1.5 text-xs text-slate-500"
              title="Игнорировать кеш и заново сгенерировать ВСЕ шаги через LLM (например, после обновления самого конструктора)"
            >
              <input
                type="checkbox"
                checked={forceRegenerate}
                onChange={(e) => setForceRegenerate(e.target.checked)}
              />
              Принудительно (без кеша)
            </label>
          )}
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-1.5 text-sm"
          >
            {loading ? "Сохраняем…" : scenario ? "Пересобрать" : "Сгенерировать"}
          </button>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">
            ×
          </button>
        </div>
      </div>

      <div className="px-6 py-1.5 bg-slate-50 border-b border-slate-100 text-xs text-slate-400">
        Потяни линию из точки снизу кубика на пустое место — там появится новый шаг. Соедини так все шаги. Кубик без
        исходящей связи станет завершающим. Клик по кубику — свойства справа.
      </div>

      <div className="flex-1 flex">
        <div className="flex-1">
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onReconnect={onReconnect}
            onReconnectStart={onReconnectStart}
            onReconnectEnd={onReconnectEnd}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        {selectedNode && (
          <NodePanel
            data={selectedNode.data as unknown as StepFields}
            onChange={(patch) => updateNode(selectedNode.id, patch)}
            onDelete={() => deleteNode(selectedNode.id)}
          />
        )}
      </div>

      {showStyle && (
        <StylePanel style={style} onChange={setStyle} onClose={() => setShowStyle(false)} />
      )}

      {showGoals && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50"
          onClick={() => setShowGoals(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-bold text-slate-900">🚫 Чего бот НЕ делает</h2>
              <button onClick={() => setShowGoals(false)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">
                ×
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              Запросы, с которыми бот НЕ помогает — например «отменить заказ», «узнать статус доставки». Если клиент
              попросит такое, бот честно скажет, что не умеет, и предложит продолжить оформление или остановиться.
            </p>

            <div>
              <div className="flex flex-col gap-2">
                {nonGoals.map((g, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={g}
                      onChange={(e) =>
                        setNonGoals((gs) => gs.map((x, gi) => (gi === i ? e.target.value : x)))
                      }
                      placeholder="Например: отменить заказ"
                      className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <button
                      onClick={() => setNonGoals((gs) => gs.filter((_, gi) => gi !== i))}
                      className="text-slate-400 hover:text-red-600 text-lg leading-none px-1"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setNonGoals((gs) => [...gs, ""])}
                  className="text-sm text-red-600 hover:text-red-700 text-left mt-1"
                >
                  + добавить
                </button>
              </div>
            </div>

            <button
              onClick={() => setShowGoals(false)}
              className="mt-6 w-full bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg px-4 py-2.5"
            >
              Готово
            </button>
          </div>
        </div>
      )}

      {showPositiveGoals && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50"
          onClick={() => setShowPositiveGoals(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-bold text-slate-900">🎯 С чем помогает бот</h2>
              <button onClick={() => setShowPositiveGoals(false)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">
                ×
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              Цели, ради которых бот существует — например «оформить заказ». Когда клиент просит что-то постороннее,
              бот предложит именно эти цели, а не выдуманные темы. Оставь только то, с чем он реально помогает.
            </p>

            <div className="flex flex-col gap-2">
              {goals.map((g, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={g}
                    onChange={(e) => setGoals((gs) => gs.map((x, gi) => (gi === i ? e.target.value : x)))}
                    placeholder="Например: оформить заказ"
                    className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm"
                  />
                  <button
                    onClick={() => setGoals((gs) => gs.filter((_, gi) => gi !== i))}
                    className="text-slate-400 hover:text-red-600 text-lg leading-none px-1"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                onClick={() => setGoals((gs) => [...gs, ""])}
                className="text-sm text-red-600 hover:text-red-700 text-left mt-1"
              >
                + добавить
              </button>
            </div>

            <button
              onClick={() => setShowPositiveGoals(false)}
              className="mt-6 w-full bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg px-4 py-2.5"
            >
              Готово
            </button>
          </div>
        </div>
      )}

      {done !== null && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-10">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm text-center">
            <p className="text-emerald-600 font-medium mb-1">Готово! Создано процессов: {done.processCount}</p>
            {!!done.reusedSteps && (
              <p className="text-slate-500 text-sm mb-4">
                Переиспользовано без пересборки: {done.reusedSteps} шаг{done.reusedSteps === 1 ? "" : "ов"}
              </p>
            )}
            {!done.reusedSteps && <div className="mb-4" />}
            <button
              onClick={onGenerated}
              className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg px-4 py-2.5"
            >
              Готово
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NodePanel({
  data,
  onChange,
  onDelete,
}: {
  data: StepFields;
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const field = "w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-red-500 mt-1";

  const RULE_TYPE_LABELS: Record<StepRuleType, string> = {
    example: "Пример",
    validation: "Валидация",
    style: "Стиль",
  };
  // Тип правила защищён от случайной смены: меняется только после двойного клика по нему.
  const [unlockedRuleType, setUnlockedRuleType] = useState<number | null>(null);

  function updateRule(i: number, patch: Partial<StepRule>) {
    onChange({ rules: data.rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
  }

  function addRule() {
    setUnlockedRuleType(data.rules.length); // новое правило создаётся уже разблокированным — блок включается только после первого выбора типа
    onChange({ rules: [...data.rules, { type: "style", text: "" }] });
  }

  function removeRule(i: number) {
    onChange({ rules: data.rules.filter((_, idx) => idx !== i) });
  }

  return (
    <div className="w-80 border-l border-slate-200 bg-slate-50 p-5 overflow-y-auto flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-slate-900">Свойства шага</h3>
        <button onClick={onDelete} className="text-sm text-slate-400 hover:text-red-600">
          Удалить
        </button>
      </div>

      <label className="text-sm font-medium text-slate-700">
        Цель шага
        <textarea
          value={data.goal}
          onChange={(e) => onChange({ goal: e.target.value })}
          rows={2}
          placeholder="напр. поздороваться и узнать имя"
          className={field}
        />
      </label>

      <div className="flex items-center gap-4 text-sm text-slate-700">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={data.required} onChange={(e) => onChange({ required: e.target.checked })} />
          Обязательный
        </label>
        <label className="flex items-center gap-1.5">
          Попыток:
          <input
            type="number"
            min={1}
            value={data.maxAttempts}
            onChange={(e) => onChange({ maxAttempts: Number(e.target.value) })}
            className="w-14 border border-slate-300 rounded px-2 py-1"
          />
        </label>
      </div>

      <label className="flex items-center gap-1.5 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={data.acceptsImage ?? false}
          onChange={(e) => onChange({ acceptsImage: e.target.checked })}
        />
        📷 Принимает фото как источник информации
      </label>

      <div className="border-t border-slate-200 pt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-slate-400 uppercase">Правила</div>
          <button onClick={addRule} className="text-xs text-red-600 hover:text-red-700 font-medium">
            + Добавить правило
          </button>
        </div>

        {data.rules.length === 0 && (
          <p className="text-xs text-slate-400">
            Нет правил — модель сама решит тон, примеры и обработку отказа. Добавь правило, если нужно что-то
            конкретное: пример данных, формат валидации или любую другую инструкцию.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {data.rules.map((rule, i) => (
            <div key={i} className="border border-slate-200 rounded-lg p-2 bg-white">
              <div className="flex items-center gap-2 mb-1.5">
                {/* Тип защищён от случайного перетаскивания/смены: разблокируется двойным кликом. */}
                <div
                  onDoubleClick={() => setUnlockedRuleType(i)}
                  title={unlockedRuleType === i ? "Выбери тип" : "Двойной клик, чтобы сменить тип"}
                  className="relative"
                >
                  <select
                    value={rule.type}
                    disabled={unlockedRuleType !== i}
                    onChange={(e) => {
                      updateRule(i, { type: e.target.value as StepRuleType });
                      setUnlockedRuleType(null);
                    }}
                    className={
                      "text-xs border rounded px-1.5 py-1 " +
                      (unlockedRuleType === i
                        ? "border-red-400"
                        : "border-slate-300 bg-slate-50 text-slate-500 pointer-events-none")
                    }
                  >
                    {(Object.keys(RULE_TYPE_LABELS) as StepRuleType[]).map((t) => (
                      <option key={t} value={t}>
                        {RULE_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>
                {unlockedRuleType !== i && <span className="text-[10px] text-slate-300">🔒 2× клик</span>}
                <button onClick={() => removeRule(i)} className="ml-auto text-slate-300 hover:text-red-500 text-xs">
                  ×
                </button>
              </div>
              <textarea
                value={rule.text}
                onChange={(e) => {
                  updateRule(i, { text: e.target.value });
                  if (unlockedRuleType === i) setUnlockedRuleType(null); // тип фиксируется, как только начали писать текст правила
                }}
                rows={2}
                placeholder={
                  rule.type === "example"
                    ? "напр. БМВ — пример марки, Х6 — пример модели"
                    : rule.type === "validation"
                      ? "напр. номер телефона должен быть из 10-13 цифр"
                      : "напр. в первом сообщении упоминай, что ты помощник Papl.by; пиши коротко и мягко"
                }
                className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 outline-none focus:border-red-400 resize-y"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
