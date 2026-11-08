import { TransformControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import type { RefObject } from 'react';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type {
  OrbitControls as OrbitControlsImpl,
  TransformControls as TransformControlsImpl,
} from 'three-stdlib';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ModelObject, ModelObjectFallback } from '@/features/viewer/ModelObject';
import { SceneRig } from '@/features/viewer/SceneRig';
import { classifyDevice, detectDeviceSignals, renderProfileFor } from '@/lib/deviceTier';
import { computeFitDistance } from '@/lib/fitCamera';
import { readTransform } from '@/lib/sceneLayout';
import type { SceneObject, ViewDir } from '@/store/useSceneStore';
import { useSceneStore } from '@/store/useSceneStore';
import { useUiStore } from '@/store/useUiStore';

/** 预设视角方向（世界坐标，Y 轴向上） */
const VIEW_DIRS: Record<ViewDir, [number, number, number]> = {
  front: [0, 0.18, 1],
  back: [0, 0.18, -1],
  left: [-1, 0.18, 0],
  right: [1, 0.18, 0],
  top: [0.001, 1, 0.001],
  iso: [1, 0.75, 1],
};

type Ratio = [number, number, number];

interface SceneCanvasProps {
  onMeasured: (assetKey: string, ratio: Ratio, faceCount: number) => void;
  onError?: (message: string) => void;
}

export function SceneCanvas({ onMeasured, onError }: SceneCanvasProps) {
  const profile = useMemo(() => renderProfileFor(classifyDevice(detectDeviceSignals())), []);
  const objects = useSceneStore((state) => state.objects);
  const selectedId = useSceneStore((state) => state.selectedId);
  const showWireframe = useSceneStore((state) => state.showWireframe);
  const showGrid = useSceneStore((state) => state.showGrid);
  const envPreset = useSceneStore((state) => state.envPreset);
  const autoRotate = useSceneStore((state) => state.autoRotate);
  const selectObject = useSceneStore((state) => state.selectObject);
  const mode = useSceneStore((state) => state.mode);
  const setTransform = useSceneStore((state) => state.setTransform);
  // 简单模式下场景里永远只有一个模型，也不给拖 —— 选中态直接视为空
  const simple = useUiStore((state) => state.mode === 'simple');
  const activeId = simple ? null : selectedId;
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const gizmoRef = useRef<TransformControlsImpl | null>(null);

  // 归一化后的相对比例：模型加载完才知道，所以只能在这里攒起来给取景用
  const [ratios, setRatios] = useState<Record<string, Ratio>>({});

  // TransformControls 要挂到具体的 Object3D 上，所以这里维护 id → group 的注册表
  const [handles, setHandles] = useState<Record<string, THREE.Object3D>>({});

  const registerHandle = useCallback((id: string, handle: THREE.Object3D | null) => {
    setHandles((prev) => {
      if (!handle) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      if (prev[id] === handle) return prev;
      return { ...prev, [id]: handle };
    });
  }, []);

  /** 拖拽结束才写回 store：拖拽过程中每帧写会让 localStorage 被打爆 */
  const commitTransform = useCallback(
    (id: string, handle: THREE.Object3D) => {
      setTransform(id, readTransform(handle));
    },
    [setTransform],
  );

  const handleMeasured = useCallback(
    (assetKey: string, ratio: Ratio, faceCount: number) => {
      setRatios((prev) => {
        const current = prev[assetKey];
        if (
          current &&
          current[0] === ratio[0] &&
          current[1] === ratio[1] &&
          current[2] === ratio[2]
        ) {
          return prev;
        }
        return { ...prev, [assetKey]: ratio };
      });
      onMeasured(assetKey, ratio, faceCount);
    },
    [onMeasured],
  );

  const handleBackgroundClick = useCallback(() => selectObject(null), [selectObject]);
  const selectedObject = activeId ? handles[activeId] : undefined;

  return (
    <Canvas
      shadows={profile.shadows ? 'soft' : false}
      dpr={profile.dpr}
      gl={{ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }}
      camera={{ fov: 40, position: [2.4, 1.8, 2.4], near: 0.05, far: 100 }}
      onPointerMissed={handleBackgroundClick}
    >
      <color attach="background" args={['#f4f4f5']} />
      <fog attach="fog" args={['#f4f4f5', 14, 34]} />

      <SceneRig
        profile={profile}
        envPreset={envPreset}
        showGrid={showGrid}
        controlsRef={controlsRef}
      />

      {/*
        fallback 用 3D 占位盒，不用 drei 的 <Html>。
        Html 会把真实 DOM 挂到画布容器上，配合 React 19 的 Suspense 隐藏/恢复
        会出现 removeChild 报"节点不是子节点"的错（画布容器被重建时尤其容易）。
        3D 占位没有这问题，也更像"画布里该有的东西"。
      */}
      {objects.map((object) =>
        object.visible ? (
          <Suspense key={object.id} fallback={<ModelObjectFallback />}>
            <ErrorBoundary
              fallback={<ModelObjectFallback />}
              onError={(error) => onError?.(error.message)}
            >
              <ModelObject
                object={object}
                wireframe={showWireframe}
                selected={activeId === object.id}
                onMeasured={handleMeasured}
                onHandle={registerHandle}
                onSelect={selectObject}
              />
            </ErrorBoundary>
          </Suspense>
        ) : null,
      )}

      {selectedObject && !simple && mode !== 'orbit' ? (
        <TransformControls
          key={activeId ?? 'none'}
          ref={(instance) => {
            gizmoRef.current = instance as unknown as TransformControlsImpl | null;
          }}
          object={selectedObject}
          mode={mode}
          size={1.05}
          translationSnap={null}
          rotationSnap={null}
          scaleSnap={null}
          onMouseUp={() => {
            const id = activeId;
            if (id) commitTransform(id, selectedObject);
          }}
        />
      ) : null}

      <AutoFrame objects={objects} ratios={ratios} />
      <CameraPilot controlsRef={controlsRef} autoRotate={autoRotate} />
      <ScreenshotBridge />
      <DebugBridge gizmoRef={gizmoRef} />
    </Canvas>
  );
}

