import { useEffect, useState } from "react";
import { listProcesses, listTasks, updateTaskDescription, type Scenario, type Process, type Task } from "./api";

interface ProcessWithTasks {
  process: Process;
  tasks: Task[];
}

export function ScenarioPromptsView({ scenario, onClose }: { scenario: Scenario; onClose: () => void }) {
  const [groups, setGroups] = useState<ProcessWithTasks[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const allProcesses = await listProcesses(scenario.bot_id);
        const relevant = allProcesses.filter((p) => scenario.process_ids.includes(p.id));
        const withTasks = await Promise.all(
          relevant.map(async (process) => ({ process, tasks: await listTasks(process.id) }))
        );
        withTasks.sort((a, b) => a.process.process_number - b.process.process_number);
        setGroups(withTasks);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Ошибка загрузки");
      } finally {
        setLoading(false);
      }
    })();
  }, [scenario.id]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 py-8 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 w-full max-w-3xl my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-900">📄 {scenario.name} — промпты</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">
            ×
          </button>
        </div>

        {loading && <p className="text-slate-400">Загрузка…</p>}
        {error && <p className="text-red-600">{error}</p>}

        <div className="flex flex-col gap-6 max-h-[75vh] overflow-y-auto">
          {groups.map(({ process, tasks }) => (
            <div key={process.id}>
              <div className="text-sm font-semibold text-slate-700 mb-2">
                Процесс №{process.process_number} — {process.name}
              </div>
              <div className="flex flex-col gap-3">
                {tasks.map((t) => (
                  <TaskPromptEditor key={t.id} task={t} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TaskPromptEditor({ task }: { task: Task }) {
  const [value, setValue] = useState(task.task_description);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value !== task.task_description;

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateTaskDescription(task.id, value);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-slate-200 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-mono text-slate-400">{task.task_number}</span>
        <span className="text-xs bg-slate-100 text-slate-500 rounded-full px-2 py-0.5">{task.task_type}</span>
        <div className="ml-auto flex items-center gap-2">
          {saved && <span className="text-xs text-emerald-600">Сохранено ✓</span>}
          {error && <span className="text-xs text-red-600">{error}</span>}
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="text-xs bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white font-medium rounded-lg px-3 py-1"
          >
            {saving ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={8}
        className="w-full text-xs text-slate-700 font-mono border border-slate-200 rounded-lg p-3 outline-none focus:border-red-400 resize-y"
      />
    </div>
  );
}
