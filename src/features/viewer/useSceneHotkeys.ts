import { useEffect } from 'react';
import { useSceneStore } from '@/store/useSceneStore';
import { useUiStore } from '@/store/useUiStore';

/**
 * 画布快捷键。
 *
 * 只收三个最常用的：Delete 删、Esc 取消选中、G/R/S 切变换模式（Blender 习惯）。
 * 输入框、文本域里一律不拦截 —— 否则用户在搜索框里按 S 会莫名其妙切模式。
 */
export function useSceneHotkeys() {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return;
      }

      const state = useSceneStore.getState();
      const selected = state.selectedId;

      if (event.key === 'Escape') {
        state.selectObject(null);
        state.setMode('orbit');
        return;
      }

      // 简单模式下场景里只有一个模型，删掉/拖动都没有意义，快捷键一并停用
      if (useUiStore.getState().mode === 'simple') return;

      if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
        event.preventDefault();
        state.removeObject(selected);
        return;
      }

      if (!selected) return;
      const key = event.key.toLowerCase();
      if (key === 'g') state.setMode('translate');
      if (key === 'r') state.setMode('rotate');
      if (key === 's') state.setMode('scale');
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
