import { create } from 'zustand';
import { parseUiMode, serializeUiMode, type UiMode } from '@/lib/uiMode';

/** 界面模式（简单 / 完整），存在本机，刷新后保持 */
const STORAGE_KEY = 'p3d:ui:v1';

interface UiState {
  mode: UiMode;
  setMode: (mode: UiMode) => void;
  toggleMode: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  mode: loadMode(),
  setMode: (mode) => {
    set({ mode });
    persist(mode);
  },
  toggleMode: () => get().setMode(get().mode === 'simple' ? 'pro' : 'simple'),
}));

function loadMode(): UiMode {
  if (typeof localStorage === 'undefined') return 'simple';
  try {
    return parseUiMode(localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'simple';
  }
}

function persist(mode: UiMode) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, serializeUiMode(mode));
  } catch {
    /* 忽略配额错误：模式偏好不是关键数据 */
  }
}
