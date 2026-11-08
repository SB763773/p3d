import type { ViewDir } from '@/store/useSceneStore';
import { useSceneStore } from '@/store/useSceneStore';
import { useUiStore } from '@/store/useUiStore';

const VIEW_BUTTONS: { dir: ViewDir; label: string }[] = [
  { dir: 'front', label: '前' },
  { dir: 'back', label: '后' },
  { dir: 'left', label: '左' },
  { dir: 'right', label: '右' },
  { dir: 'top', label: '顶' },
  { dir: 'iso', label: '等轴' },
];

const TRANSFORM_BUTTONS = [
  { mode: 'translate', label: '移动' },
  { mode: 'rotate', label: '旋转' },
  { mode: 'scale', label: '缩放' },
] as const;

export function ViewerToolbar() {
  const requestView = useSceneStore((state) => state.requestView);
  const mode = useSceneStore((state) => state.mode);
  const setMode = useSceneStore((state) => state.setMode);
  const selectedId = useSceneStore((state) => state.selectedId);
  const viewDir = useSceneStore((state) => state.viewDir);
  const showGrid = useSceneStore((state) => state.showGrid);
  const showWireframe = useSceneStore((state) => state.showWireframe);
  const autoRotate = useSceneStore((state) => state.autoRotate);
  const toggleGrid = useSceneStore((state) => state.toggleGrid);
  const toggleWireframe = useSceneStore((state) => state.toggleWireframe);
  const toggleAutoRotate = useSceneStore((state) => state.toggleAutoRotate);
  const requestScreenshot = useSceneStore((state) => state.requestScreenshot);
  // 简单模式：只留"看"的操作（视角、自转、截图），拖动/网格/线框收起
  const simple = useUiStore((state) => state.mode === 'simple');

  return (
    <div className="pointer-events-auto absolute top-3 right-3 flex flex-col items-end gap-2">
      <div className="card flex items-center gap-0.5 p-1">
        {VIEW_BUTTONS.map((button) => (
          <button
            key={button.dir}
            type="button"
            onClick={() => requestView(button.dir)}
            className={[
              'rounded-md px-2 py-1 text-xs transition-colors',
              viewDir === button.dir ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100',
            ].join(' ')}
            title={`切到${button.label}视角`}
          >
            {button.label}
          </button>
        ))}
      </div>

      {!simple && selectedId ? (
        <div className="card flex items-center gap-0.5 p-1">
          <span className="px-1 text-[10px] text-zinc-400">变换</span>
          {TRANSFORM_BUTTONS.map((button) => (
            <ToolbarToggle
              key={button.mode}
              active={mode === button.mode}
              // 再点一次同一个模式 → 收起 gizmo，回到纯观察
              onClick={() => setMode(mode === button.mode ? 'orbit' : button.mode)}
              label={button.label}
            />
          ))}
        </div>
      ) : null}

      <div className="card flex items-center gap-0.5 p-1">
        {simple ? null : (
          <>
            <ToolbarToggle active={showGrid} onClick={toggleGrid} label="网格" />
            <ToolbarToggle active={showWireframe} onClick={toggleWireframe} label="线框" />
          </>
        )}
        <ToolbarToggle active={autoRotate} onClick={toggleAutoRotate} label="自转" />
        <button
          type="button"
          onClick={requestScreenshot}
          className="rounded-md px-2 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-100"
          title="把当前视角存成 PNG"
        >
          截图
        </button>
      </div>
    </div>
  );
}

function ToolbarToggle({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'rounded-md px-2 py-1 text-xs transition-colors',
        active ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
