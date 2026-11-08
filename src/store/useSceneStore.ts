import { create } from 'zustand';
import { clampScale, findFreeSlotX, normalizeRotation, roundPosition } from '@/lib/sceneLayout';

/**
 * 场景容器。
 *
 * 方案 §7.5 要求「先做容器，再做拖拽」：M1 先把 objects 做成数组，
 * M4 才接 TransformControls，所以数据结构一行没改。
 */

export type TransformMode = 'orbit' | 'translate' | 'rotate' | 'scale';

export interface SceneObject {
  id: string;
  /** GLB 地址，blob: 或 https: */
  assetKey: string;
  label: string;
  position: [number, number, number];
  rotation: [number, number, number];
  /** 统一标量，保持等比 —— 非等比缩放会破坏生成模型的观感 */
  scale: number;
  visible: boolean;
}

export type EnvPreset = 'studio' | 'sunset' | 'dawn' | 'none';

export type ViewDir = 'front' | 'back' | 'left' | 'right' | 'top' | 'iso';

export interface TransformPatch {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
}

interface SceneState {
  objects: SceneObject[];
  selectedId: string | null;
  mode: TransformMode;
  showGrid: boolean;
  showWireframe: boolean;
  envPreset: EnvPreset;
  autoRotate: boolean;
  /** 视角预设请求：DOM 侧下指令，画布内执行，靠 nonce 区分重复点击同一按钮 */
  viewDir: ViewDir;
  viewNonce: number;
  screenshotNonce: number;

  addObject: (input: { assetKey: string; label: string }) => string;
  removeObject: (id: string) => void;
  duplicateObject: (id: string) => void;
  selectObject: (id: string | null) => void;
  setMode: (mode: TransformMode) => void;
  setTransform: (id: string, patch: TransformPatch) => void;
  moveObject: (id: string, position: [number, number, number]) => void;
  toggleVisible: (id: string) => void;
  toggleGrid: () => void;
  toggleWireframe: () => void;
  toggleAutoRotate: () => void;
  setEnvPreset: (preset: EnvPreset) => void;
  requestView: (dir: ViewDir) => void;
  requestScreenshot: () => void;
  clearScene: () => void;
}

const STORAGE_KEY = 'p3d:scene:v1';

const persisted = loadScene();

let seq = 0;

function newObjectId(): string {
  return `obj_${Date.now().toString(36)}_${seq++}`;
}

export const useSceneStore = create<SceneState>((set, get) => ({
  objects: persisted.objects,
  selectedId: null,
  mode: 'translate',
  showGrid: true,
  showWireframe: false,
  envPreset: 'studio',
  autoRotate: false,
  viewDir: 'iso',
  viewNonce: 0,
  screenshotNonce: 0,

  addObject: ({ assetKey, label }) => {
    const objects = get().objects;
    const object: SceneObject = {
      id: newObjectId(),
      assetKey,
      label,
      position: [findFreeSlotX(objects.map((item) => item.position[0])), 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
      visible: true,
    };
    set({ objects: [...objects, object], selectedId: object.id });
    persist(get());
    return object.id;
  },

  removeObject: (id) => {
    set((state) => {
      const objects = state.objects.filter((item) => item.id !== id);
      return {
        objects,
        selectedId: state.selectedId === id ? (objects[0]?.id ?? null) : state.selectedId,
      };
    });
    persist(get());
  },

  /** 复制一份放在旁边的空位 —— 摆场景时"再放一个同样的"太常见了 */
  duplicateObject: (id) => {
    const source = get().objects.find((item) => item.id === id);
    if (!source) return;
    const objects = get().objects;
    const copy: SceneObject = {
      ...source,
      id: newObjectId(),
      position: [findFreeSlotX(objects.map((item) => item.position[0])), source.position[1], 0],
    };
    set({ objects: [...objects, copy], selectedId: copy.id });
    persist(get());
  },

  selectObject: (id) => set({ selectedId: id }),

  setMode: (mode) => set({ mode }),

  setTransform: (id, patch) => {
    set((state) => ({
      objects: state.objects.map((item) => {
        if (item.id !== id) return item;
        return {
          ...item,
          position: patch.position ? roundPosition(patch.position) : item.position,
          rotation: patch.rotation ? normalizeRotation(patch.rotation) : item.rotation,
          // 缩放统一成等比标量，避免拖出个"压扁的模型"还存进本地
          scale: patch.scale === undefined ? item.scale : clampScale(patch.scale),
        };
      }),
    }));
    persist(get());
  },

  moveObject: (id, position) => {
    set((state) => ({
      objects: state.objects.map((item) =>
        item.id === id ? { ...item, position: roundPosition(position) } : item,
      ),
    }));
    persist(get());
  },

  toggleVisible: (id) => {
    set((state) => ({
      objects: state.objects.map((item) =>
        item.id === id ? { ...item, visible: !item.visible } : item,
      ),
    }));
    persist(get());
  },

  toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),
  toggleWireframe: () => set((state) => ({ showWireframe: !state.showWireframe })),
  toggleAutoRotate: () => set((state) => ({ autoRotate: !state.autoRotate })),
  setEnvPreset: (envPreset) => set({ envPreset }),
  requestView: (viewDir) => set((state) => ({ viewDir, viewNonce: state.viewNonce + 1 })),
  requestScreenshot: () => set((state) => ({ screenshotNonce: state.screenshotNonce + 1 })),
  clearScene: () => {
    set({ objects: [], selectedId: null });
    persist(get());
  },
}));

function persist(state: SceneState) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        objects: state.objects.map((object) => ({
          ...object,
          // blob: URL 刷新后失效，只保留 http(s) 与打包内路径
          assetKey: object.assetKey.startsWith('blob:') ? '' : object.assetKey,
        })),
      }),
    );
  } catch {
    /* 忽略配额错误 */
  }
}

function loadScene(): { objects: SceneObject[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { objects: [] };
    const parsed = JSON.parse(raw) as { objects?: SceneObject[] };
    const objects = (parsed.objects ?? [])
      .filter((object) => object?.assetKey)
      .map((object) => ({
        ...object,
        position: roundPosition(object.position ?? [0, 0, 0]) as [number, number, number],
        rotation: (object.rotation ?? [0, 0, 0]) as [number, number, number],
        scale: typeof object.scale === 'number' ? object.scale : 1,
        visible: object.visible !== false,
      }));
    return { objects };
  } catch {
    return { objects: [] };
  }
}
