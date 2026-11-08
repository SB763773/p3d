import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error) => void;
}

interface State {
  error: Error | null;
}

/** GLB 加载失败必须接住，否则整个画布白屏 —— 用户只会以为"这工具坏了" */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            模型加载失败：{this.state.error.message}
          </div>
        )
      );
    }
    return this.props.children;
  }
}
