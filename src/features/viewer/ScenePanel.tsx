import { useSceneStore } from '@/store/useSceneStore';

/**
 * 场景对象列表。
 *
 * 3D 里点选虽然直观，但一旦模型被挡住或缩得很小就不好点了；
 * 列表是稳定的兜底入口，也顺便承载"隐藏 / 复制 / 删除"这些不适合放在 gizmo 上的操作。
 */
export function ScenePanel() {
  const objects = useSceneStore((state) => state.objects);
  const selectedId = useSceneStore((state) => state.selectedId);
  const selectObject = useSceneStore((state) => state.selectObject);
  const removeObject = useSceneStore((state) => state.removeObject);
  const duplicateObject = useSceneStore((state) => state.duplicateObject);
  const toggleVisible = useSceneStore((state) => state.toggleVisible);
  const clearScene = useSceneStore((state) => state.clearScene);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="label-xs">4 · 场景对象</p>
        {objects.length > 0 ? (
          <button
            type="button"
            onClick={clearScene}
            className="text-[11px] text-zinc-400 underline-offset-2 hover:text-red-600 hover:underline"
          >
            清空
          </button>
        ) : null}
      </div>

      {objects.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-5 text-center text-xs text-zinc-400">
          场景里还没有模型。生成一个，或从历史记录里点一条加进来。
        </p>
      ) : (
        <>
          <ul className="space-y-1">
            {objects.map((object, index) => {
              const active = object.id === selectedId;
              return (
                <li key={object.id}>
                  <div
                    className={[
                      'group flex items-center gap-1.5 rounded-lg border px-2 py-1.5 transition-colors',
                      active
                        ? 'border-zinc-300 bg-white'
                        : 'border-transparent hover:border-zinc-200 hover:bg-white',
                    ].join(' ')}
                  >
                    <button
                      type="button"
                      onClick={() => selectObject(object.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span
                        className={[
                          'grid h-6 w-6 shrink-0 place-items-center rounded text-[10px] font-mono',
                          active ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-500',
                        ].join(' ')}
                      >
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={[
                            'block truncate text-xs',
                            object.visible ? 'text-zinc-700' : 'text-zinc-400 line-through',
                          ].join(' ')}
                        >
                          {object.label}
                        </span>
                        <span className="block font-mono text-[10px] text-zinc-400">
                          x {object.position[0].toFixed(1)} · y {object.position[1].toFixed(1)} · z{' '}
                          {object.position[2].toFixed(1)} · ×{object.scale.toFixed(2)}
                        </span>
                      </span>
                    </button>

                    <button
                      type="button"
                      aria-label={object.visible ? '隐藏' : '显示'}
                      title={object.visible ? '隐藏' : '显示'}
                      onClick={() => toggleVisible(object.id)}
                      className="rounded px-1 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                    >
                      {object.visible ? '◉' : '○'}
                    </button>
                    <button
                      type="button"
                      aria-label="复制一个"
                      title="复制一个放到旁边"
                      onClick={() => duplicateObject(object.id)}
                      className="rounded px-1 py-0.5 text-[11px] text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-zinc-700 group-hover:opacity-100 focus:opacity-100"
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      aria-label="从场景移除"
                      title="从场景移除（不影响历史记录）"
                      onClick={() => removeObject(object.id)}
                      className="rounded px-1 py-0.5 text-[11px] text-zinc-400 opacity-0 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-[11px] text-zinc-400">
            点模型或点这一行选中，然后用画布右上角的「移动 / 旋转 / 缩放」拖它。
          </p>
        </>
      )}
    </div>
  );
}