/**
 * 自动取景。
 *
 * 所有模型都已归一化成"最长边 1、底面贴地"，于是只要知道每个对象的相对比例
 * 和摆放位置，就能算出一个确定的取景距离 —— 比依赖异步组件挂载时机的
 * 自动 fit 更可靠（那个方案会在模型还没加载完时就量了个空盒子）。
 */
function AutoFrame({ objects, ratios }: { objects: SceneObject[]; ratios: Record<string, Ratio> }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const controls = useThree((state) => state.controls) as unknown as OrbitControlsImpl | null;
  const frameState = useRef({ count: -1, measured: -1 });

  // 依赖就是 objects 与 ratios 本身：两者都只在"真的变了"时才换引用
  // （ratios 有相等性短路，objects 只在增删移动时重建数组）
  useEffect(() => {
    if (!controls || objects.length === 0) {
      frameState.current = { count: -1, measured: -1 };
      return;
    }

    // 只在"对象数量"或"已量到比例的数量"变化时取景。
    // 否则用户拖动/缩放一个模型，相机会跟着跳 —— 那是很糟糕的体验。
    const measured = objects.filter((item) => ratios[item.assetKey]).length;
    if (frameState.current.count === objects.length && frameState.current.measured === measured) {
      return;
    }
    frameState.current = { count: objects.length, measured };

    const box = new THREE.Box3();
    let counted = 0;
    for (const object of objects) {
      const ratio = ratios[object.assetKey];
      if (!ratio) continue;
      box.expandByPoint(
        new THREE.Vector3(
          object.position[0] - ratio[0] / 2,
          object.position[1],
          object.position[2] - ratio[2] / 2,
        ),
      );
      box.expandByPoint(
        new THREE.Vector3(
          object.position[0] + ratio[0] / 2,
          object.position[1] + ratio[1],
          object.position[2] + ratio[2] / 2,
        ),
      );
      counted += 1;
    }
    if (counted === 0) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const distance = computeFitDistance(
      { x: size.x, y: size.y, z: size.z },
      camera.fov,
      camera.aspect,
      1.7,
    );

    // 保持当前朝向，只改距离和目标点，避免取景把用户刚转好的视角一起重置
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(1, 0.75, 1);
    direction.normalize().multiplyScalar(distance);

    camera.position.copy(center).add(direction);
    camera.near = Math.max(0.01, distance / 100);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
  }, [objects, ratios, camera, controls]);

  return null;
}

/**
 * 视角预设与截图都需要接触相机/控制器，只能活在 Canvas 内部。
 * 用 store 里的 nonce 作为触发信号，避免把 three 对象往 React 树外面传。
 */
function CameraPilot({
  controlsRef,
  autoRotate,
}: {
  controlsRef: RefObject<OrbitControlsImpl | null>;
  autoRotate: boolean;
}) {
  const camera = useThree((state) => state.camera);
  const viewDir = useSceneStore((state) => state.viewDir);
  const nonce = useSceneStore((state) => state.viewNonce);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls || nonce === 0) return;

    const target = controls.target.clone();
    const distance = Math.max(1.2, camera.position.distanceTo(target));
    const direction = new THREE.Vector3(...VIEW_DIRS[viewDir]).normalize().multiplyScalar(distance);
    const destination = target.clone().add(direction);

    // 手动补间，省一个动画库依赖；350ms 大约是人眼觉得"顺"的下限
    const from = camera.position.clone();
    const start = performance.now();
    const duration = 350;

    const step = () => {
      const t = Math.min(1, (performance.now() - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      camera.position.lerpVectors(from, destination, eased);
      camera.lookAt(target);
      controls.update();
      if (t < 1) {
        frameRef.current = requestAnimationFrame(step);
      }
    };
    step();

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [nonce, viewDir, camera, controlsRef]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 1.2;
  }, [autoRotate, controlsRef]);

  return null;
}

/**
 * 只在 URL 带 ?debug=1 时挂上调试接口。
 *
 * 起因：gizmo 的拖拽没法靠"盲点坐标"自动化验证 —— 点偏了会变成旋转相机，
 * 而且相机动了之后 gizmo 的位置也变了，搜索会自我失效。
 * 暴露 axis 状态后，自动化可以先 hover 确认命中了轴，再按下拖动。
 * 生产环境 URL 不带 debug 时，这里什么都不做。
 */
function DebugBridge({ gizmoRef }: { gizmoRef: RefObject<TransformControlsImpl | null> }) {
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('debug')) return;
    // three-stdlib 把 axis / dragging 声明成 private，但它们正是拖拽状态的真实来源，
    // 这里用结构化类型读，不碰 any
    const readState = () =>
      gizmoRef.current as unknown as { axis?: string | null; dragging?: boolean } | null;

    const target = window as unknown as { __p3d?: Record<string, unknown> };
    target.__p3d = {
      /** 当前 hover 命中的轴（X/Y/Z/XY/…），null 表示没命中 */
      getAxis: () => readState()?.axis ?? null,
      isDragging: () => readState()?.dragging ?? false,
    };
    return () => {
      target.__p3d = undefined;
    };
  }, [gizmoRef]);

  return null;
}

function ScreenshotBridge() {
  const nonce = useSceneStore((state) => state.screenshotNonce);
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    if (nonce === 0) return;
    const url = gl.domElement.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = url;
    link.download = `p3d-scene-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    link.click();
  }, [nonce, gl]);

  return null;
}
